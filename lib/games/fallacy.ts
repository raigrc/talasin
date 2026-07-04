import "server-only";
import { z } from "zod";
import { getNextRound, recordAnswer } from "../game";
import type { GameDefinition } from "./types";

/**
 * Fallacy GameDefinition (DESIGN_V1.md §3.2) — a thin adapter over the
 * UNTOUCHED lib/game.ts engine (DB-served rounds, weighted by weak fallacies).
 * The round payload stays byte-identical to the MVP contract:
 * { id, argument_text, choices, difficulty } — no game_type/token fields.
 */

const answerBody = z.object({
  // Absent game_type → fallacy (legacy body accepted unchanged).
  game_type: z.literal("fallacy").optional(),
  round_id: z.string().uuid(),
  chosen_key: z.string().min(1).max(64),
  answered_ms: z.number().int().nonnegative().max(3_600_000).optional(),
});

export const fallacyGame: GameDefinition = {
  id: "fallacy",
  name: "Spot the fallacy",
  tagline: "Identify the logical fallacy in a short argument.",
  href: "/game/fallacy",
  pillarLabel: "Fallacy",
  answerBody,

  async next({ exclude }) {
    const round = await getNextRound(exclude);
    // Spread into a plain record; the shape is exactly the legacy PublicRound.
    return round ? { ...round } : null;
  },

  async answer(body) {
    const parsed = answerBody.parse(body);
    const result = await recordAnswer(
      parsed.round_id,
      parsed.chosen_key,
      parsed.answered_ms ?? null,
    );
    if (!result) return null; // round not found → route maps to 404

    return {
      reveal: {
        is_correct: result.is_correct,
        correct_key: result.correct_key,
        explanation: result.explanation,
      },
      isCorrect: result.is_correct,
      score: result.is_correct ? 100 : 0,
      xpAwarded: result.xp,
    };
  },
};
