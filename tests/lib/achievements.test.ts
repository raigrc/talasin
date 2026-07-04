import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * Achievement unlock logic (lib/achievements.ts, DESIGN_V1.md §5.2): trigger
 * map filtering, facts-only + one-query predicates, already-unlocked skipping,
 * on-conflict-do-nothing persistence, and per-predicate best-effort isolation.
 */

const mock = createSupabaseMock();

vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  Object.assign(mock, createSupabaseMock());
});

/** Base context: nothing passes unless the test opts in. */
function baseCtx(overrides: Record<string, unknown> = {}) {
  return {
    pillar: "game" as const,
    gameType: "nback" as const,
    attemptFacts: {},
    streak: 1,
    level: 1,
    ...overrides,
  };
}

describe("candidateKeys — the static trigger map", () => {
  it("interview activities check the 5 interview keys + streak/level keys only", async () => {
    const { candidateKeys } = await import("@/lib/achievements");
    expect(candidateKeys({ pillar: "interview" })).toEqual([
      "first_interview",
      "filler_under_2",
      "delivery_90",
      "star_complete",
      "all_categories",
      "streak_7",
      "streak_30",
      "level_5",
    ]);
  });

  it("game activities check rounds_100 + the per-game key + streak/level keys", async () => {
    const { candidateKeys } = await import("@/lib/achievements");
    expect(candidateKeys({ pillar: "game", gameType: "fallacy" })).toEqual([
      "rounds_100",
      "fallacy_dozen",
      "streak_7",
      "streak_30",
      "level_5",
    ]);
    expect(candidateKeys({ pillar: "game", gameType: "nback" })).toContain("nback_3");
    expect(candidateKeys({ pillar: "game", gameType: "syllogism" })).toContain("syllogism_20");
  });
});

describe("evaluateAchievements — facts-only predicates", () => {
  it("first interview attempt unlocks first_interview", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    mock.queueResponse("achievements", { data: [], error: null }); // unlocked set
    mock.queueResponse("interview_attempts", { data: [], error: null }); // all_categories
    mock.queueResponse("achievements", { data: null, error: null }); // upsert

    const result = await evaluateAchievements({
      pillar: "interview",
      attemptFacts: {},
      streak: 1,
      level: 1,
    });
    expect(result).toEqual([{ key: "first_interview", name: "First rep" }]);

    const upsert = mock.calls.find(
      (c) => c.table === "achievements" && c.method === "upsert",
    );
    expect(upsert!.args[1]).toEqual({ onConflict: "key", ignoreDuplicates: true });
    expect(upsert!.args[0]).toEqual([
      {
        key: "first_interview",
        context: { pillar: "interview", game_type: null, streak: 1, level: 1 },
      },
    ]);
  });

  it("a clean 60s+ behavioral rep can unlock filler_under_2 + delivery_90 + star_complete in one pass", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    mock.queueResponse("achievements", { data: [{ key: "first_interview" }], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null }); // all_categories: not yet
    mock.queueResponse("achievements", { data: null, error: null }); // upsert

    const result = await evaluateAchievements({
      pillar: "interview",
      attemptFacts: {
        duration_sec: 90,
        filler_per_min: 1.5,
        overall_delivery_score: 92,
        star: { situation: true, task: true, action: true, result: true },
      },
      streak: 2,
      level: 2,
    });
    expect(result.map((a) => a.key)).toEqual([
      "filler_under_2",
      "delivery_90",
      "star_complete",
    ]);
  });

  it("filler_under_2 requires BOTH duration ≥ 60 and filler/min < 2.0", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    mock.queueResponse("achievements", { data: [{ key: "first_interview" }], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });

    const short = await evaluateAchievements({
      pillar: "interview",
      attemptFacts: { duration_sec: 45, filler_per_min: 0.5 },
      streak: 1,
      level: 1,
    });
    expect(short.map((a) => a.key)).not.toContain("filler_under_2");
  });

  it("nback_3 unlocks on an N≥3 session scoring ≥60, not below", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    // Run 1: N=3 score 65 → unlock.
    mock.queueResponse("achievements", { data: [], error: null });
    mock.queueResponse("game_attempts", { data: null, error: null, count: 5 }); // rounds_100
    mock.queueResponse("achievements", { data: null, error: null }); // upsert
    const unlocked = await evaluateAchievements(
      baseCtx({ attemptFacts: { n: 3, score: 65 } }),
    );
    expect(unlocked.map((a) => a.key)).toEqual(["nback_3"]);

    // Run 2: N=2 perfect score → no unlock.
    Object.assign(mock, createSupabaseMock());
    mock.queueResponse("achievements", { data: [], error: null });
    mock.queueResponse("game_attempts", { data: null, error: null, count: 5 });
    const locked = await evaluateAchievements(
      baseCtx({ attemptFacts: { n: 2, score: 100 } }),
    );
    expect(locked).toEqual([]);
  });

  it("streak_7 / level_5 unlock from the computed streak/level", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    mock.queueResponse("achievements", { data: [], error: null });
    mock.queueResponse("game_attempts", { data: null, error: null, count: 5 });
    mock.queueResponse("achievements", { data: null, error: null }); // upsert

    const result = await evaluateAchievements(baseCtx({ streak: 7, level: 5 }));
    expect(result.map((a) => a.key)).toEqual(["streak_7", "level_5"]);
  });
});

describe("evaluateAchievements — one-query predicates", () => {
  it("all_categories unlocks once every category has an attempt (FK embed read)", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    mock.queueResponse("achievements", { data: [{ key: "first_interview" }], error: null });
    mock.queueResponse("interview_attempts", {
      data: [
        { interview_prompts: { category: "behavioral" } },
        { interview_prompts: { category: "pitch" } },
        { interview_prompts: { category: "technical" } },
        { interview_prompts: { category: "negotiation" } },
        { interview_prompts: null }, // ad-hoc attempt — ignored
      ],
      error: null,
    });
    mock.queueResponse("achievements", { data: null, error: null }); // upsert

    const result = await evaluateAchievements({
      pillar: "interview",
      attemptFacts: {},
      streak: 1,
      level: 1,
    });
    expect(result.map((a) => a.key)).toEqual(["all_categories"]);
  });

  it("fallacy_dozen requires ALL 12 types at ≥5 attempts and ≥80% accuracy", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    const { FALLACY_KEYS } = await import("@/lib/gemini/schemas");

    // 5 correct attempts for every key → mastered.
    const mastered = FALLACY_KEYS.flatMap((key) =>
      Array.from({ length: 5 }, () => ({ fallacy_key: key, is_correct: true })),
    );
    mock.queueResponse("achievements", { data: [], error: null });
    mock.queueResponse("game_attempts", { data: null, error: null, count: 60 }); // rounds_100 (<100)
    mock.queueResponse("game_attempts", { data: mastered, error: null }); // fallacy_dozen
    mock.queueResponse("achievements", { data: null, error: null }); // upsert

    const result = await evaluateAchievements(
      baseCtx({ gameType: "fallacy" as const }),
    );
    expect(result.map((a) => a.key)).toEqual(["fallacy_dozen"]);

    // One type below 5 attempts → locked.
    Object.assign(mock, createSupabaseMock());
    const short = mastered.slice(0, mastered.length - 1);
    mock.queueResponse("achievements", { data: [], error: null });
    mock.queueResponse("game_attempts", { data: null, error: null, count: 59 });
    mock.queueResponse("game_attempts", { data: short, error: null });
    const locked = await evaluateAchievements(
      baseCtx({ gameType: "fallacy" as const }),
    );
    expect(locked).toEqual([]);
  });

  it("rounds_100 unlocks at the 100th game attempt (head count)", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    mock.queueResponse("achievements", { data: [], error: null });
    mock.queueResponse("game_attempts", { data: null, error: null, count: 100 });
    mock.queueResponse("achievements", { data: null, error: null }); // upsert

    const result = await evaluateAchievements(
      baseCtx({ attemptFacts: { n: 2, score: 10 } }),
    );
    expect(result.map((a) => a.key)).toEqual(["rounds_100"]);
  });

  it("syllogism_20 counts today's CORRECT syllogisms only", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    const { todayLocal } = await import("@/lib/day");
    mock.queueResponse("achievements", { data: [], error: null });
    mock.queueResponse("game_attempts", { data: null, error: null, count: 40 }); // rounds_100
    mock.queueResponse("game_attempts", { data: null, error: null, count: 20 }); // syllogism_20
    mock.queueResponse("achievements", { data: null, error: null }); // upsert

    const result = await evaluateAchievements(
      baseCtx({ gameType: "syllogism" as const }),
    );
    expect(result.map((a) => a.key)).toEqual(["syllogism_20"]);

    const eqCalls = mock.calls.filter(
      (c) => c.table === "game_attempts" && c.method === "eq",
    );
    expect(
      eqCalls.some((c) => c.args[0] === "game_type" && c.args[1] === "syllogism"),
    ).toBe(true);
    expect(
      eqCalls.some((c) => c.args[0] === "local_day" && c.args[1] === todayLocal()),
    ).toBe(true);
    expect(eqCalls.some((c) => c.args[0] === "is_correct" && c.args[1] === true)).toBe(true);
  });
});

describe("evaluateAchievements — robustness", () => {
  it("already-unlocked keys are skipped (no re-unlock, no upsert when nothing new)", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    mock.queueResponse("achievements", {
      data: [{ key: "first_interview" }, { key: "streak_7" }],
      error: null,
    });
    mock.queueResponse("interview_attempts", { data: [], error: null }); // all_categories

    const result = await evaluateAchievements({
      pillar: "interview",
      attemptFacts: {},
      streak: 8, // streak_7 would pass, but it's already unlocked
      level: 1,
    });
    expect(result).toEqual([]);
    expect(
      mock.calls.some((c) => c.table === "achievements" && c.method === "upsert"),
    ).toBe(false);
  });

  it("a single failing predicate query is skipped — the others still evaluate", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    mock.queueResponse("achievements", { data: [], error: null });
    // all_categories read blows up; first_interview (facts-only) must survive.
    mock.queueResponse("interview_attempts", {
      data: null,
      error: { message: "boom" },
    });
    mock.queueResponse("achievements", { data: null, error: null }); // upsert

    const result = await evaluateAchievements({
      pillar: "interview",
      attemptFacts: {},
      streak: 1,
      level: 1,
    });
    expect(result.map((a) => a.key)).toEqual(["first_interview"]);
  });

  it("propagates a hard failure reading the unlocked set (caller degrades gracefully)", async () => {
    const { evaluateAchievements } = await import("@/lib/achievements");
    mock.queueResponse("achievements", { data: null, error: { message: "down" } });
    await expect(
      evaluateAchievements(baseCtx()),
    ).rejects.toThrow(/achievements read failed/);
  });
});
