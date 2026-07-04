import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Route-handler tests for GET /api/cron/topup (DEPLOY.md §5). Focus: the
 * CRON_SECRET Bearer gate (fails closed when unset, constant-time compare) and
 * the shared runTopup helper being invoked only after auth passes. lib/topup is
 * mocked so no live Gemini/Supabase call happens.
 */

const { runTopupMock } = vi.hoisted(() => ({
  runTopupMock: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  // The route uses lib/session's safeEqual (a hashed timing-safe compare). A
  // plain strict-equality stand-in is behaviorally equivalent for these tests.
  safeEqual: (a: string, b: string) => a === b,
}));
vi.mock("@/lib/topup", () => ({
  runTopup: runTopupMock,
}));

async function loadHandler() {
  const mod = await import("@/app/api/cron/topup/route");
  return mod.GET;
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/cron/topup", {
    method: "GET",
    headers,
  });
}

const SUMMARY = {
  requested: 20,
  generated: 20,
  inserted: 18,
  skipped_duplicates: 2,
  needs_review: 1,
  batch_id: "batch-xyz",
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.CRON_SECRET = "the-cron-secret";
});

describe("GET /api/cron/topup — auth gate", () => {
  it("401 when the Authorization header is missing entirely", async () => {
    const GET = await loadHandler();
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(runTopupMock).not.toHaveBeenCalled();
  });

  it("401 when the Authorization header is blank", async () => {
    const GET = await loadHandler();
    const res = await GET(req({ authorization: "" }));
    expect(res.status).toBe(401);
    expect(runTopupMock).not.toHaveBeenCalled();
  });

  it("401 when the Bearer token is wrong", async () => {
    const GET = await loadHandler();
    const res = await GET(req({ authorization: "Bearer wrong-secret" }));
    expect(res.status).toBe(401);
    expect(runTopupMock).not.toHaveBeenCalled();
  });

  it("401 when the token value is correct but the Bearer scheme is missing", async () => {
    const GET = await loadHandler();
    const res = await GET(req({ authorization: "the-cron-secret" }));
    expect(res.status).toBe(401);
    expect(runTopupMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/topup — fails closed without CRON_SECRET", () => {
  it("500 and never runs top-up when CRON_SECRET is unset (even with a Bearer header)", async () => {
    delete process.env.CRON_SECRET;
    const GET = await loadHandler();
    const res = await GET(req({ authorization: "Bearer anything" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("cron_not_configured");
    expect(runTopupMock).not.toHaveBeenCalled();
  });

  it("500 and never runs top-up when CRON_SECRET is blank", async () => {
    process.env.CRON_SECRET = "";
    const GET = await loadHandler();
    const res = await GET(req({ authorization: "Bearer " }));
    expect(res.status).toBe(500);
    expect(runTopupMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/topup — authorized", () => {
  const auth = { authorization: "Bearer the-cron-secret" };

  it("200 and calls runTopup with the default count on a valid Bearer token", async () => {
    runTopupMock.mockResolvedValueOnce(SUMMARY);
    const GET = await loadHandler();
    const res = await GET(req(auth));
    expect(res.status).toBe(200);
    expect(runTopupMock).toHaveBeenCalledTimes(1);
    // Cron path uses the helper's default count (no arguments forwarded).
    expect(runTopupMock).toHaveBeenCalledWith();
    const body = await res.json();
    expect(body).toMatchObject(SUMMARY);
  });
});

describe("GET /api/cron/topup — Gemini error mapping", () => {
  const auth = { authorization: "Bearer the-cron-secret" };

  it("429 when runTopup throws rate_limited", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    runTopupMock.mockRejectedValueOnce(new GeminiError("rate_limited", "quota"));
    const GET = await loadHandler();
    const res = await GET(req(auth));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("gemini_rate_limited");
  });

  it("500 when runTopup throws no_api_key (graceful, not a crash)", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    runTopupMock.mockRejectedValueOnce(new GeminiError("no_api_key", "no key"));
    const GET = await loadHandler();
    const res = await GET(req(auth));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("gemini_failed");
  });

  it("502 when runTopup throws invalid_output", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    runTopupMock.mockRejectedValueOnce(new GeminiError("invalid_output", "bad json"));
    const GET = await loadHandler();
    const res = await GET(req(auth));
    expect(res.status).toBe(502);
  });

  it("does not leak the GeminiError detail to the response body", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    runTopupMock.mockRejectedValueOnce(
      new GeminiError("failed", "public message", "SECRET internal detail"),
    );
    const GET = await loadHandler();
    const res = await GET(req(auth));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("SECRET internal detail");
    expect(raw).not.toContain("public message");
  });

  it("500 server_error on a generic (non-Gemini) failure", async () => {
    runTopupMock.mockRejectedValueOnce(new Error("something exploded"));
    const GET = await loadHandler();
    const res = await GET(req(auth));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("server_error");
  });
});
