import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getServiceClient } from "../../supabase/server";
import { todayLocal } from "../../day";
import { sequenceXp } from "../../xp";
import { nextAdaptiveLevel } from "../adaptive";
import { signRoundToken, verifyRoundToken } from "../token";
import {
  AlreadyScoredError,
  PG_UNIQUE_VIOLATION,
  RoundExpiredError,
  type GameDefinition,
} from "../types";
import { composeRound, getFamily, pickRound, validParams } from "./engine";

/**
 * Number Sequence GameDefinition (DESIGN_V2_GAMES.md §4). Rounds come from the
 * local family bank — deterministic answers, zero Gemini. The correct value /
 * index is NOT in the round payload; it's re-derived server-side from the
 * token's (family, params) plus the option shuffle seeded from the token uid.
 */

const TOKEN_TTL_SEC = 10 * 60;
const RECENT_WINDOW = 300; // last N attempts checked for exact-combo repeats
const DIFF_MIN = 1;
const DIFF_MAX = 3;

const answerBody = z.object({
  game_type: z.literal("sequence"),
  token: z.string().min(1),
  choice: z.number().int().min(0).max(3),
  answered_ms: z.number().int().nonnegative().max(3_600_000).optional(),
});

interface SequenceTokenData {
  f: string; // family id
  p: number[]; // canonical param array
}

/**
 * ONE query feeds both repeat avoidance and the adaptive ramp (§4.2): the
 * recent params_hash exclusion set plus, from the first rows, the inputs to
 * nextAdaptiveLevel (last difficulty played + last-5 correctness).
 */
async function recentState(): Promise<{ hashes: Set<string>; difficulty: number }> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("game_attempts")
    .select("is_correct, detail")
    .eq("game_type", "sequence")
    .order("created_at", { ascending: false })
    .limit(RECENT_WINDOW);
  if (error) throw new Error(`sequence attempts read failed: ${error.message}`);

  const rows = (data ?? []) as {
    is_correct: boolean | null;
    detail: Record<string, unknown> | null;
  }[];

  const hashes = new Set<string>();
  for (const row of rows) {
    const h = row.detail?.params_hash;
    if (typeof h === "string") hashes.add(h);
  }

  const lastDifficulty = Number(rows[0]?.detail?.difficulty ?? DIFF_MIN);
  const recent5 = rows.slice(0, 5).map((r) => r.is_correct === true);
  const difficulty = nextAdaptiveLevel(lastDifficulty, recent5, DIFF_MIN, DIFF_MAX);
  return { hashes, difficulty };
}

export const sequenceGame: GameDefinition = {
  id: "sequence",
  name: "Number sequence",
  tagline: "Four terms in, one term out — find the rule before you pick.",
  href: "/game/sequence",
  pillarLabel: "Sequence",
  answerBody,

  async next() {
    const { hashes, difficulty } = await recentState();
    const pick = pickRound(difficulty, hashes);
    const uid = randomUUID();
    const round = composeRound(pick.family, pick.p, uid);
    const token = signRoundToken(
      "sequence",
      { f: pick.family, p: pick.p } satisfies SequenceTokenData,
      TOKEN_TTL_SEC,
      uid,
    );
    // correct value/index + explanation stay server-side until the answer.
    return {
      game_type: "sequence",
      terms: round.shown,
      options: round.options,
      difficulty: round.difficulty,
      token,
    };
  },

  async answer(body) {
    const parsed = answerBody.parse(body);

    const verified = verifyRoundToken<SequenceTokenData>(parsed.token, "sequence");
    if (!verified) throw new RoundExpiredError();

    const data = verified.data;
    const family = data && typeof data.f === "string" ? getFamily(data.f) : null;
    if (!family || !validParams(family, data.p)) throw new RoundExpiredError();

    // Re-derive the exact round (terms, options order) — never from the client.
    const round = composeRound(family.id, data.p, verified.uid);
    const isCorrect = parsed.choice === round.correctIndex;
    const score = isCorrect ? 100 : 0;
    const xp = sequenceXp(isCorrect, round.difficulty);

    const supabase = getServiceClient();
    const { error } = await supabase.from("game_attempts").insert({
      game_type: "sequence",
      round_id: null,
      chosen_key: null,
      is_correct: isCorrect,
      fallacy_key: null,
      score,
      detail: {
        round_uid: verified.uid,
        family: round.family,
        difficulty: round.difficulty,
        params_hash: round.params_hash,
        chosen_index: parsed.choice,
      },
      xp,
      answered_ms: parsed.answered_ms ?? null,
      local_day: todayLocal(),
    });
    if (error) {
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new AlreadyScoredError(); // round_uid replay → 409
      }
      throw new Error(`sequence attempt insert failed: ${error.message}`);
    }

    return {
      reveal: {
        is_correct: isCorrect,
        correct_value: round.correct,
        correct_index: round.correctIndex,
        explanation: round.explanation,
        difficulty: round.difficulty,
        family: round.family,
      },
      isCorrect,
      score,
      xpAwarded: xp,
    };
  },
};
