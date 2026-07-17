import "server-only";
import { fallacyGame } from "./fallacy";
import { nbackGame } from "./nback";
import { syllogismGame } from "./syllogism";
import { sequenceGame } from "./sequence";
import type { GameDefinition, GameMeta, GameType } from "./types";

/**
 * Game registry (DESIGN_V1.md §3) — THE seam for multi-game dispatch. The two
 * polymorphic routes (/api/game/next, /api/game/answer) look games up here;
 * adding game #4 = new lib/games/<id>/ folder + one entry in GAMES + one
 * app/game/<id>/ folder. No route changes, no schema changes.
 *
 * Server-only: definitions hold round production + scoring. UI code receives
 * only the serializable GameMeta via listGameMeta().
 */

export type { GameType, GameMeta, GameDefinition, AnswerOutcome } from "./types";
export { RoundExpiredError, AlreadyScoredError } from "./types";

export const GAMES: Record<GameType, GameDefinition> = {
  fallacy: fallacyGame,
  nback: nbackGame,
  syllogism: syllogismGame,
  sequence: sequenceGame,
};

/** Registry lookup — null for unknown ids (route maps to 400). */
export function getGame(id: string): GameDefinition | null {
  return Object.prototype.hasOwnProperty.call(GAMES, id)
    ? GAMES[id as GameType]
    : null;
}

/** Plain serializable metadata for the hub cards — safe to pass to RSC/UI. */
export function listGameMeta(): GameMeta[] {
  return (Object.keys(GAMES) as GameType[]).map((key) => {
    const { id, name, tagline, href, pillarLabel } = GAMES[key];
    return { id, name, tagline, href, pillarLabel };
  });
}
