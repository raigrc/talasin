import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getServiceClient } from "../../supabase/server";
import { todayLocal } from "../../day";
import { nbackXp } from "../../xp";
import { signRoundToken, verifyRoundToken } from "../token";
import {
  AlreadyScoredError,
  PG_UNIQUE_VIOLATION,
  RoundExpiredError,
  type GameDefinition,
} from "../types";
import {
  N_MAX,
  N_MIN,
  SCOREABLE_TRIALS,
  TRIAL_MS,
  generateSequence,
  groundTruth,
  nextLevel,
  scoreSession,
  seedFromUid,
} from "./engine";

/**
 * Dual N-back GameDefinition (DESIGN_V1.md §3.4). Rounds are server-seeded and
 * stateless: the trial sequence is derived from the token uid's sha256, so at
 * answer time the server regenerates the exact ground truth and scores the raw
 * per-trial booleans itself — the client never computes a score (anti-cheat).
 */

const TOKEN_TTL_SEC = 30 * 60;

const answerBody = z.object({
  game_type: z.literal("nback"),
  token: z.string().min(1),
  responses: z.object({
    position: z.array(z.boolean()).length(SCOREABLE_TRIALS),
    letter: z.array(z.boolean()).length(SCOREABLE_TRIALS),
  }),
});

interface NBackTokenData {
  n: number;
}

/**
 * N for the next round: read the most recent n-back attempt and apply the
 * progression rule (≥80 → n+1 cap 5, <50 → n−1 floor 2). One query, no state
 * table; first-ever round starts at N=2.
 */
async function currentN(): Promise<number> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("game_attempts")
    .select("score, detail")
    .eq("game_type", "nback")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`nback attempts read failed: ${error.message}`);

  const last = (data ?? [])[0] as
    | { score: number | null; detail: Record<string, unknown> | null }
    | undefined;
  if (!last) return N_MIN;

  const lastN = Number(last.detail?.n ?? N_MIN);
  const lastScore = Number(last.score ?? 0);
  return nextLevel(Number.isFinite(lastN) ? lastN : N_MIN, lastScore);
}

export const nbackGame: GameDefinition = {
  id: "nback",
  name: "Dual N-back",
  tagline: "Track positions and letters N steps back. Working-memory training.",
  href: "/game/nback",
  pillarLabel: "N-back",
  answerBody,

  async next() {
    const n = await currentN();
    const uid = randomUUID();
    const trials = generateSequence(seedFromUid(uid), n);
    const token = signRoundToken("nback", { n } satisfies NBackTokenData, TOKEN_TTL_SEC, uid);
    return { game_type: "nback", n, trial_ms: TRIAL_MS, trials, token };
  },

  async answer(body) {
    const parsed = answerBody.parse(body);

    const verified = verifyRoundToken<NBackTokenData>(parsed.token, "nback");
    if (!verified) throw new RoundExpiredError();
    const n = Number(verified.data?.n);
    if (!Number.isInteger(n) || n < N_MIN || n > N_MAX) throw new RoundExpiredError();

    // Re-derive ground truth from the token's seed — never from the client.
    const trials = generateSequence(seedFromUid(verified.uid), n);
    const truth = groundTruth(trials, n);
    const result = scoreSession(truth, parsed.responses);
    const xp = nbackXp(n, result.score);

    const supabase = getServiceClient();
    const { error } = await supabase.from("game_attempts").insert({
      game_type: "nback",
      round_id: null,
      chosen_key: null,
      is_correct: null,
      fallacy_key: null,
      score: result.score,
      detail: {
        round_uid: verified.uid,
        n,
        trials: SCOREABLE_TRIALS,
        position: result.position,
        letter: result.letter,
      },
      xp,
      answered_ms: null,
      local_day: todayLocal(),
    });
    if (error) {
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new AlreadyScoredError(); // round_uid replay → 409
      }
      throw new Error(`nback attempt insert failed: ${error.message}`);
    }

    return {
      reveal: {
        score: result.score,
        n,
        next_n: nextLevel(n, result.score),
        position: result.position,
        letter: result.letter,
      },
      isCorrect: null, // non-binary game
      score: result.score,
      xpAwarded: xp,
    };
  },
};
