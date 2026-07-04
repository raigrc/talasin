import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * Route-handler tests for POST /api/auth/login (DESIGN.md §3.1, §4, §8;
 * DESIGN_V1.md §4.6). lib/session is mocked at the verify/issue level;
 * next/headers cookies() is mocked with a minimal jar. The rate limiter is
 * the REAL lib/loginLimiter.ts running against the mocked login_attempts
 * table — same HTTP contract as the old in-memory limiter (400/401/429/500 +
 * cookie on 200), now durable and fail-open.
 *
 * Limiter query order per request: prune delete → window fail-count → (after
 * verify) attempt insert. Each consumes one queued login_attempts response.
 */

const { verifyPassphraseMock, issueSessionTokenMock, cookieSetMock } = vi.hoisted(() => ({
  verifyPassphraseMock: vi.fn(),
  issueSessionTokenMock: vi.fn().mockReturnValue("signed.token"),
  cookieSetMock: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  verifyPassphrase: verifyPassphraseMock,
  issueSessionToken: issueSessionTokenMock,
  sessionCookieOptions: () => ({ httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 100 }),
  SESSION_COOKIE: "talasin_session",
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({ set: cookieSetMock }),
}));

const mock = createSupabaseMock();

vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));

async function loadHandler() {
  const mod = await import("@/app/api/auth/login/route");
  return mod.POST;
}

function req(body: unknown, ip = "1.2.3.4"): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

/** Queue the limiter's three login_attempts responses: prune, count, insert. */
function queueLimiter(failCount: number) {
  mock.queueResponse("login_attempts", { data: null, error: null }); // prune delete
  mock.queueResponse("login_attempts", { data: null, error: null, count: failCount });
  mock.queueResponse("login_attempts", { data: null, error: null }); // attempt insert
}

beforeEach(async () => {
  vi.resetAllMocks();
  Object.assign(mock, createSupabaseMock());
  issueSessionTokenMock.mockReturnValue("signed.token");
  const { cookies } = await import("next/headers");
  vi.mocked(cookies).mockResolvedValue({ set: cookieSetMock } as never);
});

describe("POST /api/auth/login", () => {
  it("200 + sets cookie on correct passphrase, and records a success row", async () => {
    queueLimiter(0);
    verifyPassphraseMock.mockReturnValueOnce(true);
    const POST = await loadHandler();
    const res = await POST(req({ passphrase: "correct" }, "10.0.0.1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(cookieSetMock).toHaveBeenCalledWith(
      "talasin_session",
      "signed.token",
      expect.objectContaining({ httpOnly: true }),
    );

    const insert = mock.calls.find(
      (c) => c.table === "login_attempts" && c.method === "insert",
    );
    expect(insert!.args[0]).toEqual({ ip: "10.0.0.1", success: true });
  });

  it("401 generic error on wrong passphrase, and records a failure row", async () => {
    queueLimiter(0);
    verifyPassphraseMock.mockReturnValueOnce(false);
    const POST = await loadHandler();
    const res = await POST(req({ passphrase: "wrong" }, "10.0.0.2"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("invalid passphrase");
    expect(cookieSetMock).not.toHaveBeenCalled();

    const insert = mock.calls.find(
      (c) => c.table === "login_attempts" && c.method === "insert",
    );
    expect(insert!.args[0]).toEqual({ ip: "10.0.0.2", success: false });
  });

  it("400 when passphrase field is missing (no attempt row recorded)", async () => {
    queueLimiter(0);
    const POST = await loadHandler();
    const res = await POST(req({}, "10.0.0.3"));
    expect(res.status).toBe(400);
    expect(
      mock.calls.some((c) => c.table === "login_attempts" && c.method === "insert"),
    ).toBe(false);
  });

  it("400 when passphrase is an empty string", async () => {
    queueLimiter(0);
    const POST = await loadHandler();
    const res = await POST(req({ passphrase: "" }, "10.0.0.4"));
    expect(res.status).toBe(400);
  });

  it("400 on malformed JSON body", async () => {
    queueLimiter(0);
    const POST = await loadHandler();
    const bad = new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "x-forwarded-for": "10.0.0.5" },
      body: "{{not json",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });

  it("500 config error when verifyPassphrase throws (missing env var)", async () => {
    queueLimiter(0);
    verifyPassphraseMock.mockImplementationOnce(() => {
      throw new Error("Missing required environment variable: TALASIN_PASSPHRASE_HASH");
    });
    const POST = await loadHandler();
    const res = await POST(req({ passphrase: "anything" }, "10.0.0.6"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe("config");
  });

  it("429 when the 15-min window already holds LOGIN_MAX_FAILS (10) failures — BEFORE scrypt runs", async () => {
    mock.queueResponse("login_attempts", { data: null, error: null }); // prune
    mock.queueResponse("login_attempts", { data: null, error: null, count: 10 });
    const POST = await loadHandler();
    const res = await POST(req({ passphrase: "wrong" }, "10.0.0.7"));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
    // The KDF is shielded: verification never ran, nothing was recorded.
    expect(verifyPassphraseMock).not.toHaveBeenCalled();
    expect(
      mock.calls.some((c) => c.table === "login_attempts" && c.method === "insert"),
    ).toBe(false);
  });

  it("9 failures in the window is still under the limit (401 path, not 429)", async () => {
    queueLimiter(9);
    verifyPassphraseMock.mockReturnValueOnce(false);
    const POST = await loadHandler();
    const res = await POST(req({ passphrase: "wrong" }, "10.0.0.8"));
    expect(res.status).toBe(401);
  });

  it("the window count is scoped to this IP's failures within the window (per-IP keying)", async () => {
    queueLimiter(0);
    verifyPassphraseMock.mockReturnValueOnce(false);
    const POST = await loadHandler();
    await POST(req({ passphrase: "wrong" }, "10.0.0.9"));

    // The count query filters ip + success=false + attempted_at window.
    const eqCalls = mock.calls.filter(
      (c) => c.table === "login_attempts" && c.method === "eq",
    );
    expect(eqCalls.some((c) => c.args[0] === "ip" && c.args[1] === "10.0.0.9")).toBe(true);
    expect(eqCalls.some((c) => c.args[0] === "success" && c.args[1] === false)).toBe(true);
    const gte = mock.calls.find(
      (c) => c.table === "login_attempts" && c.method === "gte",
    );
    expect(gte!.args[0]).toBe("attempted_at");
    // Prune runs before the check (opportunistic 24h cleanup).
    const del = mock.calls.find(
      (c) => c.table === "login_attempts" && c.method === "delete",
    );
    expect(del).toBeTruthy();
    const lt = mock.calls.find((c) => c.table === "login_attempts" && c.method === "lt");
    expect(lt!.args[0]).toBe("attempted_at");
  });

  it("FAIL-OPEN: a Supabase outage on the window count lets the attempt proceed to scrypt", async () => {
    mock.queueResponse("login_attempts", { data: null, error: null }); // prune ok
    mock.queueResponse("login_attempts", {
      data: null,
      error: { message: "supabase unreachable" },
    });
    mock.queueResponse("login_attempts", { data: null, error: null }); // insert
    verifyPassphraseMock.mockReturnValueOnce(true);
    const POST = await loadHandler();
    const res = await POST(req({ passphrase: "correct" }, "10.0.0.10"));
    expect(res.status).toBe(200); // the passphrase remains the real gate
    expect(verifyPassphraseMock).toHaveBeenCalled();
  });

  it("a failed attempt-insert is swallowed (does not mask the 401 contract)", async () => {
    mock.queueResponse("login_attempts", { data: null, error: null }); // prune
    mock.queueResponse("login_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("login_attempts", {
      data: null,
      error: { message: "insert failed" },
    });
    verifyPassphraseMock.mockReturnValueOnce(false);
    const POST = await loadHandler();
    const res = await POST(req({ passphrase: "wrong" }, "10.0.0.11"));
    expect(res.status).toBe(401);
  });
});
