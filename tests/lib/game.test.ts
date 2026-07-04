import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * Game scoring / answer-validation / round-serving tests (lib/game.ts,
 * DESIGN.md §3.3-§3.5). Supabase is mocked so these run with zero network
 * dependency and are fully deterministic.
 */

const mock = createSupabaseMock();

vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  // Recreate a clean mock client/queues per test.
  Object.assign(mock, createSupabaseMock());
});

describe("getNextRound — anti-cheat + exclusion + exhaustion", () => {
  it("never includes correct_key or explanation in the returned round shape", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: [], error: null }); // attempted today
    mock.queueResponse("fallacy_rounds", {
      data: [
        {
          id: "r1",
          argument_text: "Some argument",
          choices: [{ key: "strawman", label: "Straw Man" }],
          difficulty: 1,
          fallacy_key: "strawman",
        },
      ],
      error: null,
    });
    mock.queueResponse("game_attempts", { data: [], error: null }); // recent error-rate window

    const round = await getNextRound([]);
    expect(round).not.toBeNull();
    expect(round).not.toHaveProperty("correct_key");
    expect(round).not.toHaveProperty("explanation");
    expect(Object.keys(round!).sort()).toEqual(
      ["argument_text", "choices", "difficulty", "id"].sort(),
    );
  });

  it("returns null when the active pool is fully excluded (client exclude list)", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("fallacy_rounds", {
      data: [{ id: "r1", argument_text: "x", choices: [], difficulty: 1 }],
      error: null,
    });

    const round = await getNextRound(["r1"]);
    expect(round).toBeNull();
  });

  it("returns null when the active pool is fully excluded via today's attempts", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: [{ round_id: "r1" }], error: null });
    mock.queueResponse("fallacy_rounds", {
      data: [{ id: "r1", argument_text: "x", choices: [], difficulty: 1 }],
      error: null,
    });

    const round = await getNextRound([]);
    expect(round).toBeNull();
  });

  it("returns null (not throw) when there are zero active rounds at all", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("fallacy_rounds", { data: [], error: null });

    const round = await getNextRound([]);
    expect(round).toBeNull();
  });

  it("propagates a DB read error as a thrown Error rather than swallowing it", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: null, error: { message: "connection refused" } });

    await expect(getNextRound([])).rejects.toThrow(/attempts read failed/);
  });

  it("picks from the remaining unseen pool when only some rounds are excluded", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: [{ round_id: "r1" }], error: null });
    mock.queueResponse("fallacy_rounds", {
      data: [
        { id: "r1", argument_text: "seen today", choices: [], difficulty: 1, fallacy_key: "strawman" },
        { id: "r2", argument_text: "not seen", choices: [], difficulty: 1, fallacy_key: "bandwagon" },
      ],
      error: null,
    });
    mock.queueResponse("game_attempts", { data: [], error: null }); // recent window

    const round = await getNextRound([]);
    expect(round?.id).toBe("r2");
  });

  it("reads the recent-attempts window scoped to fallacy rows for weighting (DESIGN_V1 §3.6)", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("fallacy_rounds", {
      data: [{ id: "r1", argument_text: "x", choices: [], difficulty: 1, fallacy_key: "strawman" }],
      error: null,
    });
    mock.queueResponse("game_attempts", { data: [], error: null });

    await getNextRound([]);

    // The second game_attempts query must be filtered to game_type=fallacy so
    // n-back/syllogism rows never skew the fallacy error rates.
    const eqCalls = mock.calls.filter(
      (c) => c.table === "game_attempts" && c.method === "eq",
    );
    expect(
      eqCalls.some((c) => c.args[0] === "game_type" && c.args[1] === "fallacy"),
    ).toBe(true);
    const limitCall = mock.calls.find(
      (c) => c.table === "game_attempts" && c.method === "limit",
    );
    expect(limitCall?.args[0]).toBe(200);
  });

  it("propagates a recent-window read error as a thrown Error", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("fallacy_rounds", {
      data: [{ id: "r1", argument_text: "x", choices: [], difficulty: 1, fallacy_key: "strawman" }],
      error: null,
    });
    mock.queueResponse("game_attempts", { data: null, error: { message: "timeout" } });

    await expect(getNextRound([])).rejects.toThrow(/recent attempts read failed/);
  });

  it("weights weak fallacy types higher than strong ones (spaced repetition)", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("fallacy_rounds", {
      data: [
        { id: "weak", argument_text: "a", choices: [], difficulty: 1, fallacy_key: "strawman" },
        { id: "strong", argument_text: "b", choices: [], difficulty: 1, fallacy_key: "bandwagon" },
      ],
      error: null,
    });
    // Recent window: strawman always wrong (4×), bandwagon always right (4×).
    // err(strawman) = 5.5/9 ≈ 0.611 → weight ≈ 2.833; err(bandwagon) = 1.5/9 → 1.5.
    mock.queueResponse("game_attempts", {
      data: [
        ...Array.from({ length: 4 }, () => ({ fallacy_key: "strawman", is_correct: false })),
        ...Array.from({ length: 4 }, () => ({ fallacy_key: "bandwagon", is_correct: true })),
      ],
      error: null,
    });

    // rand = 0.6 → weighted r = 0.6 × 4.333 = 2.60 < 2.833 → "weak" is picked.
    // Under UNIFORM weights the same rand would pick "strong" (0.6 × 2 = 1.2 > 1),
    // so this pins the weighting, not just the pick mechanics.
    const randSpy = vi.spyOn(Math, "random").mockReturnValue(0.6);
    try {
      const round = await getNextRound([]);
      expect(round?.id).toBe("weak");
    } finally {
      randSpy.mockRestore();
    }
  });
});

describe("weightedPick — pure weighted selection helper", () => {
  it("returns null for an empty list", async () => {
    const { weightedPick } = await import("@/lib/game");
    expect(weightedPick([], [], () => 0.5)).toBeNull();
  });

  it("picks proportionally to weights with an injected rand", async () => {
    const { weightedPick } = await import("@/lib/game");
    const items = ["a", "b", "c"];
    const weights = [1, 2, 7]; // cumulative: 1, 3, 10
    expect(weightedPick(items, weights, () => 0.05)).toBe("a"); // r=0.5
    expect(weightedPick(items, weights, () => 0.25)).toBe("b"); // r=2.5
    expect(weightedPick(items, weights, () => 0.95)).toBe("c"); // r=9.5
  });

  it("treats non-finite/negative weights as 0", async () => {
    const { weightedPick } = await import("@/lib/game");
    const items = ["a", "b"];
    // "a" has weight NaN → 0, so any rand must land on "b".
    expect(weightedPick(items, [Number.NaN, 1], () => 0.01)).toBe("b");
    expect(weightedPick(items, [-5, 1], () => 0.99)).toBe("b");
  });

  it("falls back to a uniform pick when every weight is 0", async () => {
    const { weightedPick } = await import("@/lib/game");
    const items = ["a", "b", "c", "d"];
    expect(weightedPick(items, [0, 0, 0, 0], () => 0.6)).toBe("c"); // floor(0.6×4)=2
  });

  it("returns the last item on the float-rounding edge (rand → 1)", async () => {
    const { weightedPick } = await import("@/lib/game");
    expect(weightedPick(["a", "b"], [1, 1], () => 0.9999999999)).toBe("b");
  });
});

describe("recordAnswer — correctness + persistence", () => {
  it("marks a correct answer is_correct=true and returns the reveal payload (with write-time XP)", async () => {
    const { recordAnswer } = await import("@/lib/game");
    mock.queueResponse("fallacy_rounds", {
      data: {
        id: "r1",
        correct_key: "strawman",
        explanation: "It misrepresents the argument.",
        fallacy_key: "strawman",
        difficulty: 2,
      },
      error: null,
    });
    mock.queueResponse("game_attempts", { data: null, error: null }); // insert response

    const result = await recordAnswer("r1", "strawman", 4200);
    expect(result).toEqual({
      is_correct: true,
      correct_key: "strawman",
      explanation: "It misrepresents the argument.",
      fallacy_key: "strawman",
      xp: 20, // 10 base + 5 correct + 5 × (difficulty 2 − 1)
    });

    // v1 insert payload (DESIGN_V1.md §2.1): game_type/score/xp/detail written at answer time.
    const insertCall = mock.calls.find(
      (c) => c.table === "game_attempts" && c.method === "insert",
    );
    expect(insertCall).toBeDefined();
    expect(insertCall!.args[0]).toMatchObject({
      game_type: "fallacy",
      round_id: "r1",
      chosen_key: "strawman",
      is_correct: true,
      fallacy_key: "strawman",
      score: 100,
      detail: null,
      xp: 20,
      answered_ms: 4200,
    });
  });

  it("marks an incorrect answer is_correct=false but still reveals correct_key/explanation", async () => {
    const { recordAnswer } = await import("@/lib/game");
    mock.queueResponse("fallacy_rounds", {
      data: {
        id: "r1",
        correct_key: "strawman",
        explanation: "It misrepresents the argument.",
        fallacy_key: "strawman",
        difficulty: 1,
      },
      error: null,
    });
    mock.queueResponse("game_attempts", { data: null, error: null });

    const result = await recordAnswer("r1", "ad_hominem", 4200);
    expect(result?.is_correct).toBe(false);
    expect(result?.correct_key).toBe("strawman"); // revealed only AFTER answering, per §3.3/§3.4
    expect(result?.xp).toBe(10); // wrong answer still earns base XP

    const insertCall = mock.calls.find(
      (c) => c.table === "game_attempts" && c.method === "insert",
    );
    expect(insertCall!.args[0]).toMatchObject({ score: 0, xp: 10, is_correct: false });
  });

  it("returns null for an invalid/non-existent round id (maps to 404 at the route layer)", async () => {
    const { recordAnswer } = await import("@/lib/game");
    mock.queueResponse("fallacy_rounds", { data: null, error: null });

    const result = await recordAnswer("does-not-exist", "strawman", null);
    expect(result).toBeNull();
  });

  it("accepts a null answered_ms (optional field) without crashing", async () => {
    const { recordAnswer } = await import("@/lib/game");
    mock.queueResponse("fallacy_rounds", {
      data: { id: "r1", correct_key: "strawman", explanation: "e", fallacy_key: "strawman" },
      error: null,
    });
    mock.queueResponse("game_attempts", { data: null, error: null });

    const result = await recordAnswer("r1", "strawman", null);
    expect(result?.is_correct).toBe(true);
  });

  it("already-answered round (replay) is allowed and recorded as a new append-only attempt", async () => {
    // DESIGN §3.4: "attempts are append-only; a double-submit creates two rows
    // but does not corrupt streak." Simulate answering the same round twice.
    const { recordAnswer } = await import("@/lib/game");
    const roundRow = {
      data: { id: "r1", correct_key: "strawman", explanation: "e", fallacy_key: "strawman" },
      error: null,
    };
    mock.queueResponse("fallacy_rounds", roundRow);
    mock.queueResponse("game_attempts", { data: null, error: null });
    const first = await recordAnswer("r1", "strawman", 1000);

    mock.queueResponse("fallacy_rounds", roundRow);
    mock.queueResponse("game_attempts", { data: null, error: null });
    const second = await recordAnswer("r1", "ad_hominem", 2000);

    expect(first?.is_correct).toBe(true);
    expect(second?.is_correct).toBe(false);
    // Both calls succeeded independently — no dedup/blocking on round_id.
  });

  it("propagates an insert failure as a thrown Error", async () => {
    const { recordAnswer } = await import("@/lib/game");
    mock.queueResponse("fallacy_rounds", {
      data: { id: "r1", correct_key: "strawman", explanation: "e", fallacy_key: "strawman" },
      error: null,
    });
    mock.queueResponse("game_attempts", { data: null, error: { message: "insert failed: disk full" } });

    await expect(recordAnswer("r1", "strawman", null)).rejects.toThrow(/attempt insert failed/);
  });

  it("chosen_key is compared with strict equality (case-sensitive, no fuzzy match)", async () => {
    const { recordAnswer } = await import("@/lib/game");
    mock.queueResponse("fallacy_rounds", {
      data: { id: "r1", correct_key: "strawman", explanation: "e", fallacy_key: "strawman" },
      error: null,
    });
    mock.queueResponse("game_attempts", { data: null, error: null });

    const result = await recordAnswer("r1", "Strawman", null); // wrong case
    expect(result?.is_correct).toBe(false);
  });
});

describe("insertGeneratedRounds — batch insert + dedup", () => {
  it("returns all-zero result for an empty rounds array without touching the DB", async () => {
    const { insertGeneratedRounds } = await import("@/lib/game");
    const result = await insertGeneratedRounds([], "batch-1", "gemini-3.5-flash", new Set());
    expect(result).toEqual({ generated: 0, inserted: 0, skipped_duplicates: 0 });
    expect(mock.client.from).not.toHaveBeenCalled();
  });

  it("dedupes identical argument_text within the same batch before insert", async () => {
    const { insertGeneratedRounds } = await import("@/lib/game");
    const round = {
      fallacy_key: "strawman" as const,
      argument_text: "Same argument text twice",
      scenario_summary: "dup",
      choices: [{ key: "strawman" as const, label: "Straw Man" }],
      correct_key: "strawman" as const,
      explanation: "e",
      difficulty: 1,
    };
    mock.queueResponse("fallacy_rounds", { data: [{ id: "new-1" }], error: null }); // 1 inserted

    const result = await insertGeneratedRounds([round, round], "batch-1", "model", new Set());
    expect(result.generated).toBe(2);
    expect(result.inserted).toBe(1);
    expect(result.skipped_duplicates).toBe(1);
  });

  it("marks rounds flagged by self-critique as needs_review status", async () => {
    const { insertGeneratedRounds } = await import("@/lib/game");
    const round = {
      fallacy_key: "strawman" as const,
      argument_text: "arg text",
      scenario_summary: "flagged-scenario",
      choices: [{ key: "strawman" as const, label: "Straw Man" }],
      correct_key: "strawman" as const,
      explanation: "e",
      difficulty: 1,
    };
    mock.queueResponse("fallacy_rounds", { data: [{ id: "new-1" }], error: null });

    await insertGeneratedRounds([round], "batch-1", "model", new Set(["flagged-scenario"]));

    const upsertCall = mock.calls.find((c) => c.method === "upsert");
    expect(upsertCall).toBeDefined();
    const rows = upsertCall!.args[0] as { status: string }[];
    expect(rows[0].status).toBe("needs_review");
  });

  it("propagates an upsert error", async () => {
    const { insertGeneratedRounds } = await import("@/lib/game");
    const round = {
      fallacy_key: "strawman" as const,
      argument_text: "arg",
      scenario_summary: "s",
      choices: [],
      correct_key: "strawman" as const,
      explanation: "e",
      difficulty: 1,
    };
    mock.queueResponse("fallacy_rounds", { data: null, error: { message: "unique violation" } });

    await expect(
      insertGeneratedRounds([round], "batch-1", "model", new Set()),
    ).rejects.toThrow(/round insert failed/);
  });
});
