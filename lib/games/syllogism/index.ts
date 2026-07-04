import "server-only";
import { z } from "zod";
import { getServiceClient } from "../../supabase/server";
import { todayLocal } from "../../day";
import { syllogismXp } from "../../xp";
import { signRoundToken, verifyRoundToken } from "../token";
import {
  AlreadyScoredError,
  PG_UNIQUE_VIOLATION,
  RoundExpiredError,
  type GameDefinition,
} from "../types";
import { getForm, pickRound, termsHash } from "./engine";
import { TERM_TRIPLES } from "./templates";

/**
 * Syllogism sprint GameDefinition (DESIGN_V1.md §3.5). Rounds come from the
 * local template bank — deterministic validity, zero Gemini. Validity is NOT
 * in the round payload; it's re-derived server-side from the token's form_id.
 */

const TOKEN_TTL_SEC = 10 * 60;
const RECENT_WINDOW = 300; // last N attempts checked for exact-combo repeats

const answerBody = z.object({
  game_type: z.literal("syllogism"),
  token: z.string().min(1),
  answer: z.enum(["follows", "does_not_follow"]),
  answered_ms: z.number().int().nonnegative().max(3_600_000).optional(),
});

interface SyllogismTokenData {
  form_id: string;
  triple: number;
  phrasing: number;
}

/** terms_hash values of the most recent syllogism attempts (repeat avoidance). */
async function recentHashes(): Promise<Set<string>> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("game_attempts")
    .select("detail")
    .eq("game_type", "syllogism")
    .order("created_at", { ascending: false })
    .limit(RECENT_WINDOW);
  if (error) throw new Error(`syllogism attempts read failed: ${error.message}`);

  const hashes = new Set<string>();
  for (const row of (data ?? []) as { detail: Record<string, unknown> | null }[]) {
    const h = row.detail?.terms_hash;
    if (typeof h === "string") hashes.add(h);
  }
  return hashes;
}

export const syllogismGame: GameDefinition = {
  id: "syllogism",
  name: "Syllogism sprint",
  tagline: "Two premises, one conclusion — does it follow? Quick-fire logic.",
  href: "/game/syllogism",
  pillarLabel: "Syllogism",
  answerBody,

  async next() {
    const recent = await recentHashes();
    const round = pickRound(recent);
    const token = signRoundToken(
      "syllogism",
      {
        form_id: round.form_id,
        triple: round.triple,
        phrasing: round.phrasing,
      } satisfies SyllogismTokenData,
      TOKEN_TTL_SEC,
    );
    // validity/explanation stay server-side until the answer comes back.
    return {
      game_type: "syllogism",
      premises: round.premises,
      conclusion: round.conclusion,
      token,
    };
  },

  async answer(body) {
    const parsed = answerBody.parse(body);

    const verified = verifyRoundToken<SyllogismTokenData>(parsed.token, "syllogism");
    if (!verified) throw new RoundExpiredError();

    const data = verified.data;
    const form = data && typeof data.form_id === "string" ? getForm(data.form_id) : null;
    const triple = Number(data?.triple);
    const phrasing = data?.phrasing;
    if (
      !form ||
      !Number.isInteger(triple) ||
      triple < 0 ||
      triple >= TERM_TRIPLES.length ||
      (phrasing !== 0 && phrasing !== 1)
    ) {
      throw new RoundExpiredError();
    }

    const isCorrect = (parsed.answer === "follows") === form.valid;
    const score = isCorrect ? 100 : 0;
    const xp = syllogismXp(isCorrect);

    const supabase = getServiceClient();
    const { error } = await supabase.from("game_attempts").insert({
      game_type: "syllogism",
      round_id: null,
      chosen_key: null,
      is_correct: isCorrect,
      fallacy_key: null,
      score,
      detail: {
        round_uid: verified.uid,
        form_id: form.id,
        terms_hash: termsHash(form.id, triple, phrasing),
        valid: form.valid,
        phrasing,
      },
      xp,
      answered_ms: parsed.answered_ms ?? null,
      local_day: todayLocal(),
    });
    if (error) {
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        throw new AlreadyScoredError(); // round_uid replay → 409
      }
      throw new Error(`syllogism attempt insert failed: ${error.message}`);
    }

    return {
      reveal: {
        is_correct: isCorrect,
        valid: form.valid,
        explanation: form.explanation,
      },
      isCorrect,
      score,
      xpAwarded: xp,
    };
  },
};
