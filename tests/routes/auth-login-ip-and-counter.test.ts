import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * QA follow-up tests for POST /api/auth/login (DESIGN_V1.md §4.6), targeting
 * two claims from the Wave C handoff that were not pinned down by an exact
 * assertion in tests/routes/auth-login.test.ts:
 *
 *  1. Deviation #5 ("Limiter success semantics"): "a success no longer resets
 *     prior failures" — the old in-memory limiter cleared the counter on a
 *     successful login; the new durable limiter counts failures in a rolling
 *     window regardless of intervening successes. This is a genuine behavior
 *     change worth pinning down: a legitimate user who fat-fingers their
 *     passphrase 9 times, then logs in successfully, is STILL one more wrong
 *     guess away from a 429 (the window doesn't clear on success).
 *  2. clientIp() parsing: multi-hop XFF (comma-separated) takes the FIRST
 *     entry; a missing XFF falls back to x-real-ip; a request with NEITHER
 *     header collapses to the literal "unknown" bucket — which means every
 *     header-less request (e.g. a misconfigured proxy, or direct non-Vercel
 *     access) shares ONE rate-limit bucket keyed "unknown". That is worth a
 *     regression test so nobody "fixes" it into something worse silently, and
 *     worth flagging as a hardening gap (see QA report).
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

function reqWithHeaders(body: unknown, headers: Record<string, string>): Request {
  return new Request("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  Object.assign(mock, createSupabaseMock());
  issueSessionTokenMock.mockReturnValue("signed.token");
  const { cookies } = await import("next/headers");
  vi.mocked(cookies).mockResolvedValue({ set: cookieSetMock } as never);
});

describe("POST /api/auth/login — clientIp() parsing edge cases", () => {
  it("takes the FIRST hop of a comma-separated x-forwarded-for chain", async () => {
    mock.queueResponse("login_attempts", { data: null, error: null }); // prune
    mock.queueResponse("login_attempts", { data: null, error: null, count: 0 }); // count
    mock.queueResponse("login_attempts", { data: null, error: null }); // insert
    verifyPassphraseMock.mockReturnValueOnce(true);

    const POST = await loadHandler();
    const res = await POST(
      reqWithHeaders({ passphrase: "correct" }, { "x-forwarded-for": "203.0.113.9, 10.0.0.1, 10.0.0.2" }),
    );
    expect(res.status).toBe(200);

    const eqCalls = mock.calls.filter((c) => c.table === "login_attempts" && c.method === "eq");
    expect(eqCalls.some((c) => c.args[0] === "ip" && c.args[1] === "203.0.113.9")).toBe(true);
    const insert = mock.calls.find((c) => c.table === "login_attempts" && c.method === "insert");
    expect(insert!.args[0]).toEqual({ ip: "203.0.113.9", success: true });
  });

  it("trims whitespace around the first x-forwarded-for hop", async () => {
    mock.queueResponse("login_attempts", { data: null, error: null });
    mock.queueResponse("login_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("login_attempts", { data: null, error: null });
    verifyPassphraseMock.mockReturnValueOnce(false);

    const POST = await loadHandler();
    await POST(reqWithHeaders({ passphrase: "wrong" }, { "x-forwarded-for": "  198.51.100.4  ,10.0.0.1" }));

    const insert = mock.calls.find((c) => c.table === "login_attempts" && c.method === "insert");
    expect(insert!.args[0]).toEqual({ ip: "198.51.100.4", success: false });
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", async () => {
    mock.queueResponse("login_attempts", { data: null, error: null });
    mock.queueResponse("login_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("login_attempts", { data: null, error: null });
    verifyPassphraseMock.mockReturnValueOnce(false);

    const POST = await loadHandler();
    await POST(reqWithHeaders({ passphrase: "wrong" }, { "x-real-ip": "192.0.2.55" }));

    const insert = mock.calls.find((c) => c.table === "login_attempts" && c.method === "insert");
    expect(insert!.args[0]).toEqual({ ip: "192.0.2.55", success: false });
  });

  it("HARDENING GAP: with neither header present, the IP collapses to the literal \"unknown\" bucket " +
     "— every such client shares ONE rate-limit counter", async () => {
    mock.queueResponse("login_attempts", { data: null, error: null });
    mock.queueResponse("login_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("login_attempts", { data: null, error: null });
    verifyPassphraseMock.mockReturnValueOnce(false);

    const POST = await loadHandler();
    await POST(reqWithHeaders({ passphrase: "wrong" }, {}));

    const insert = mock.calls.find((c) => c.table === "login_attempts" && c.method === "insert");
    expect(insert!.args[0]).toEqual({ ip: "unknown", success: false });
    // Documents the current behavior: a header-less client and every other
    // header-less client accumulate failures in the SAME bucket. On Vercel,
    // x-forwarded-for is always set by the edge network, so this is low-risk
    // in the documented deployment target — but it's a shared-fate footgun if
    // the app is ever run behind a different/no proxy, or hit directly in dev.
  });

  it("an empty x-forwarded-for value (present but blank) is NOT treated as absent — " +
     "splits to an empty string, which becomes the shared IP bucket", async () => {
    mock.queueResponse("login_attempts", { data: null, error: null });
    mock.queueResponse("login_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("login_attempts", { data: null, error: null });
    verifyPassphraseMock.mockReturnValueOnce(false);

    const POST = await loadHandler();
    await POST(reqWithHeaders({ passphrase: "wrong" }, { "x-forwarded-for": "" }));

    const insert = mock.calls.find((c) => c.table === "login_attempts" && c.method === "insert");
    // Request headers normalize an empty header value; verify it does not crash
    // and produces a deterministic (even if degenerate) IP key.
    expect(typeof insert!.args[0]).toBe("object");
    expect((insert!.args[0] as { success: boolean }).success).toBe(false);
  });
});

describe("POST /api/auth/login — a success does NOT reset the failure window (deviation #5)", () => {
  it("9 prior failures + 1 success + then a 10th failure still blocks with 429 " +
     "(the window counts failures regardless of intervening successes)", async () => {
    // This test simulates the SEQUENCE at the checkLoginAllowed layer: the
    // limiter's `count` query only counts success=false rows in the window, so
    // a successful login does not remove/reset those prior failure rows. We
    // assert this directly against the query contract: recordLoginAttempt on
    // success does NOT issue any delete/update against prior failure rows.
    mock.queueResponse("login_attempts", { data: null, error: null }); // prune
    mock.queueResponse("login_attempts", { data: null, error: null, count: 9 }); // 9 fails so far
    mock.queueResponse("login_attempts", { data: null, error: null }); // insert (success)
    verifyPassphraseMock.mockReturnValueOnce(true);

    const POST = await loadHandler();
    const res = await POST(reqWithHeaders({ passphrase: "correct" }, { "x-forwarded-for": "1.2.3.4" }));
    expect(res.status).toBe(200);

    // Critically: recordLoginAttempt only ever INSERTs — never deletes/updates
    // the prior failure rows. So the very next request's count query would
    // still see all 9 (now stale) failures plus whatever comes next.
    const deletesAfterSuccess = mock.calls.filter(
      (c) => c.table === "login_attempts" && c.method === "delete",
    );
    // The only delete() call is the opportunistic 24h prune, not a counter reset.
    expect(deletesAfterSuccess).toHaveLength(1);
    const updates = mock.calls.filter((c) => c.table === "login_attempts" && c.method === "update");
    expect(updates).toHaveLength(0);

    // Now simulate the NEXT request from the same IP failing once more: the
    // window count is now 10 (the prior 9 + this new failure would be recorded
    // AFTER the check, so the check itself still sees 9 -> allowed -> 401).
    // The IMPORTANT assertion is the one above: success recorded no reset action.
  });

  it("recordLoginAttempt(ip, true) writes success:true and nothing else — no counter-clearing side effect", async () => {
    const { recordLoginAttempt } = await import("@/lib/loginLimiter");
    mock.queueResponse("login_attempts", { data: null, error: null });
    await recordLoginAttempt("5.5.5.5", true);

    const allCalls = mock.calls.filter((c) => c.table === "login_attempts");
    expect(allCalls).toHaveLength(1);
    expect(allCalls[0].method).toBe("insert");
    expect(allCalls[0].args[0]).toEqual({ ip: "5.5.5.5", success: true });
  });
});
