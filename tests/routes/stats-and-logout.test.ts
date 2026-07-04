import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Thin route-handler tests for GET /api/stats and POST /api/auth/logout —
 * both are effectively pass-throughs (auth gate + delegate), so these confirm
 * the auth gate and error mapping without a live DB.
 */

const { requireSessionMock, getStatsMock } = vi.hoisted(() => ({
  requireSessionMock: vi.fn().mockResolvedValue(undefined),
  getStatsMock: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireSession: requireSessionMock,
  UnauthorizedError: class UnauthorizedError extends Error {},
  SESSION_COOKIE: "talasin_session",
}));
vi.mock("@/lib/stats", () => ({
  getStats: getStatsMock,
}));

const cookieDeleteMock = vi.fn();
vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({ delete: cookieDeleteMock }),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  requireSessionMock.mockResolvedValue(undefined);
  const { cookies } = await import("next/headers");
  vi.mocked(cookies).mockResolvedValue({ delete: cookieDeleteMock } as never);
});

describe("GET /api/stats", () => {
  async function loadHandler() {
    const mod = await import("@/app/api/stats/route");
    return mod.GET;
  }

  it("401 when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/session");
    requireSessionMock.mockRejectedValueOnce(new UnauthorizedError());
    const GET = await loadHandler();
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("200 with the stats payload on success", async () => {
    getStatsMock.mockResolvedValueOnce({
      streak: 5,
      best_streak: 9,
      game: { total: 10, correct: 8, accuracy: 0.8, trend: [], by_fallacy: [] },
      interview: { total: 2, trend: [] },
    });
    const GET = await loadHandler();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.streak).toBe(5);
  });

  it("500 server_error when getStats throws (DB failure)", async () => {
    getStatsMock.mockRejectedValueOnce(new Error("db down"));
    const GET = await loadHandler();
    const res = await GET();
    expect(res.status).toBe(500);
  });
});

describe("POST /api/auth/logout", () => {
  async function loadHandler() {
    const mod = await import("@/app/api/auth/logout/route");
    return mod.POST;
  }

  it("200 and clears the session cookie", async () => {
    const POST = await loadHandler();
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(cookieDeleteMock).toHaveBeenCalledWith("talasin_session");
  });
});
