/**
 * XP amounts + level curve (DESIGN_V1.md §5.1). XP is computed at WRITE time and
 * stored on the attempt row — one place for the rules, no read-time joins.
 * Pure module (no server-only import) so tests and client-safe code can share
 * the level math; nothing here is secret.
 */

/** Flat XP per interview attempt (highest-friction activity). */
export const INTERVIEW_XP = 50;

/** Fallacy round: 10 base + 5 if correct + 5 per difficulty step above 1 → 10–30. */
export function fallacyXp(isCorrect: boolean, difficulty: number): number {
  const diff = Number.isFinite(difficulty) ? Math.min(3, Math.max(1, difficulty)) : 1;
  return 10 + (isCorrect ? 5 : 0) + 5 * (diff - 1);
}

/** Syllogism round: quick-fire (~10s each) → 5 base + 5 if correct. */
export function syllogismXp(isCorrect: boolean): number {
  return 5 + (isCorrect ? 5 : 0);
}

/** N-back session: 25 base + 10 per N above 2 + a score bonus → 25–70. */
export function nbackXp(n: number, score: number): number {
  let bonus = 0;
  if (score >= 80) bonus = 15;
  else if (score >= 60) bonus = 10;
  else if (score >= 40) bonus = 5;
  return 25 + 10 * (Math.max(2, n) - 2) + bonus;
}

export interface LevelInfo {
  level: number;
  into_level: number; // XP earned past the current level's threshold
  for_next: number; // XP span between the current and next thresholds
}

/** Total XP needed to REACH level L: 100 × (L − 1)². L2=100, L3=400, L5=1600. */
export function levelThreshold(level: number): number {
  return 100 * (level - 1) ** 2;
}

/** Quadratic level curve: level(totalXp) = floor(sqrt(totalXp / 100)) + 1. */
export function levelFromXp(totalXp: number): LevelInfo {
  const xp = Math.max(0, Math.floor(totalXp));
  const level = Math.floor(Math.sqrt(xp / 100)) + 1;
  const current = levelThreshold(level);
  const next = levelThreshold(level + 1);
  return { level, into_level: xp - current, for_next: next - current };
}
