/**
 * Shared adaptive-difficulty rule for the token games (DESIGN_V2_GAMES.md §4.5).
 * Pure module (no server-only import) so tests can exercise it directly —
 * mirrors n-back's `nextLevel` philosophy: one cheap read, deliberately simple.
 * The 5-window mixing levels right after a promotion is accepted noise.
 */

/**
 * Next level from the most recent attempts: ≥4/5 correct → level+1 (cap),
 * ≤2/5 → level−1 (floor), else hold. Fewer than 5 recent attempts → hold.
 * First ever (garbage/missing `last`) → min.
 */
export function nextAdaptiveLevel(
  last: number,
  recentCorrect: boolean[],
  min: number,
  max: number,
): number {
  const level = Number.isFinite(last)
    ? Math.min(max, Math.max(min, Math.round(last)))
    : min;
  if (recentCorrect.length < 5) return level;
  const correct = recentCorrect.slice(0, 5).filter(Boolean).length;
  if (correct >= 4) return Math.min(max, level + 1);
  if (correct <= 2) return Math.max(min, level - 1);
  return level;
}
