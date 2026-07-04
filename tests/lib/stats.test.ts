import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * Dashboard aggregation tests (lib/stats.ts, DESIGN.md §3.7; v1 extension per
 * DESIGN_V1.md §4.8). Supabase and lib/streak.ts's DB-backed getStreaks() are
 * mocked so this is pure-logic: grouping, rounding, and shaping of
 * already-fetched rows.
 *
 * getStats() query order (per table queue):
 *   game_attempts:      fallacy full read → nback recent → syllogism recent →
 *                       weekly window → xp read
 *   interview_attempts: trend window → head count → weekly window → xp read
 *   achievements:       unlock list
 *   daily_activity:     today's goal row (maybeSingle)
 * The mock's sticky-last-response semantics let old tests queue one response
 * per table; v1-specific tests queue every position explicitly.
 */

const mock = createSupabaseMock();

vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));

vi.mock("@/lib/streak", () => ({
  getStreaks: vi.fn().mockResolvedValue({ streak: 5, bestStreak: 9 }),
}));

/** Default tail every getStats() call needs: achievements + daily_activity. */
function queueTail() {
  mock.queueResponse("achievements", { data: [], error: null });
  mock.queueResponse("daily_activity", { data: null, error: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  Object.assign(mock, createSupabaseMock());
});

describe("getStats — game aggregation", () => {
  it("returns all-zero shape gracefully when there is no data at all (first-ever run)", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    queueTail();

    const stats = await getStats();
    expect(stats.game.total).toBe(0);
    expect(stats.game.correct).toBe(0);
    expect(stats.game.accuracy).toBe(0); // no divide-by-zero -> NaN
    expect(stats.game.trend).toEqual([]);
    expect(stats.game.by_fallacy).toEqual([]);
    expect(stats.interview.total).toBe(0);
    expect(stats.interview.trend).toEqual([]);
    expect(stats.streak).toBe(5);
    expect(stats.best_streak).toBe(9);
    // v1 additive shape defaults (fresh install)
    expect(stats.games.nback).toEqual({ total: 0, current_n: 2, trend: [] });
    expect(stats.games.syllogism).toEqual({ total: 0, trend: [] });
    expect(stats.xp).toEqual({ total: 0, level: 1, into_level: 0, for_next: 100 });
    expect(stats.weekly.this).toEqual({
      activities: 0,
      avg_delivery: null,
      avg_filler_per_min: null,
      game_accuracy: null,
    });
    expect(stats.achievements).toEqual([]);
    expect(stats.daily_goal).toEqual({ game_done: false, interview_done: false });
  });

  it("scopes the game_attempts read to fallacy rows (multi-game, DESIGN_V1 §4.8)", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    queueTail();

    await getStats();

    // n-back/syllogism attempts must not pollute "Game accuracy" / "by fallacy".
    const eqCalls = mock.calls.filter(
      (c) => c.table === "game_attempts" && c.method === "eq",
    );
    expect(
      eqCalls.some((c) => c.args[0] === "game_type" && c.args[1] === "fallacy"),
    ).toBe(true);
  });

  it("computes accuracy correctly and rounds to 2 decimals", async () => {
    const { getStats } = await import("@/lib/stats");
    const rows = [
      { is_correct: true, fallacy_key: "strawman", local_day: "2026-07-01", created_at: "2026-07-01T01:00:00Z" },
      { is_correct: true, fallacy_key: "strawman", local_day: "2026-07-01", created_at: "2026-07-01T00:59:00Z" },
      { is_correct: false, fallacy_key: "ad_hominem", local_day: "2026-07-01", created_at: "2026-07-01T00:58:00Z" },
    ];
    mock.queueResponse("game_attempts", { data: rows, error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    queueTail();

    const stats = await getStats();
    expect(stats.game.total).toBe(3);
    expect(stats.game.correct).toBe(2);
    // 2/3 = 0.6666... rounds to 0.67
    expect(stats.game.accuracy).toBe(0.67);
  });

  it("groups by_fallacy accuracy across ALL attempts (not just the trend window)", async () => {
    const { getStats } = await import("@/lib/stats");
    const rows = [
      { is_correct: true, fallacy_key: "strawman", local_day: "2026-07-01", created_at: "t1" },
      { is_correct: false, fallacy_key: "strawman", local_day: "2026-07-01", created_at: "t2" },
      { is_correct: true, fallacy_key: "bandwagon", local_day: "2026-07-01", created_at: "t3" },
    ];
    mock.queueResponse("game_attempts", { data: rows, error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    queueTail();

    const stats = await getStats();
    const strawman = stats.game.by_fallacy.find((f) => f.fallacy_key === "strawman");
    const bandwagon = stats.game.by_fallacy.find((f) => f.fallacy_key === "bandwagon");
    expect(strawman).toEqual({ fallacy_key: "strawman", accuracy: 0.5, count: 2 });
    expect(bandwagon).toEqual({ fallacy_key: "bandwagon", accuracy: 1, count: 1 });
  });

  it("caps the trend window at the most recent 30 attempts (TREND_ATTEMPTS)", async () => {
    const { getStats } = await import("@/lib/stats");
    // 35 attempts across two days, ordered most-recent-first as the real query does.
    const rows = Array.from({ length: 35 }, (_, i) => ({
      is_correct: true,
      fallacy_key: "strawman",
      local_day: i < 5 ? "2026-06-30" : "2026-07-01", // first 5 (oldest, index 30-34) on 06-30
      created_at: `2026-07-01T${String(23 - i).padStart(2, "0")}:00:00Z`,
    }));
    mock.queueResponse("game_attempts", { data: rows, error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    queueTail();

    const stats = await getStats();
    const totalTrendCount = stats.game.trend.reduce((sum, p) => sum + p.count, 0);
    expect(totalTrendCount).toBe(30); // only first 30 rows (most recent) considered
    expect(stats.game.total).toBe(35); // but the all-time total still reflects all rows
  });

  it("sorts the trend chronologically ascending (oldest to newest) for charting", async () => {
    const { getStats } = await import("@/lib/stats");
    const rows = [
      { is_correct: true, fallacy_key: "strawman", local_day: "2026-07-02", created_at: "t3" },
      { is_correct: true, fallacy_key: "strawman", local_day: "2026-06-30", created_at: "t1" },
      { is_correct: true, fallacy_key: "strawman", local_day: "2026-07-01", created_at: "t2" },
    ];
    mock.queueResponse("game_attempts", { data: rows, error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    queueTail();

    const stats = await getStats();
    expect(stats.game.trend.map((p) => p.local_day)).toEqual([
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
    ]);
  });
});

describe("getStats — interview aggregation", () => {
  it("computes filler-rate-per-minute average per day from stored filler_count + duration", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null });
    const ivRows = [
      {
        filler_count: 6,
        words_per_minute: 140,
        clarity_score: 80,
        overall_delivery_score: 75,
        duration_sec: 120, // 6 fillers / 2 min = 3.0/min
        local_day: "2026-07-01",
        created_at: "t1",
      },
      {
        filler_count: 3,
        words_per_minute: 160,
        clarity_score: 90,
        overall_delivery_score: 85,
        duration_sec: 60, // 3 fillers / 1 min = 3.0/min
        local_day: "2026-07-01",
        created_at: "t2",
      },
    ];
    mock.queueResponse("interview_attempts", { data: ivRows, error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 2 });
    queueTail();

    const stats = await getStats();
    const point = stats.interview.trend.find((p) => p.local_day === "2026-07-01");
    expect(point?.avg_filler_rate).toBe(3);
    expect(point?.avg_wpm).toBe(150); // (140+160)/2
    expect(point?.avg_clarity).toBe(85); // (80+90)/2
    expect(point?.avg_delivery).toBe(80); // (75+85)/2
  });

  it("skips filler-rate contribution from rows with zero/null duration_sec (guards div-by-zero)", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null });
    const ivRows = [
      {
        filler_count: 5,
        words_per_minute: 140,
        clarity_score: 80,
        overall_delivery_score: 75,
        duration_sec: 0, // guarded — must not divide by zero
        local_day: "2026-07-01",
        created_at: "t1",
      },
    ];
    mock.queueResponse("interview_attempts", { data: ivRows, error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 1 });
    queueTail();

    const stats = await getStats();
    const point = stats.interview.trend.find((p) => p.local_day === "2026-07-01");
    expect(point?.avg_filler_rate).toBe(0);
    expect(Number.isFinite(point?.avg_filler_rate)).toBe(true);
  });

  it("null clarity_score/wpm/delivery values are excluded from their respective averages", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null });
    const ivRows = [
      {
        filler_count: 2,
        words_per_minute: null,
        clarity_score: null,
        overall_delivery_score: null,
        duration_sec: 60,
        local_day: "2026-07-01",
        created_at: "t1",
      },
    ];
    mock.queueResponse("interview_attempts", { data: ivRows, error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 1 });
    queueTail();

    const stats = await getStats();
    const point = stats.interview.trend.find((p) => p.local_day === "2026-07-01");
    expect(point?.avg_wpm).toBe(0);
    expect(point?.avg_clarity).toBe(0);
    expect(point?.avg_delivery).toBe(0);
    expect(point?.avg_filler_rate).toBe(2); // 2 fillers / 1 min
  });

  it("interview total count is independent of the 30-row trend window (uses a head-count query)", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null }); // trend window empty/irrelevant here
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 500 });
    queueTail();

    const stats = await getStats();
    expect(stats.interview.total).toBe(500);
  });
});

describe("getStats — v1 extension (DESIGN_V1 §4.8)", () => {
  it("shapes the nback trend (avg score + max N per day) and derives current_n from the progression rule", async () => {
    const { getStats } = await import("@/lib/stats");
    // game_attempts queue in code order: fallacy, nback, syllogism, weekly, xp.
    mock.queueResponse("game_attempts", { data: [], error: null }); // fallacy
    mock.queueResponse("game_attempts", {
      data: [
        // most recent first, as the real query orders
        { score: 85, detail: { n: 3 }, local_day: "2026-07-02", created_at: "t2" },
        { score: 40, detail: { n: 2 }, local_day: "2026-07-01", created_at: "t1" },
      ],
      error: null,
      count: 14,
    });
    mock.queueResponse("game_attempts", { data: [], error: null, count: 0 }); // syllogism
    mock.queueResponse("game_attempts", { data: [], error: null }); // weekly
    mock.queueResponse("game_attempts", { data: [], error: null }); // xp
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("interview_attempts", { data: [], error: null }); // weekly
    mock.queueResponse("interview_attempts", { data: [], error: null }); // xp
    queueTail();

    const stats = await getStats();
    expect(stats.games.nback.total).toBe(14);
    // last session: N=3 at 85 → ≥80 promotes → next session N=4
    expect(stats.games.nback.current_n).toBe(4);
    expect(stats.games.nback.trend).toEqual([
      { local_day: "2026-07-01", avg_score: 40, max_n: 2, count: 1 },
      { local_day: "2026-07-02", avg_score: 85, max_n: 3, count: 1 },
    ]);
  });

  it("shapes the syllogism trend as per-day accuracy with the all-time count", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null }); // fallacy
    mock.queueResponse("game_attempts", { data: [], error: null, count: 0 }); // nback
    mock.queueResponse("game_attempts", {
      data: [
        { is_correct: true, local_day: "2026-07-02", created_at: "t3" },
        { is_correct: false, local_day: "2026-07-02", created_at: "t2" },
        { is_correct: true, local_day: "2026-07-01", created_at: "t1" },
      ],
      error: null,
      count: 120,
    });
    mock.queueResponse("game_attempts", { data: [], error: null }); // weekly
    mock.queueResponse("game_attempts", { data: [], error: null }); // xp
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    queueTail();

    const stats = await getStats();
    expect(stats.games.syllogism.total).toBe(120);
    expect(stats.games.syllogism.trend).toEqual([
      { local_day: "2026-07-01", accuracy: 1, count: 1 },
      { local_day: "2026-07-02", accuracy: 0.5, count: 2 },
    ]);
  });

  it("sums XP across both attempt tables and derives the level curve", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("game_attempts", { data: [], error: null, count: 0 });
    mock.queueResponse("game_attempts", { data: [], error: null, count: 0 });
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("game_attempts", { data: [{ xp: 100 }, { xp: 200 }], error: null }); // xp
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: [{ xp: 100 }], error: null }); // xp
    queueTail();

    const stats = await getStats();
    // 400 XP → level 3 (threshold 400), 0 into it, 500 to level 4 (threshold 900).
    expect(stats.xp).toEqual({ total: 400, level: 3, into_level: 0, for_next: 500 });
  });

  it("partitions the weekly comparison into rolling this-7-days vs prior-7-days windows", async () => {
    const { getStats } = await import("@/lib/stats");
    const { todayLocal, addDays } = await import("@/lib/day");
    const today = todayLocal();
    const inThis = today; // inside days 0..6
    const inLast = addDays(today, -10); // inside days 7..13
    const tooOld = addDays(today, -20); // outside both — must be ignored

    mock.queueResponse("game_attempts", { data: [], error: null }); // fallacy
    mock.queueResponse("game_attempts", { data: [], error: null, count: 0 }); // nback
    mock.queueResponse("game_attempts", { data: [], error: null, count: 0 }); // syllogism
    mock.queueResponse("game_attempts", {
      data: [
        { is_correct: true, local_day: inThis },
        { is_correct: false, local_day: inThis },
        { is_correct: null, local_day: inThis }, // n-back: activities only
        { is_correct: true, local_day: inLast },
        { is_correct: true, local_day: tooOld },
      ],
      error: null,
    });
    mock.queueResponse("game_attempts", { data: [], error: null }); // xp
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("interview_attempts", {
      data: [
        { overall_delivery_score: 80, filler_count: 4, duration_sec: 120, local_day: inThis },
        { overall_delivery_score: 70, filler_count: 6, duration_sec: 60, local_day: inLast },
      ],
      error: null,
    });
    mock.queueResponse("interview_attempts", { data: [], error: null }); // xp
    queueTail();

    const stats = await getStats();
    expect(stats.weekly.this).toEqual({
      activities: 4, // 3 game rows + 1 interview row
      avg_delivery: 80,
      avg_filler_per_min: 2, // 4 fillers / 2 min
      game_accuracy: 0.5, // 1 of 2 binary-scored rows
    });
    expect(stats.weekly.last).toEqual({
      activities: 2,
      avg_delivery: 70,
      avg_filler_per_min: 6,
      game_accuracy: 1,
    });
  });

  it("maps unlocked achievements to catalog names (unknown keys fall back to the key)", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("achievements", {
      data: [
        { key: "streak_7", unlocked_at: "2026-07-01T00:00:00Z" },
        { key: "retired_key", unlocked_at: "2026-07-02T00:00:00Z" },
      ],
      error: null,
    });
    mock.queueResponse("daily_activity", { data: null, error: null });

    const stats = await getStats();
    expect(stats.achievements).toEqual([
      { key: "streak_7", name: "One week sharp", unlocked_at: "2026-07-01T00:00:00Z" },
      { key: "retired_key", name: "retired_key", unlocked_at: "2026-07-02T00:00:00Z" },
    ]);
  });

  it("daily_goal reflects today's daily_activity row (one activity per pillar)", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: null, error: null, count: 0 });
    mock.queueResponse("achievements", { data: [], error: null });
    mock.queueResponse("daily_activity", {
      data: { game_count: 3, interview_count: 0 },
      error: null,
    });

    const stats = await getStats();
    expect(stats.daily_goal).toEqual({ game_done: true, interview_done: false });
  });
});

describe("getStats — error propagation", () => {
  it("propagates a game_attempts read error", async () => {
    const { getStats } = await import("@/lib/stats");
    mock.queueResponse("game_attempts", { data: null, error: { message: "timeout" } });

    await expect(getStats()).rejects.toThrow(/game_attempts read failed/);
  });
});
