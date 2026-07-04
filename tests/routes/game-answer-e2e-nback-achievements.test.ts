import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * True end-to-end integration test for POST /api/game/answer (nback path):
 * unlike tests/routes/game.test.ts (which mocks lib/progression entirely) and
 * tests/lib/achievements.test.ts (which calls evaluateAchievements directly
 * with a hand-built ctx), this test runs the REAL registry engine, the REAL
 * afterActivity()/evaluateAchievements() composition, and the REAL streak
 * calculation, with ONLY the Supabase client mocked.
 *
 * Purpose: catch integration drift that unit tests with mocked boundaries
 * cannot — specifically, that app/api/game/answer/route.ts's
 * `attemptFacts: outcome.reveal` actually carries the `n`/`score` field names
 * lib/achievements.ts#nback_3 predicate expects (`ctx.attemptFacts.n`,
 * `ctx.attemptFacts.score`), end to end, through the real reveal object shape
 * built by lib/games/nback/index.ts.
 */

const mock = createSupabaseMock();

vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));

const { requireSessionMock } = vi.hoisted(() => ({ requireSessionMock: vi.fn() }));
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return { ...actual, requireSession: requireSessionMock, UnauthorizedError: actual.UnauthorizedError };
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  Object.assign(mock, createSupabaseMock());
  process.env = { ...ORIGINAL_ENV, TALASIN_SESSION_SECRET: "e2e-secret" };
  requireSessionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("POST /api/game/answer — real engine + real achievements, nback_3 end to end", () => {
  it("a perfect N=3 nback session (score 100) unlocks nback_3 through the FULL real stack", async () => {
    const { signRoundToken } = await import("@/lib/games/token");
    const { generateSequence, groundTruth, seedFromUid } = await import(
      "@/lib/games/nback/engine"
    );

    const uid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const n = 3;
    const token = signRoundToken("nback", { n }, 60, uid);
    const truth = groundTruth(generateSequence(seedFromUid(uid), n), n);

    // --- Supabase call sequence for the real answer() + afterActivity() path ---
    // 1. game_attempts insert (nback attempt row)
    mock.queueResponse("game_attempts", { data: null, error: null });
    // 2. streak: daily_activity read (existing row) then upsert
    mock.queueResponse("daily_activity", { data: null, error: null }); // read: no row yet
    mock.queueResponse("daily_activity", { data: null, error: null }); // upsert ack
    // 3. getStreaks(): daily_activity select for streak computation
    mock.queueResponse("daily_activity", { data: [{ local_day: "2026-07-03" }], error: null });
    // 4. getXpTotal(): game_attempts + interview_attempts xp sums
    mock.queueResponse("game_attempts", { data: [{ xp: 40 }], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    // 5. evaluateAchievements(): unlocked-keys read
    mock.queueResponse("achievements", { data: [], error: null });
    // 6. nback_3 predicate is facts-only (no query) — but rounds_100/streak/level
    //    keys ALSO run; rounds_100 needs a head-count query.
    mock.queueResponse("game_attempts", { data: null, error: null, count: 3 }); // rounds_100
    // 7. achievements upsert (nback_3 unlocks)
    mock.queueResponse("achievements", { data: null, error: null });

    const mod = await import("@/app/api/game/answer/route");
    const res = await mod.POST(
      new Request("http://localhost/api/game/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          game_type: "nback",
          token,
          responses: { position: truth.posMatch, letter: truth.letterMatch },
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score).toBe(100);
    expect(body.n).toBe(3);
    // The achievement fired end-to-end through the REAL predicate reading the
    // REAL reveal object's n/score fields — not a hand-built ctx.
    expect(body.new_achievements).toEqual(
      expect.arrayContaining([{ key: "nback_3", name: "Working memory 3" }]),
    );
    expect(body.xp_total).toBe(40);
  });
});
