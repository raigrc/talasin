import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * QA follow-up: lib/game.ts#getNextRound's "attempted today" query
 * (`game_attempts.select("round_id").eq("local_day", today)`) is NOT scoped
 * to `game_type: "fallacy"` — unlike the sibling "recent error-rate window"
 * query a few lines below it, which IS correctly scoped (see
 * tests/lib/game.test.ts "reads the recent-attempts window scoped to fallacy
 * rows"). Today this is harmless because round_id is NULL on every non-fallacy
 * attempt row (schema.sql's shape CHECK), and `seen.has(null)` never matches a
 * real fallacy_rounds.id (a UUID string) — but it is an inconsistency with the
 * pattern used two queries later, and a latent trap if round_id semantics
 * ever change for another game type. This test pins the CURRENT safe
 * behavior so a future refactor either keeps it safe or is forced to
 * consciously update this test.
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

describe("getNextRound — cross-game-type attempt rows do not pollute today's exclusion set", () => {
  it("a heavy day of nback/syllogism play (round_id always null) does not exclude any fallacy round", async () => {
    const { getNextRound } = await import("@/lib/game");
    // Simulate 40 nback/syllogism attempts today — every row has round_id: null.
    mock.queueResponse("game_attempts", {
      data: Array.from({ length: 40 }, () => ({ round_id: null })),
      error: null,
    });
    mock.queueResponse("fallacy_rounds", {
      data: [
        { id: "r1", argument_text: "a", choices: [], difficulty: 1, fallacy_key: "strawman" },
      ],
      error: null,
    });
    mock.queueResponse("game_attempts", { data: [], error: null }); // recent error-rate window

    const round = await getNextRound([]);
    expect(round?.id).toBe("r1");
  });

  it("the 'attempted today' query IS filtered by game_type='fallacy' " +
     "(hardening applied per QA finding: symmetric with the recent-window query)", async () => {
    const { getNextRound } = await import("@/lib/game");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("fallacy_rounds", {
      data: [{ id: "r1", argument_text: "a", choices: [], difficulty: 1, fallacy_key: "strawman" }],
      error: null,
    });
    mock.queueResponse("game_attempts", { data: [], error: null });

    await getNextRound([]);

    // Find the FIRST game_attempts query (attempted-today) by call order —
    // it is the very first call recorded against game_attempts's `.select`.
    const gameAttemptsCalls = mock.calls.filter((c) => c.table === "game_attempts");
    const firstSelectIdx = gameAttemptsCalls.findIndex((c) => c.method === "select");
    const eqAfterFirstSelect = gameAttemptsCalls
      .slice(firstSelectIdx, firstSelectIdx + 3)
      .filter((c) => c.method === "eq");
    // Today's query filters BOTH game_type='fallacy' and local_day.
    const gameTypeEq = eqAfterFirstSelect.find((c) => c.args[0] === "game_type");
    expect(gameTypeEq?.args[1]).toBe("fallacy");
    expect(eqAfterFirstSelect.some((c) => c.args[0] === "local_day")).toBe(true);
  });
});
