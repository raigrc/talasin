import type { z } from "zod";

/**
 * Shared game-registry types (DESIGN_V1.md §3.2) + the typed round-token
 * failures the answer route maps to HTTP statuses (§4.2, §8).
 */

export type GameType = "fallacy" | "nback" | "syllogism" | "sequence";

/** Serializable card metadata — safe to pass from RSC to the hub UI. */
export interface GameMeta {
  id: GameType;
  name: string; // "Spot the fallacy" | "Dual N-back" | "Syllogism sprint"
  tagline: string; // one-liner for the hub card
  href: string; // "/game/fallacy" etc.
  pillarLabel: string; // trend-chart label
}

export interface AnswerOutcome {
  reveal: Record<string, unknown>; // per-game reveal payload (merged into the response)
  isCorrect: boolean | null; // null for non-binary games (n-back)
  score: number; // 0..100 normalized (fits existing trend charts)
  xpAwarded: number;
}

export interface GameDefinition extends GameMeta {
  /** Produce the next round. Must NEVER include the answer key / ground truth. */
  next(opts: { exclude: string[] }): Promise<Record<string, unknown> | null>;
  /** Zod schema for this game's answer body (after the game_type discriminator). */
  answerBody: z.ZodTypeAny;
  /**
   * Verify + score server-side, insert the game_attempts row, return the outcome.
   * Returns null for "round not found" (route → 404); throws RoundExpiredError
   * for a bad/expired/tampered token (route → 410) and AlreadyScoredError for a
   * round_uid replay (route → 409).
   */
  answer(body: unknown): Promise<AnswerOutcome | null>;
}

/** Bad, tampered, or expired round token → HTTP 410 round_expired. */
export class RoundExpiredError extends Error {
  constructor(message = "round_expired") {
    super(message);
    this.name = "RoundExpiredError";
  }
}

/** round_uid replay blocked by the partial unique index → HTTP 409 already_scored. */
export class AlreadyScoredError extends Error {
  constructor(message = "already_scored") {
    super(message);
    this.name = "AlreadyScoredError";
  }
}

/** Postgres unique-violation code — how a round_uid replay surfaces from the insert. */
export const PG_UNIQUE_VIOLATION = "23505";
