import "server-only";
import { getServiceClient } from "./supabase/server";
import { todayLocal, addDays } from "./day";
import type { DailyActivity } from "./supabase/types";

/**
 * Streak computation (DESIGN.md §6).
 *
 * Streak = number of consecutive local calendar days, ending today (or
 * yesterday if nothing done yet today), on which ≥1 activity of either pillar
 * happened. Computed from `daily_activity` (one row per active day).
 */

/** Compute the current live streak from an ordered set of active days. */
export function computeCurrentStreak(activeDays: Set<string>, today: string): number {
  // The streak is "alive" if there is activity today OR yesterday.
  let cursor: string;
  if (activeDays.has(today)) {
    cursor = today;
  } else if (activeDays.has(addDays(today, -1))) {
    cursor = addDays(today, -1);
  } else {
    return 0;
  }

  let streak = 0;
  while (activeDays.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/** Compute the longest run of consecutive active days ever. */
export function computeBestStreak(activeDays: Set<string>): number {
  let best = 0;
  for (const day of activeDays) {
    // Only start counting at the beginning of a run (no active day before it).
    if (activeDays.has(addDays(day, -1))) continue;
    let run = 0;
    let cursor = day;
    while (activeDays.has(cursor)) {
      run += 1;
      cursor = addDays(cursor, 1);
    }
    if (run > best) best = run;
  }
  return best;
}

/** Load all active days from daily_activity and return current + best streak. */
export async function getStreaks(): Promise<{ streak: number; bestStreak: number }> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("daily_activity")
    .select("local_day");
  if (error) throw new Error(`daily_activity read failed: ${error.message}`);

  const activeDays = new Set<string>(
    (data ?? []).map((row: Pick<DailyActivity, "local_day">) => row.local_day),
  );
  const today = todayLocal();
  return {
    streak: computeCurrentStreak(activeDays, today),
    bestStreak: computeBestStreak(activeDays),
  };
}

/**
 * Record that an activity happened today by upserting the per-day rollup, then
 * return the recomputed current streak. `pillar` picks which counter increments.
 */
export async function recordActivityAndGetStreak(
  pillar: "game" | "interview",
  day: string = todayLocal(),
): Promise<number> {
  const supabase = getServiceClient();

  // Upsert the daily rollup. We do a read-modify-write because PostgREST upsert
  // can't express "count = count + 1" directly; the single-user workload makes
  // the race window irrelevant.
  const { data: existing, error: readErr } = await supabase
    .from("daily_activity")
    .select("local_day, game_count, interview_count")
    .eq("local_day", day)
    .maybeSingle();
  if (readErr) throw new Error(`daily_activity read failed: ${readErr.message}`);

  const gameCount = (existing?.game_count ?? 0) + (pillar === "game" ? 1 : 0);
  const interviewCount =
    (existing?.interview_count ?? 0) + (pillar === "interview" ? 1 : 0);

  const { error: upsertErr } = await supabase.from("daily_activity").upsert(
    {
      local_day: day,
      game_count: gameCount,
      interview_count: interviewCount,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "local_day" },
  );
  if (upsertErr) throw new Error(`daily_activity upsert failed: ${upsertErr.message}`);

  const { streak } = await getStreaks();
  return streak;
}
