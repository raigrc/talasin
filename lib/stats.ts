import "server-only";
import { getServiceClient } from "./supabase/server";
import { getStreaks } from "./streak";
import { todayLocal, addDays } from "./day";
import { levelFromXp } from "./xp";
import { getDailyGoal, getXpTotal, type DailyGoal } from "./progression";
import { getUnlockedAchievements, achievementName } from "./achievements";
import { nextLevel, N_MIN } from "./games/nback/engine";
import type { GameAttempt, InterviewAttempt } from "./supabase/types";

/**
 * Dashboard aggregates (DESIGN.md §3.7; extended per DESIGN_V1.md §4.8).
 * Computed server-side from real saved rows only — never seeded/fake data.
 * Read either directly in the /progress RSC or via GET /api/stats (the
 * client-refresh fallback).
 *
 * Trends look at the most recent ~30 attempts of each pillar and roll them into
 * per-day points so the charts show a readable line without querying all history.
 * Weekly comparison uses ROLLING last-7-local-days windows (not ISO weeks) to
 * avoid week-boundary edge cases; computed in TS from local_day.
 */

const TREND_ATTEMPTS = 30; // window per the Wave 2 brief (~20-30)

export interface GameTrendPoint {
  local_day: string;
  accuracy: number; // 0..1
  count: number;
}
export interface FallacyBreakdown {
  fallacy_key: string;
  accuracy: number; // 0..1
  count: number;
}
export interface InterviewTrendPoint {
  local_day: string;
  avg_filler_rate: number; // fillers per minute
  avg_clarity: number; // 0..100
  avg_wpm: number;
  avg_delivery: number; // 0..100
  count: number;
}

export interface NbackTrendPoint {
  local_day: string;
  avg_score: number; // 0..100
  max_n: number;
  count: number;
}
export interface SyllogismTrendPoint {
  local_day: string;
  accuracy: number; // 0..1
  count: number;
}

/** Rolling-7-day window aggregate; null = no data (never a fake zero). */
export interface WeeklyWindowStats {
  activities: number;
  avg_delivery: number | null; // 0..100
  avg_filler_per_min: number | null;
  game_accuracy: number | null; // 0..1, binary-scored games (fallacy + syllogism)
}

export interface XpStats {
  total: number;
  level: number;
  into_level: number;
  for_next: number;
}

export interface UnlockedAchievementStat {
  key: string;
  name: string;
  unlocked_at: string;
}

export interface Stats {
  streak: number;
  best_streak: number;
  game: {
    total: number;
    correct: number;
    accuracy: number;
    trend: GameTrendPoint[];
    by_fallacy: FallacyBreakdown[];
  };
  interview: {
    total: number;
    trend: InterviewTrendPoint[];
  };
  // --- v1 additive fields (DESIGN_V1.md §4.8) ---
  games: {
    nback: { total: number; current_n: number; trend: NbackTrendPoint[] };
    syllogism: { total: number; trend: SyllogismTrendPoint[] };
  };
  xp: XpStats;
  weekly: {
    this: WeeklyWindowStats;
    last: WeeklyWindowStats;
  };
  achievements: UnlockedAchievementStat[];
  daily_goal: DailyGoal;
}

/** Round to `d` decimals. */
function round(n: number, d = 2): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export async function getStats(): Promise<Stats> {
  const supabase = getServiceClient();

  const { streak, bestStreak } = await getStreaks();

  // --- game: totals + fallacy breakdown over ALL attempts (cheap columns) ---
  // Scoped to fallacy rows (DESIGN_V1.md §4.8): n-back/syllogism attempts must
  // not pollute "Game accuracy" / "Accuracy by fallacy". Full extension = Wave C.
  const { data: gameRows, error: gameErr } = await supabase
    .from("game_attempts")
    .select("is_correct, fallacy_key, local_day, created_at")
    .eq("game_type", "fallacy")
    .order("created_at", { ascending: false });
  if (gameErr) throw new Error(`game_attempts read failed: ${gameErr.message}`);

  const game = (gameRows ?? []) as Pick<
    GameAttempt,
    "is_correct" | "fallacy_key" | "local_day" | "created_at"
  >[];

  const gameTotal = game.length;
  const gameCorrect = game.filter((r) => r.is_correct).length;

  // Per-fallacy accuracy across all attempts.
  const byFallacyMap = new Map<string, { correct: number; count: number }>();
  for (const r of game) {
    // fallacy rows always carry fallacy_key (schema shape CHECK); the column is
    // only nullable for other game types, which the query above filters out.
    if (r.fallacy_key == null) continue;
    const cur = byFallacyMap.get(r.fallacy_key) ?? { correct: 0, count: 0 };
    cur.count += 1;
    if (r.is_correct) cur.correct += 1;
    byFallacyMap.set(r.fallacy_key, cur);
  }
  const byFallacy: FallacyBreakdown[] = [...byFallacyMap.entries()]
    .map(([fallacy_key, v]) => ({
      fallacy_key,
      accuracy: v.count > 0 ? round(v.correct / v.count) : 0,
      count: v.count,
    }))
    .sort((a, b) => b.count - a.count);

  // Game trend: most recent ~30 attempts, grouped by local_day (chronological).
  const recentGame = game.slice(0, TREND_ATTEMPTS);
  const gameByDay = new Map<string, { correct: number; count: number }>();
  for (const r of recentGame) {
    const cur = gameByDay.get(r.local_day) ?? { correct: 0, count: 0 };
    cur.count += 1;
    if (r.is_correct) cur.correct += 1;
    gameByDay.set(r.local_day, cur);
  }
  const gameTrend: GameTrendPoint[] = [...gameByDay.entries()]
    .map(([local_day, v]) => ({
      local_day,
      accuracy: v.count > 0 ? round(v.correct / v.count) : 0,
      count: v.count,
    }))
    .sort((a, b) => a.local_day.localeCompare(b.local_day));

  // --- interview: most recent ~30 attempts, daily averages ------------------
  const { data: ivRows, error: ivErr } = await supabase
    .from("interview_attempts")
    .select(
      "filler_count, words_per_minute, clarity_score, overall_delivery_score, duration_sec, local_day, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(TREND_ATTEMPTS);
  if (ivErr) throw new Error(`interview_attempts read failed: ${ivErr.message}`);

  const iv = (ivRows ?? []) as Pick<
    InterviewAttempt,
    | "filler_count"
    | "words_per_minute"
    | "clarity_score"
    | "overall_delivery_score"
    | "duration_sec"
    | "local_day"
    | "created_at"
  >[];

  // Total interview count (all-time) is a separate cheap head-count query.
  const { count: ivTotal, error: ivCountErr } = await supabase
    .from("interview_attempts")
    .select("id", { count: "exact", head: true });
  if (ivCountErr) throw new Error(`interview_attempts count failed: ${ivCountErr.message}`);

  // Group the recent window by local_day and average the delivery metrics.
  interface DayAcc {
    fillerRateSum: number;
    fillerRateN: number;
    claritySum: number;
    clarityN: number;
    wpmSum: number;
    wpmN: number;
    deliverySum: number;
    deliveryN: number;
    count: number;
  }
  const ivByDay = new Map<string, DayAcc>();
  for (const r of iv) {
    const cur =
      ivByDay.get(r.local_day) ??
      ({
        fillerRateSum: 0,
        fillerRateN: 0,
        claritySum: 0,
        clarityN: 0,
        wpmSum: 0,
        wpmN: 0,
        deliverySum: 0,
        deliveryN: 0,
        count: 0,
      } satisfies DayAcc);
    cur.count += 1;

    // Filler rate/min derived from stored filler_count + duration (no column).
    const dur = r.duration_sec ?? 0;
    if (dur > 0) {
      cur.fillerRateSum += r.filler_count / (dur / 60);
      cur.fillerRateN += 1;
    }
    if (r.clarity_score != null) {
      cur.claritySum += r.clarity_score;
      cur.clarityN += 1;
    }
    if (r.words_per_minute != null) {
      cur.wpmSum += r.words_per_minute;
      cur.wpmN += 1;
    }
    if (r.overall_delivery_score != null) {
      cur.deliverySum += r.overall_delivery_score;
      cur.deliveryN += 1;
    }
    ivByDay.set(r.local_day, cur);
  }
  const ivTrend: InterviewTrendPoint[] = [...ivByDay.entries()]
    .map(([local_day, v]) => ({
      local_day,
      avg_filler_rate: v.fillerRateN > 0 ? round(v.fillerRateSum / v.fillerRateN, 1) : 0,
      avg_clarity: v.clarityN > 0 ? Math.round(v.claritySum / v.clarityN) : 0,
      avg_wpm: v.wpmN > 0 ? Math.round(v.wpmSum / v.wpmN) : 0,
      avg_delivery: v.deliveryN > 0 ? Math.round(v.deliverySum / v.deliveryN) : 0,
      count: v.count,
    }))
    .sort((a, b) => a.local_day.localeCompare(b.local_day));

  // --- v1: per-game trends (n-back / syllogism), DESIGN_V1.md §4.8 ----------
  const { data: nbRows, error: nbErr, count: nbCount } = await supabase
    .from("game_attempts")
    .select("score, detail, local_day, created_at", { count: "exact" })
    .eq("game_type", "nback")
    .order("created_at", { ascending: false })
    .limit(TREND_ATTEMPTS);
  if (nbErr) throw new Error(`nback attempts read failed: ${nbErr.message}`);

  interface NbRow {
    score: number | null;
    detail: Record<string, unknown> | null;
    local_day: string;
  }
  const nb = (nbRows ?? []) as NbRow[];

  // current_n mirrors the round-issuance rule (lib/games/nback): the N the
  // NEXT session will serve, from the most recent attempt; N_MIN when fresh.
  let currentN = N_MIN;
  if (nb.length > 0) {
    const lastN = Number(nb[0].detail?.n);
    const lastScore = Number(nb[0].score ?? 0);
    currentN = nextLevel(Number.isFinite(lastN) ? lastN : N_MIN, lastScore);
  }

  const nbByDay = new Map<string, { scoreSum: number; scoreN: number; maxN: number; count: number }>();
  for (const r of nb) {
    const cur = nbByDay.get(r.local_day) ?? { scoreSum: 0, scoreN: 0, maxN: 0, count: 0 };
    cur.count += 1;
    if (r.score != null) {
      cur.scoreSum += r.score;
      cur.scoreN += 1;
    }
    const n = Number(r.detail?.n);
    if (Number.isFinite(n) && n > cur.maxN) cur.maxN = n;
    nbByDay.set(r.local_day, cur);
  }
  const nbackTrend: NbackTrendPoint[] = [...nbByDay.entries()]
    .map(([local_day, v]) => ({
      local_day,
      avg_score: v.scoreN > 0 ? Math.round(v.scoreSum / v.scoreN) : 0,
      max_n: v.maxN,
      count: v.count,
    }))
    .sort((a, b) => a.local_day.localeCompare(b.local_day));

  const { data: sylRows, error: sylErr, count: sylCount } = await supabase
    .from("game_attempts")
    .select("is_correct, local_day, created_at", { count: "exact" })
    .eq("game_type", "syllogism")
    .order("created_at", { ascending: false })
    .limit(TREND_ATTEMPTS);
  if (sylErr) throw new Error(`syllogism attempts read failed: ${sylErr.message}`);

  const syl = (sylRows ?? []) as Pick<GameAttempt, "is_correct" | "local_day">[];
  const sylByDay = new Map<string, { correct: number; count: number }>();
  for (const r of syl) {
    const cur = sylByDay.get(r.local_day) ?? { correct: 0, count: 0 };
    cur.count += 1;
    if (r.is_correct) cur.correct += 1;
    sylByDay.set(r.local_day, cur);
  }
  const syllogismTrend: SyllogismTrendPoint[] = [...sylByDay.entries()]
    .map(([local_day, v]) => ({
      local_day,
      accuracy: v.count > 0 ? round(v.correct / v.count) : 0,
      count: v.count,
    }))
    .sort((a, b) => a.local_day.localeCompare(b.local_day));

  // --- v1: weekly insight — rolling last 7 local days vs the 7 before -------
  const today = todayLocal();
  const thisStart = addDays(today, -6);
  const lastStart = addDays(today, -13);

  const { data: wkGameRows, error: wkGameErr } = await supabase
    .from("game_attempts")
    .select("is_correct, local_day")
    .gte("local_day", lastStart);
  if (wkGameErr) throw new Error(`weekly game read failed: ${wkGameErr.message}`);

  const { data: wkIvRows, error: wkIvErr } = await supabase
    .from("interview_attempts")
    .select("overall_delivery_score, filler_count, duration_sec, local_day")
    .gte("local_day", lastStart);
  if (wkIvErr) throw new Error(`weekly interview read failed: ${wkIvErr.message}`);

  interface WeekAcc {
    activities: number;
    deliverySum: number;
    deliveryN: number;
    fillerRateSum: number;
    fillerRateN: number;
    gameCorrect: number;
    gameN: number;
  }
  const emptyWeek = (): WeekAcc => ({
    activities: 0,
    deliverySum: 0,
    deliveryN: 0,
    fillerRateSum: 0,
    fillerRateN: 0,
    gameCorrect: 0,
    gameN: 0,
  });
  const weeks = { this: emptyWeek(), last: emptyWeek() };
  const weekFor = (day: string): WeekAcc | null =>
    day >= thisStart ? weeks.this : day >= lastStart ? weeks.last : null;

  for (const r of (wkGameRows ?? []) as Pick<GameAttempt, "is_correct" | "local_day">[]) {
    const w = weekFor(r.local_day);
    if (!w) continue;
    w.activities += 1;
    // Accuracy over binary-scored games only (fallacy + syllogism); n-back
    // rows carry is_correct null and contribute to activities alone.
    if (r.is_correct != null) {
      w.gameN += 1;
      if (r.is_correct) w.gameCorrect += 1;
    }
  }
  for (const r of (wkIvRows ?? []) as Pick<
    InterviewAttempt,
    "overall_delivery_score" | "filler_count" | "duration_sec" | "local_day"
  >[]) {
    const w = weekFor(r.local_day);
    if (!w) continue;
    w.activities += 1;
    if (r.overall_delivery_score != null) {
      w.deliverySum += r.overall_delivery_score;
      w.deliveryN += 1;
    }
    const dur = r.duration_sec ?? 0;
    if (dur > 0) {
      w.fillerRateSum += r.filler_count / (dur / 60);
      w.fillerRateN += 1;
    }
  }
  const toWeekly = (w: WeekAcc): WeeklyWindowStats => ({
    activities: w.activities,
    avg_delivery: w.deliveryN > 0 ? Math.round(w.deliverySum / w.deliveryN) : null,
    avg_filler_per_min: w.fillerRateN > 0 ? round(w.fillerRateSum / w.fillerRateN, 1) : null,
    game_accuracy: w.gameN > 0 ? round(w.gameCorrect / w.gameN) : null,
  });

  // --- v1: XP / achievements / daily goal ------------------------------------
  const xpTotal = await getXpTotal();
  const levelInfo = levelFromXp(xpTotal);

  const unlocked = await getUnlockedAchievements();
  const achievements: UnlockedAchievementStat[] = unlocked.map((u) => ({
    key: u.key,
    name: achievementName(u.key),
    unlocked_at: u.unlocked_at,
  }));

  const dailyGoal = await getDailyGoal();

  return {
    streak,
    best_streak: bestStreak,
    game: {
      total: gameTotal,
      correct: gameCorrect,
      accuracy: gameTotal > 0 ? round(gameCorrect / gameTotal) : 0,
      trend: gameTrend,
      by_fallacy: byFallacy,
    },
    interview: {
      total: ivTotal ?? 0,
      trend: ivTrend,
    },
    games: {
      nback: { total: nbCount ?? nb.length, current_n: currentN, trend: nbackTrend },
      syllogism: { total: sylCount ?? syl.length, trend: syllogismTrend },
    },
    xp: {
      total: xpTotal,
      level: levelInfo.level,
      into_level: levelInfo.into_level,
      for_next: levelInfo.for_next,
    },
    weekly: {
      this: toWeekly(weeks.this),
      last: toWeekly(weeks.last),
    },
    achievements,
    daily_goal: dailyGoal,
  };
}
