import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Route-handler tests for POST /api/game/topup (DESIGN.md §3.5). Focus: the
 * dual-gate auth (session AND x-talasin-admin header) and body validation.
 * lib/gemini/client and lib/game are mocked — no live Gemini call.
 */

const {
  requireSessionMock,
  generateFallacyRoundsMock,
  insertGeneratedRoundsMock,
  recentScenarioSummariesMock,
} = vi.hoisted(() => ({
  requireSessionMock: vi.fn().mockResolvedValue(undefined),
  generateFallacyRoundsMock: vi.fn(),
  insertGeneratedRoundsMock: vi.fn(),
  recentScenarioSummariesMock: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/session", () => ({
  requireSession: requireSessionMock,
  UnauthorizedError: class UnauthorizedError extends Error {},
  // The route now uses lib/session's safeEqual for the constant-time admin-token
  // compare (a hashed timing-safe equality). A plain strict-equality stand-in is
  // behaviorally equivalent for these tests (equal ⇒ true, otherwise false).
  safeEqual: (a: string, b: string) => a === b,
}));
vi.mock("@/lib/gemini/client", () => ({
  generateFallacyRounds: generateFallacyRoundsMock,
}));
vi.mock("@/lib/game", () => ({
  insertGeneratedRounds: insertGeneratedRoundsMock,
  recentScenarioSummaries: recentScenarioSummariesMock,
}));

async function loadHandler() {
  const mod = await import("@/app/api/game/topup/route");
  return mod.POST;
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/game/topup", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  requireSessionMock.mockResolvedValue(undefined);
  recentScenarioSummariesMock.mockResolvedValue([]);
  process.env.TALASIN_ADMIN_TOKEN = "the-admin-token";
});

describe("POST /api/game/topup — auth gates", () => {
  it("401 when unauthenticated (no session)", async () => {
    const { UnauthorizedError } = await import("@/lib/session");
    requireSessionMock.mockRejectedValueOnce(new UnauthorizedError());
    const POST = await loadHandler();
    const res = await POST(req({}, { "x-talasin-admin": "the-admin-token" }));
    expect(res.status).toBe(401);
  });

  it("403 when session is valid but x-talasin-admin header is missing", async () => {
    const POST = await loadHandler();
    const res = await POST(req({}));
    expect(res.status).toBe(403);
  });

  it("403 when x-talasin-admin header is wrong", async () => {
    const POST = await loadHandler();
    const res = await POST(req({}, { "x-talasin-admin": "wrong-token" }));
    expect(res.status).toBe(403);
  });

  it("403 when TALASIN_ADMIN_TOKEN is not configured server-side at all", async () => {
    delete process.env.TALASIN_ADMIN_TOKEN;
    const POST = await loadHandler();
    const res = await POST(req({}, { "x-talasin-admin": "anything" }));
    expect(res.status).toBe(403);
  });

  it("passes both gates and proceeds to generation with a valid session + correct admin token", async () => {
    generateFallacyRoundsMock.mockResolvedValueOnce({ rounds: [], needsReviewSummaries: new Set() });
    insertGeneratedRoundsMock.mockResolvedValueOnce({ generated: 0, inserted: 0, skipped_duplicates: 0 });
    const POST = await loadHandler();
    const res = await POST(req({}, { "x-talasin-admin": "the-admin-token" }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/game/topup — body validation", () => {
  const auth = { "x-talasin-admin": "the-admin-token" };

  it("defaults count to 20 when body is empty", async () => {
    generateFallacyRoundsMock.mockResolvedValueOnce({ rounds: [], needsReviewSummaries: new Set() });
    insertGeneratedRoundsMock.mockResolvedValueOnce({ generated: 0, inserted: 0, skipped_duplicates: 0 });
    const POST = await loadHandler();
    await POST(req({}, auth));
    expect(generateFallacyRoundsMock).toHaveBeenCalledWith(20, expect.any(Object));
  });

  it("400 when count exceeds the max of 50", async () => {
    const POST = await loadHandler();
    const res = await POST(req({ count: 51 }, auth));
    expect(res.status).toBe(400);
  });

  it("400 when count is 0 (below min of 1)", async () => {
    const POST = await loadHandler();
    const res = await POST(req({ count: 0 }, auth));
    expect(res.status).toBe(400);
  });

  it("400 when difficulty is out of the 1-3 range", async () => {
    const POST = await loadHandler();
    const res = await POST(req({ difficulty: 4 }, auth));
    expect(res.status).toBe(400);
  });

  it("400 when fallacy_keys contains a key outside the taxonomy", async () => {
    const POST = await loadHandler();
    const res = await POST(req({ fallacy_keys: ["not_a_real_fallacy"] }, auth));
    expect(res.status).toBe(400);
  });

  it("handles an empty request body (no JSON at all) without crashing", async () => {
    generateFallacyRoundsMock.mockResolvedValueOnce({ rounds: [], needsReviewSummaries: new Set() });
    insertGeneratedRoundsMock.mockResolvedValueOnce({ generated: 0, inserted: 0, skipped_duplicates: 0 });
    const POST = await loadHandler();
    const emptyBodyReq = new Request("http://localhost/api/game/topup", {
      method: "POST",
      headers: auth,
    });
    const res = await POST(emptyBodyReq);
    expect(res.status).toBe(200);
  });

  it("400 on malformed JSON body", async () => {
    const POST = await loadHandler();
    const bad = new Request("http://localhost/api/game/topup", {
      method: "POST",
      headers: auth,
      body: "{not json",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/game/topup — Gemini error mapping + partial success", () => {
  const auth = { "x-talasin-admin": "the-admin-token" };

  it("429 when generateFallacyRounds throws rate_limited", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    generateFallacyRoundsMock.mockRejectedValueOnce(new GeminiError("rate_limited", "quota"));
    const POST = await loadHandler();
    const res = await POST(req({}, auth));
    expect(res.status).toBe(429);
  });

  it("502 when generateFallacyRounds throws invalid_output", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    generateFallacyRoundsMock.mockRejectedValueOnce(new GeminiError("invalid_output", "bad json"));
    const POST = await loadHandler();
    const res = await POST(req({}, auth));
    expect(res.status).toBe(502);
  });

  it("500 when GEMINI_API_KEY is not configured (no_api_key)", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    generateFallacyRoundsMock.mockRejectedValueOnce(new GeminiError("no_api_key", "no key"));
    const POST = await loadHandler();
    const res = await POST(req({}, auth));
    expect(res.status).toBe(500);
  });

  it("returns partial-success counts (inserted < generated) without failing the request", async () => {
    generateFallacyRoundsMock.mockResolvedValueOnce({
      rounds: [{}, {}, {}],
      needsReviewSummaries: new Set(),
    });
    insertGeneratedRoundsMock.mockResolvedValueOnce({
      generated: 3,
      inserted: 1,
      skipped_duplicates: 2,
    });
    const POST = await loadHandler();
    const res = await POST(req({}, auth));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ generated: 3, inserted: 1, skipped_duplicates: 2 });
  });
});
