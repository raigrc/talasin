import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * Route-handler tests for GET /api/game/next and POST /api/game/answer
 * (DESIGN.md §3.3-§3.4, DESIGN_V1.md §4.1-§4.2). lib/game.ts (fallacy engine)
 * and lib/progression.ts are mocked so the fallacy cases exercise ONLY the
 * route's auth gate, validation, dispatch, and status mapping. The n-back /
 * syllogism cases run the REAL registry engines against the Supabase mock —
 * token round-trips included (TALASIN_SESSION_SECRET is set per test).
 */

const mock = createSupabaseMock();

const { requireSessionMock, getNextRoundMock, recordAnswerMock, afterActivityMock } =
  vi.hoisted(() => ({
    requireSessionMock: vi.fn(),
    getNextRoundMock: vi.fn(),
    recordAnswerMock: vi.fn(),
    afterActivityMock: vi.fn(),
  }));

// Keep the real module (lib/games/token.ts needs safeEqual) but stub the gate.
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    requireSession: requireSessionMock,
    UnauthorizedError: class UnauthorizedError extends Error {},
  };
});
vi.mock("@/lib/game", () => ({
  getNextRound: getNextRoundMock,
  recordAnswer: recordAnswerMock,
}));
vi.mock("@/lib/progression", () => ({
  afterActivity: afterActivityMock,
}));
vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));

const ORIGINAL_ENV = { ...process.env };
const TEST_SECRET = "route-test-secret";

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(mock, createSupabaseMock());
  process.env = { ...ORIGINAL_ENV, TALASIN_SESSION_SECRET: TEST_SECRET };
  requireSessionMock.mockResolvedValue(undefined);
  afterActivityMock.mockImplementation(async (ctx: { xpAwarded: number }) => ({
    streak: 3,
    xpAwarded: ctx.xpAwarded,
    xpTotal: 1000,
    level: 4,
    newAchievements: [],
  }));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /api/game/next", () => {
  async function loadHandler() {
    const mod = await import("@/app/api/game/next/route");
    return mod.GET;
  }

  it("401 when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/session");
    requireSessionMock.mockRejectedValueOnce(new UnauthorizedError());
    const GET = await loadHandler();
    const res = await GET(new Request("http://localhost/api/game/next"));
    expect(res.status).toBe(401);
  });

  it("200 with a round on success, and never includes correct_key (route-level anti-cheat check)", async () => {
    getNextRoundMock.mockResolvedValueOnce({
      id: "r1",
      argument_text: "arg",
      choices: [{ key: "strawman", label: "Straw Man" }],
      difficulty: 1,
    });
    const GET = await loadHandler();
    const res = await GET(new Request("http://localhost/api/game/next"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.round).not.toHaveProperty("correct_key");
    expect(body.round).not.toHaveProperty("explanation");
  });

  it("missing ?type= defaults to fallacy with the exact legacy body shape", async () => {
    getNextRoundMock.mockResolvedValueOnce({
      id: "r1",
      argument_text: "arg",
      choices: [{ key: "strawman", label: "Straw Man" }],
      difficulty: 2,
    });
    const GET = await loadHandler();
    const res = await GET(new Request("http://localhost/api/game/next"));
    const body = await res.json();
    // Byte-identical legacy contract: { round: {id, argument_text, choices, difficulty} }.
    expect(body).toEqual({
      round: {
        id: "r1",
        argument_text: "arg",
        choices: [{ key: "strawman", label: "Straw Man" }],
        difficulty: 2,
      },
    });
  });

  it("200 with round:null and reason:exhausted when the pool is empty", async () => {
    getNextRoundMock.mockResolvedValueOnce(null);
    const GET = await loadHandler();
    const res = await GET(new Request("http://localhost/api/game/next"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ round: null, reason: "exhausted" });
  });

  it("400 for an unknown ?type=", async () => {
    const GET = await loadHandler();
    const res = await GET(new Request("http://localhost/api/game/next?type=chess"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "unknown game type" });
    expect(getNextRoundMock).not.toHaveBeenCalled();
  });

  it("parses the ?exclude= query param into an array, trimming and dropping empties", async () => {
    getNextRoundMock.mockResolvedValueOnce(null);
    const GET = await loadHandler();
    await GET(new Request("http://localhost/api/game/next?exclude=r1,%20r2,,r3"));
    expect(getNextRoundMock).toHaveBeenCalledWith(["r1", "r2", "r3"]);
  });

  it("missing ?exclude= defaults to an empty array", async () => {
    getNextRoundMock.mockResolvedValueOnce(null);
    const GET = await loadHandler();
    await GET(new Request("http://localhost/api/game/next"));
    expect(getNextRoundMock).toHaveBeenCalledWith([]);
  });

  it("500 server_error when getNextRound throws (DB failure)", async () => {
    getNextRoundMock.mockRejectedValueOnce(new Error("db down"));
    const GET = await loadHandler();
    const res = await GET(new Request("http://localhost/api/game/next"));
    expect(res.status).toBe(500);
  });

  it("?type=nback serves a server-seeded round with trials + token and NO ground-truth arrays", async () => {
    // currentN reads the latest n-back attempt — none yet → N=2.
    mock.queueResponse("game_attempts", { data: [], error: null });
    const GET = await loadHandler();
    const res = await GET(new Request("http://localhost/api/game/next?type=nback"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.round.game_type).toBe("nback");
    expect(body.round.n).toBe(2);
    expect(body.round.trial_ms).toBe(2500);
    expect(body.round.trials).toHaveLength(2 + 20); // n lead-in + 20 scoreable
    expect(typeof body.round.token).toBe("string");
    // Ground truth is re-derived server-side at answer time — never shipped.
    expect(body.round).not.toHaveProperty("posMatch");
    expect(body.round).not.toHaveProperty("letterMatch");
  });

  it("?type=syllogism serves premises/conclusion + token and never the validity/explanation", async () => {
    // recentHashes reads recent syllogism attempts — none yet.
    mock.queueResponse("game_attempts", { data: [], error: null });
    const GET = await loadHandler();
    const res = await GET(new Request("http://localhost/api/game/next?type=syllogism"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.round.game_type).toBe("syllogism");
    expect(body.round.premises).toHaveLength(2);
    expect(typeof body.round.conclusion).toBe("string");
    expect(typeof body.round.token).toBe("string");
    expect(body.round).not.toHaveProperty("valid"); // anti-cheat: server-held truth
    expect(body.round).not.toHaveProperty("explanation");
  });
});

describe("POST /api/game/answer", () => {
  async function loadHandler() {
    const mod = await import("@/app/api/game/answer/route");
    return mod.POST;
  }
  function req(body: unknown): Request {
    return new Request("http://localhost/api/game/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("401 when unauthenticated", async () => {
    const { UnauthorizedError } = await import("@/lib/session");
    requireSessionMock.mockRejectedValueOnce(new UnauthorizedError());
    const POST = await loadHandler();
    const res = await POST(req({ round_id: "00000000-0000-0000-0000-000000000000", chosen_key: "strawman" }));
    expect(res.status).toBe(401);
  });

  it("400 on invalid JSON body", async () => {
    const POST = await loadHandler();
    const bad = new Request("http://localhost/api/game/answer", {
      method: "POST",
      body: "not json{{{",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });

  it("400 when round_id is not a valid UUID", async () => {
    const POST = await loadHandler();
    const res = await POST(req({ round_id: "not-a-uuid", chosen_key: "strawman" }));
    expect(res.status).toBe(400);
  });

  it("400 when chosen_key is missing", async () => {
    const POST = await loadHandler();
    const res = await POST(req({ round_id: "00000000-0000-0000-0000-000000000000" }));
    expect(res.status).toBe(400);
  });

  it("400 when chosen_key is an empty string", async () => {
    const POST = await loadHandler();
    const res = await POST(
      req({ round_id: "00000000-0000-0000-0000-000000000000", chosen_key: "" }),
    );
    expect(res.status).toBe(400);
  });

  it("400 when answered_ms is negative", async () => {
    const POST = await loadHandler();
    const res = await POST(
      req({
        round_id: "00000000-0000-0000-0000-000000000000",
        chosen_key: "strawman",
        answered_ms: -1,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 when answered_ms exceeds the 1-hour sanity ceiling", async () => {
    const POST = await loadHandler();
    const res = await POST(
      req({
        round_id: "00000000-0000-0000-0000-000000000000",
        chosen_key: "strawman",
        answered_ms: 3_600_001,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 for an unknown game_type discriminator", async () => {
    const POST = await loadHandler();
    const res = await POST(req({ game_type: "chess", move: "e4" }));
    expect(res.status).toBe(400);
    expect(afterActivityMock).not.toHaveBeenCalled();
  });

  it("404 when the round id does not exist (recordAnswer returns null)", async () => {
    recordAnswerMock.mockResolvedValueOnce(null);
    const POST = await loadHandler();
    const res = await POST(
      req({ round_id: "00000000-0000-0000-0000-000000000000", chosen_key: "strawman" }),
    );
    expect(res.status).toBe(404);
    expect(afterActivityMock).not.toHaveBeenCalled(); // streak/XP must not move for a bogus round
  });

  it("200 with legacy fallacy fields + additive gamification fields on success", async () => {
    recordAnswerMock.mockResolvedValueOnce({
      is_correct: true,
      correct_key: "strawman",
      explanation: "explains it",
      fallacy_key: "strawman",
      xp: 15,
    });
    const POST = await loadHandler();
    const res = await POST(
      req({ round_id: "00000000-0000-0000-0000-000000000000", chosen_key: "strawman" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      // legacy fields, unchanged
      is_correct: true,
      correct_key: "strawman",
      explanation: "explains it",
      streak: 3,
      // additive v1 fields (DESIGN_V1.md §4.2)
      xp_awarded: 15,
      xp_total: 1000,
      level: 4,
      new_achievements: [],
    });
    expect(afterActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ pillar: "game", gameType: "fallacy", xpAwarded: 15 }),
    );
  });

  it("500 server_error when recordAnswer throws", async () => {
    recordAnswerMock.mockRejectedValueOnce(new Error("insert failed"));
    const POST = await loadHandler();
    const res = await POST(
      req({ round_id: "00000000-0000-0000-0000-000000000000", chosen_key: "strawman" }),
    );
    expect(res.status).toBe(500);
  });

  it("accepts a request without optional answered_ms", async () => {
    recordAnswerMock.mockResolvedValueOnce({
      is_correct: false,
      correct_key: "ad_hominem",
      explanation: "e",
      fallacy_key: "ad_hominem",
      xp: 10,
    });
    const POST = await loadHandler();
    const res = await POST(
      req({ round_id: "00000000-0000-0000-0000-000000000000", chosen_key: "strawman" }),
    );
    expect(res.status).toBe(200);
    expect(recordAnswerMock).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000000",
      "strawman",
      null,
    );
  });

  // --- n-back (real engine, mocked DB): token round-trip + server-side scoring ---

  async function makeNbackSubmission() {
    const { signRoundToken } = await import("@/lib/games/token");
    const { generateSequence, groundTruth, seedFromUid } = await import(
      "@/lib/games/nback/engine"
    );
    const uid = "11111111-2222-4333-8444-555555555555";
    const n = 2;
    const token = signRoundToken("nback", { n }, 60, uid);
    const truth = groundTruth(generateSequence(seedFromUid(uid), n), n);
    return { token, truth, n };
  }

  it("nback: scores raw per-trial booleans server-side (perfect play → 100) and returns next_n", async () => {
    const { token, truth } = await makeNbackSubmission();
    mock.queueResponse("game_attempts", { data: null, error: null }); // attempt insert
    const POST = await loadHandler();
    const res = await POST(
      req({
        game_type: "nback",
        token,
        responses: { position: truth.posMatch, letter: truth.letterMatch },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score).toBe(100);
    expect(body.n).toBe(2);
    expect(body.next_n).toBe(3); // ≥80 → level up
    expect(body.position).toEqual({ hits: 6, misses: 0, false_alarms: 0 });
    expect(body.letter).toEqual({ hits: 6, misses: 0, false_alarms: 0 });
    expect(body.xp_awarded).toBe(40); // 25 base + 15 score bonus (≥80)
    expect(body.streak).toBe(3);

    // The insert must carry the replay-guard uid + normalized score.
    const insertCall = mock.calls.find(
      (c) => c.table === "game_attempts" && c.method === "insert",
    );
    expect(insertCall!.args[0]).toMatchObject({
      game_type: "nback",
      score: 100,
      is_correct: null,
      round_id: null,
      fallacy_key: null,
    });
  });

  it("nback: 400 when the responses arrays are not exactly 20 long", async () => {
    const { token } = await makeNbackSubmission();
    const POST = await loadHandler();
    const res = await POST(
      req({
        game_type: "nback",
        token,
        responses: { position: [true], letter: [false] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("nback: 410 round_expired for a tampered token", async () => {
    const { token, truth } = await makeNbackSubmission();
    const tampered = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    const POST = await loadHandler();
    const res = await POST(
      req({
        game_type: "nback",
        token: tampered,
        responses: { position: truth.posMatch, letter: truth.letterMatch },
      }),
    );
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toEqual({ error: "round_expired" });
    expect(afterActivityMock).not.toHaveBeenCalled();
  });

  it("nback: 410 round_expired for an expired token", async () => {
    const { signRoundToken } = await import("@/lib/games/token");
    const token = signRoundToken("nback", { n: 2 }, -10); // already expired
    const POST = await loadHandler();
    const res = await POST(
      req({
        game_type: "nback",
        token,
        responses: {
          position: Array.from({ length: 20 }, () => false),
          letter: Array.from({ length: 20 }, () => false),
        },
      }),
    );
    expect(res.status).toBe(410);
  });

  it("nback: 409 already_scored when the round_uid replay index rejects the insert", async () => {
    const { token, truth } = await makeNbackSubmission();
    mock.queueResponse("game_attempts", {
      data: null,
      error: { message: "duplicate key value violates unique constraint", code: "23505" },
    });
    const POST = await loadHandler();
    const res = await POST(
      req({
        game_type: "nback",
        token,
        responses: { position: truth.posMatch, letter: truth.letterMatch },
      }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: "already_scored" });
    expect(afterActivityMock).not.toHaveBeenCalled();
  });

  // --- syllogism (real engine, mocked DB): validity from the token, never the client ---

  it("syllogism: correct answer judged against the form's server-held validity", async () => {
    const { signRoundToken } = await import("@/lib/games/token");
    // barbara is a VALID form → "follows" is correct.
    const token = signRoundToken("syllogism", { form_id: "barbara", triple: 0, phrasing: 0 }, 60);
    mock.queueResponse("game_attempts", { data: null, error: null }); // attempt insert
    const POST = await loadHandler();
    const res = await POST(
      req({ game_type: "syllogism", token, answer: "follows", answered_ms: 4200 }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.is_correct).toBe(true);
    expect(body.valid).toBe(true);
    expect(typeof body.explanation).toBe("string");
    expect(body.xp_awarded).toBe(10); // 5 base + 5 correct
    expect(body.streak).toBe(3);

    const insertCall = mock.calls.find(
      (c) => c.table === "game_attempts" && c.method === "insert",
    );
    expect(insertCall!.args[0]).toMatchObject({
      game_type: "syllogism",
      is_correct: true,
      score: 100,
      answered_ms: 4200,
    });
  });

  it("syllogism: wrong answer on an invalid form scores 0 but still reveals the explanation", async () => {
    const { signRoundToken } = await import("@/lib/games/token");
    // affirm_consequent is INVALID → "follows" is wrong.
    const token = signRoundToken(
      "syllogism",
      { form_id: "affirm_consequent", triple: 1, phrasing: 1 },
      60,
    );
    mock.queueResponse("game_attempts", { data: null, error: null });
    const POST = await loadHandler();
    const res = await POST(req({ game_type: "syllogism", token, answer: "follows" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.is_correct).toBe(false);
    expect(body.valid).toBe(false);
    expect(typeof body.explanation).toBe("string");
    expect(body.xp_awarded).toBe(5);
  });

  it("syllogism: 410 for a token carrying an unknown form_id (fails closed)", async () => {
    const { signRoundToken } = await import("@/lib/games/token");
    const token = signRoundToken("syllogism", { form_id: "nope", triple: 0, phrasing: 0 }, 60);
    const POST = await loadHandler();
    const res = await POST(req({ game_type: "syllogism", token, answer: "follows" }));
    expect(res.status).toBe(410);
  });

  it("syllogism: 410 when an nback token is replayed against the syllogism game (domain check)", async () => {
    const { signRoundToken } = await import("@/lib/games/token");
    const token = signRoundToken("nback", { n: 2 }, 60);
    const POST = await loadHandler();
    const res = await POST(req({ game_type: "syllogism", token, answer: "follows" }));
    expect(res.status).toBe(410);
  });
});
