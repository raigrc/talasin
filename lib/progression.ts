import "server-only";
import { getServiceClient } from "./supabase/server";
import { recordActivityAndGetStreak } from "./streak";
import { todayLocal } from "./day";
import { levelFromXp } from "./xp";
import { evaluateAchievements } from "./achievements";
import type { GameType } from "./games/types";

/**
 * The single post-activity hook (DESIGN_V1.md §5.4). Every answer/feedback
 * route calls afterActivity() instead of recordActivityAndGetStreak directly,
 * so streak + XP totals + achievement unlocks compose in ONE place.
 */

/** Daily goal targets (§5.3): ≥1 game round AND ≥1 interview attempt per local day. */
export const DAILY_GOAL_GAME = 1;
export const DAILY_GOAL_INTERVIEW = 1;

export interface ActivityResult {
  streak: number;
  xpAwarded: number;
  xpTotal: number;
  level: number;
  newAchievements: { key: string; name: string }[];
}

export interface ActivityContext {
  pillar: "game" | "interview";
  gameType?: GameType;
  /** Already written on the attempt row before this hook runs. */
  xpAwarded: number;
  /** Whatever the achievement predicates will need (scores, flags, category…). */
  attemptFacts: Record<string, unknown>;
}

/**
 * Sum the xp columns of both attempt tables (write-time XP, §5.1). Exported so
 * the home page can render the level/XP bar without pulling full getStats().
 */
export async function getXpTotal(): Promise<number> {
  const supabase = getServiceClient();
  const [game, interview] = await Promise.all([
    supabase.from("game_attempts").select("xp"),
    supabase.from("interview_attempts").select("xp"),
  ]);
  if (game.error) throw new Error(`game xp read failed: ${game.error.message}`);
  if (interview.error) {
    throw new Error(`interview xp read failed: ${interview.error.message}`);
  }
  const sum = (rows: { xp: number | null }[] | null) =>
    (rows ?? []).reduce((acc, r) => acc + (r.xp ?? 0), 0);
  return sum(game.data) + sum(interview.data);
}

/**
 * Record the activity (streak), total up XP, and evaluate achievements.
 * Achievement evaluation is best-effort: by the time it runs the attempt row
 * is already recorded, so an achievements-table hiccup logs and returns [] —
 * it must never turn a scored answer into a 500 (§8 idempotency: a re-check on
 * the next activity unlocks anything that was missed).
 */
export async function afterActivity(ctx: ActivityContext): Promise<ActivityResult> {
  const streak = await recordActivityAndGetStreak(ctx.pillar);
  const xpTotal = await getXpTotal();
  const { level } = levelFromXp(xpTotal);

  let newAchievements: ActivityResult["newAchievements"] = [];
  try {
    newAchievements = await evaluateAchievements({
      pillar: ctx.pillar,
      gameType: ctx.gameType,
      attemptFacts: ctx.attemptFacts,
      streak,
      level,
    });
  } catch (err) {
    console.warn(`[progression] achievements degraded: ${(err as Error)?.message}`);
  }

  return { streak, xpAwarded: ctx.xpAwarded, xpTotal, level, newAchievements };
}

export interface DailyGoal {
  game_done: boolean;
  interview_done: boolean;
}

/** Today's goal state from the existing daily_activity rollup — zero new schema. */
export async function getDailyGoal(day: string = todayLocal()): Promise<DailyGoal> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("daily_activity")
    .select("game_count, interview_count")
    .eq("local_day", day)
    .maybeSingle();
  if (error) throw new Error(`daily_activity read failed: ${error.message}`);

  return {
    game_done: (data?.game_count ?? 0) >= DAILY_GOAL_GAME,
    interview_done: (data?.interview_count ?? 0) >= DAILY_GOAL_INTERVIEW,
  };
}
