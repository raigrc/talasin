import "server-only";
import { getServiceClient } from "./supabase/server";
import { todayLocal } from "./day";
import { FALLACY_KEYS } from "./gemini/schemas";
import type { GameType } from "./games/types";

/**
 * Achievement catalog + server-side unlock evaluation (DESIGN_V1.md §5.2).
 * The catalog (names, descriptions, predicates) lives HERE in code; the DB
 * `achievements` table stores only unlock facts (key PK + unlocked_at +
 * context). Evaluation runs inside afterActivity() right after each recorded
 * activity: a static trigger map limits which keys are checked per activity,
 * already-unlocked keys are skipped, and each remaining predicate costs at
 * most ONE query. Unlocks insert with on-conflict-do-nothing (idempotent
 * under double-submits).
 */

export interface AchievementDef {
  key: string;
  name: string;
  description: string;
}

/** The twelve v1 achievements, tied to real goals (DESIGN_V1.md §5.2). */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  { key: "first_interview", name: "First rep", description: "Record your first interview answer." },
  { key: "streak_7", name: "One week sharp", description: "Reach a 7-day practice streak." },
  { key: "streak_30", name: "Habit formed", description: "Reach a 30-day practice streak." },
  { key: "filler_under_2", name: "Filler tamed", description: "A 60s+ answer with under 2 fillers per minute." },
  { key: "delivery_90", name: "Broadcast ready", description: "Score 90+ on overall delivery." },
  { key: "star_complete", name: "Full STAR", description: "A behavioral answer hitting all four STAR beats." },
  { key: "all_categories", name: "Range", description: "Practice at least one prompt in every category." },
  { key: "fallacy_dozen", name: "Fallacy master", description: "All 12 fallacy types at 5+ attempts and 80%+ accuracy." },
  { key: "nback_3", name: "Working memory 3", description: "Complete an N=3 n-back session scoring 60+." },
  { key: "rounds_100", name: "Century", description: "Play 100 game rounds across any game." },
  { key: "syllogism_20", name: "Logic sprinter", description: "20 correct syllogisms in a single day." },
  { key: "level_5", name: "Leveled up", description: "Reach level 5." },
];

const DEF_BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

/** Display name for an unlocked key; falls back to the key for retired ones. */
export function achievementName(key: string): string {
  return DEF_BY_KEY.get(key)?.name ?? key;
}

// ---------------------------------------------------------------------------
// Trigger map — which keys each activity can possibly unlock (§5.2).
// ---------------------------------------------------------------------------

const COMMON_KEYS = ["streak_7", "streak_30", "level_5"] as const;
const INTERVIEW_KEYS = [
  "first_interview",
  "filler_under_2",
  "delivery_90",
  "star_complete",
  "all_categories",
] as const;
const GAME_KEYS = ["rounds_100"] as const;
const PER_GAME_KEYS: Partial<Record<GameType, string>> = {
  fallacy: "fallacy_dozen",
  nback: "nback_3",
  syllogism: "syllogism_20",
};

export interface AchievementEvalContext {
  pillar: "game" | "interview";
  gameType?: GameType;
  /** Per-attempt facts from the caller (scores, flags, category…). */
  attemptFacts: Record<string, unknown>;
  /** Current streak, computed by afterActivity() before evaluation. */
  streak: number;
  /** Level AFTER this activity's XP landed. */
  level: number;
}

/** Candidate keys for this activity per the static trigger map. */
export function candidateKeys(ctx: Pick<AchievementEvalContext, "pillar" | "gameType">): string[] {
  const keys: string[] =
    ctx.pillar === "interview" ? [...INTERVIEW_KEYS] : [...GAME_KEYS];
  if (ctx.pillar === "game" && ctx.gameType) {
    const perGame = PER_GAME_KEYS[ctx.gameType];
    if (perGame) keys.push(perGame);
  }
  keys.push(...COMMON_KEYS);
  return keys;
}

// ---------------------------------------------------------------------------
// Predicates — facts-only where possible, at most ONE query otherwise (§5.2).
// ---------------------------------------------------------------------------

function factNumber(facts: Record<string, unknown>, key: string): number | null {
  const v = facts[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function allCategoriesCovered(): Promise<boolean> {
  // One query: attempted prompt categories via the prompt_id FK embed.
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("interview_attempts")
    .select("interview_prompts(category)");
  if (error) throw new Error(`achievements all_categories read failed: ${error.message}`);

  // The FK embed is to-one (object) at runtime, but supabase-js infers an
  // array without generated DB types — normalize both shapes defensively.
  type EmbedRow = { interview_prompts: { category: string | null } | { category: string | null }[] | null };
  const seen = new Set<string>();
  for (const row of (data ?? []) as unknown as EmbedRow[]) {
    const embed = row.interview_prompts;
    const prompts = Array.isArray(embed) ? embed : embed ? [embed] : [];
    for (const p of prompts) {
      if (p.category) seen.add(p.category);
    }
  }
  return ["behavioral", "pitch", "technical", "negotiation"].every((c) => seen.has(c));
}

async function fallacyDozenMastered(): Promise<boolean> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("game_attempts")
    .select("fallacy_key, is_correct")
    .eq("game_type", "fallacy");
  if (error) throw new Error(`achievements fallacy_dozen read failed: ${error.message}`);

  const tallies = new Map<string, { correct: number; n: number }>();
  for (const r of (data ?? []) as { fallacy_key: string | null; is_correct: boolean | null }[]) {
    if (!r.fallacy_key) continue;
    const cur = tallies.get(r.fallacy_key) ?? { correct: 0, n: 0 };
    cur.n += 1;
    if (r.is_correct) cur.correct += 1;
    tallies.set(r.fallacy_key, cur);
  }
  return FALLACY_KEYS.every((key) => {
    const t = tallies.get(key);
    return !!t && t.n >= 5 && t.correct / t.n >= 0.8;
  });
}

async function hundredRoundsPlayed(): Promise<boolean> {
  const supabase = getServiceClient();
  const { count, error } = await supabase
    .from("game_attempts")
    .select("id", { count: "exact", head: true });
  if (error) throw new Error(`achievements rounds_100 read failed: ${error.message}`);
  return (count ?? 0) >= 100;
}

async function twentySyllogismsToday(): Promise<boolean> {
  const supabase = getServiceClient();
  const { count, error } = await supabase
    .from("game_attempts")
    .select("id", { count: "exact", head: true })
    .eq("game_type", "syllogism")
    .eq("local_day", todayLocal())
    .eq("is_correct", true);
  if (error) throw new Error(`achievements syllogism_20 read failed: ${error.message}`);
  return (count ?? 0) >= 20;
}

type Predicate = (ctx: AchievementEvalContext) => boolean | Promise<boolean>;

const PREDICATES: Record<string, Predicate> = {
  first_interview: (ctx) => ctx.pillar === "interview", // the attempt just recorded IS the first rep candidate
  streak_7: (ctx) => ctx.streak >= 7,
  streak_30: (ctx) => ctx.streak >= 30,
  filler_under_2: (ctx) => {
    const duration = factNumber(ctx.attemptFacts, "duration_sec");
    const fillerPerMin = factNumber(ctx.attemptFacts, "filler_per_min");
    return duration !== null && duration >= 60 && fillerPerMin !== null && fillerPerMin < 2.0;
  },
  delivery_90: (ctx) => (factNumber(ctx.attemptFacts, "overall_delivery_score") ?? 0) >= 90,
  star_complete: (ctx) => {
    const star = ctx.attemptFacts.star as
      | { situation?: unknown; task?: unknown; action?: unknown; result?: unknown }
      | null
      | undefined;
    return (
      !!star &&
      star.situation === true &&
      star.task === true &&
      star.action === true &&
      star.result === true
    );
  },
  all_categories: () => allCategoriesCovered(),
  fallacy_dozen: () => fallacyDozenMastered(),
  nback_3: (ctx) =>
    (factNumber(ctx.attemptFacts, "n") ?? 0) >= 3 &&
    (factNumber(ctx.attemptFacts, "score") ?? 0) >= 60,
  rounds_100: () => hundredRoundsPlayed(),
  syllogism_20: () => twentySyllogismsToday(),
  level_5: (ctx) => ctx.level >= 5,
};

// ---------------------------------------------------------------------------
// Evaluation + unlock persistence
// ---------------------------------------------------------------------------

export interface UnlockedAchievement {
  key: string;
  name: string;
}

/**
 * Evaluate this activity's candidate achievements and persist any new unlocks.
 * One `select key` skips already-unlocked keys; each remaining predicate costs
 * ≤1 query; unlocks land via upsert with ignoreDuplicates (`on conflict (key)
 * do nothing`) so a double-submit can never double-unlock. A single failing
 * predicate is logged and skipped — it must not sink the others.
 */
export async function evaluateAchievements(
  ctx: AchievementEvalContext,
): Promise<UnlockedAchievement[]> {
  const supabase = getServiceClient();

  const { data: unlockedRows, error: unlockedErr } = await supabase
    .from("achievements")
    .select("key");
  if (unlockedErr) {
    throw new Error(`achievements read failed: ${unlockedErr.message}`);
  }
  const unlocked = new Set(
    ((unlockedRows ?? []) as { key: string }[]).map((r) => r.key),
  );

  const candidates = candidateKeys(ctx).filter((k) => !unlocked.has(k));
  const newlyUnlocked: UnlockedAchievement[] = [];

  for (const key of candidates) {
    const predicate = PREDICATES[key];
    if (!predicate) continue;
    try {
      if (await predicate(ctx)) {
        newlyUnlocked.push({ key, name: achievementName(key) });
      }
    } catch (err) {
      // Best-effort per predicate: a flaky read must not sink the rest.
      console.warn(`[progression] achievement ${key} check failed: ${(err as Error)?.message}`);
    }
  }

  if (newlyUnlocked.length > 0) {
    const context = {
      pillar: ctx.pillar,
      game_type: ctx.gameType ?? null,
      streak: ctx.streak,
      level: ctx.level,
    };
    const { error: insertErr } = await supabase
      .from("achievements")
      .upsert(
        newlyUnlocked.map((a) => ({ key: a.key, context })),
        { onConflict: "key", ignoreDuplicates: true },
      );
    if (insertErr) {
      throw new Error(`achievements insert failed: ${insertErr.message}`);
    }
    console.info(`[progression] unlocked=${newlyUnlocked.map((a) => a.key).join(",")}`);
  }

  return newlyUnlocked;
}

export interface UnlockedRow {
  key: string;
  unlocked_at: string;
}

/** All unlock facts, oldest first — feeds the home/progress achievement strips. */
export async function getUnlockedAchievements(): Promise<UnlockedRow[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("achievements")
    .select("key, unlocked_at")
    .order("unlocked_at", { ascending: true });
  if (error) throw new Error(`achievements read failed: ${error.message}`);
  return (data ?? []) as UnlockedRow[];
}
