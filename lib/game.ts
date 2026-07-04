import "server-only";
import { getServiceClient } from "./supabase/server";
import { contentHash } from "./hash";
import { todayLocal } from "./day";
import { fallacyXp } from "./xp";
import type { FallacyRound, FallacyChoice } from "./supabase/types";
import type { GeneratedRound } from "./gemini/schemas";

/**
 * Server-side game data operations (DESIGN.md §3.3–§3.5, §5; DESIGN_V1.md §3.6).
 * Shared by the game Route Handlers (via lib/games/fallacy.ts) and the seed script.
 */

/** What the client is allowed to see for a round — NEVER correct_key/explanation. */
export interface PublicRound {
  id: string;
  argument_text: string;
  choices: FallacyChoice[];
  difficulty: number;
}

// Spaced-repetition weighting constants (DESIGN_V1.md §3.6): error rate with
// Laplace smoothing drifts unseen types toward a 0.3 prior; a type you always
// miss is ~4× more likely to be drawn than one you always get right.
const ERR_WINDOW = 200; // recency window of attempts feeding the error rates
const ERR_PRIOR_WRONG = 1.5;
const ERR_PRIOR_N = 5;
const ERR_WEIGHT_FACTOR = 3;

/**
 * Weighted random pick — pure and injectable for tests. Non-finite/negative
 * weights count as 0; if every weight is 0, falls back to a uniform pick.
 */
export function weightedPick<T>(
  items: T[],
  weights: number[],
  rand: () => number = Math.random,
): T | null {
  if (items.length === 0) return null;
  const safe = items.map((_, i) => {
    const w = weights[i];
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const total = safe.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return items[Math.floor(rand() * items.length)];

  let r = rand() * total;
  for (let i = 0; i < items.length; i++) {
    r -= safe[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1]; // float-rounding edge
}

/** Per-fallacy smoothed error rates from a recent-attempts window. */
function errorRates(
  rows: { fallacy_key: string | null; is_correct: boolean | null }[],
): Map<string, number> {
  const tallies = new Map<string, { wrong: number; n: number }>();
  for (const r of rows) {
    if (typeof r.fallacy_key !== "string" || r.fallacy_key.length === 0) continue;
    const cur = tallies.get(r.fallacy_key) ?? { wrong: 0, n: 0 };
    cur.n += 1;
    if (r.is_correct === false) cur.wrong += 1;
    tallies.set(r.fallacy_key, cur);
  }
  const rates = new Map<string, number>();
  for (const [key, t] of tallies) {
    rates.set(key, (t.wrong + ERR_PRIOR_WRONG) / (t.n + ERR_PRIOR_N));
  }
  return rates;
}

const PRIOR_ERR = ERR_PRIOR_WRONG / ERR_PRIOR_N; // 0.3 — types with no attempts yet

/**
 * Pick one active round not attempted today and not in `exclude`, weighted by
 * per-fallacy error rate (spaced repetition, DESIGN_V1.md §3.6): fallacy types
 * the user answers wrong resurface more often. Returns null when the unseen
 * pool is empty (exhausted). Correct answer is never included in the returned
 * object (anti-cheat, §3.3).
 */
export async function getNextRound(exclude: string[]): Promise<PublicRound | null> {
  const supabase = getServiceClient();
  const today = todayLocal();

  // Rounds already attempted today (so we don't repeat within a day).
  // Scoped to fallacy rows like the weighting query below — round_id is NULL
  // on other game types anyway (shape CHECK), but don't rely on that.
  const { data: attemptedRows, error: attemptedErr } = await supabase
    .from("game_attempts")
    .select("round_id")
    .eq("game_type", "fallacy")
    .eq("local_day", today);
  if (attemptedErr) throw new Error(`attempts read failed: ${attemptedErr.message}`);

  const seen = new Set<string>([
    ...exclude,
    ...(attemptedRows ?? []).map((r: { round_id: string }) => r.round_id),
  ]);

  // Fetch candidate active rounds (public fields + fallacy_key for weighting).
  // At a few hundred rows this is trivial; we filter `seen` in memory.
  const { data: rounds, error: roundsErr } = await supabase
    .from("fallacy_rounds")
    .select("id, argument_text, choices, difficulty, fallacy_key")
    .eq("status", "active");
  if (roundsErr) throw new Error(`rounds read failed: ${roundsErr.message}`);

  const pool = (rounds ?? []).filter(
    (r: { id: string }) => !seen.has(r.id),
  ) as Pick<
    FallacyRound,
    "id" | "argument_text" | "choices" | "difficulty" | "fallacy_key"
  >[];

  if (pool.length === 0) return null;

  // Recent per-fallacy accuracy window (one extra query, DESIGN_V1.md §3.6).
  const { data: recentRows, error: recentErr } = await supabase
    .from("game_attempts")
    .select("fallacy_key, is_correct")
    .eq("game_type", "fallacy")
    .order("created_at", { ascending: false })
    .limit(ERR_WINDOW);
  if (recentErr) throw new Error(`recent attempts read failed: ${recentErr.message}`);

  const rates = errorRates(
    (recentRows ?? []) as { fallacy_key: string | null; is_correct: boolean | null }[],
  );
  const weights = pool.map(
    (r) => 1 + ERR_WEIGHT_FACTOR * (rates.get(r.fallacy_key) ?? PRIOR_ERR),
  );

  const pick = weightedPick(pool, weights) ?? pool[0];
  return {
    id: pick.id,
    argument_text: pick.argument_text,
    choices: pick.choices,
    difficulty: pick.difficulty,
  };
}

export interface AnswerResult {
  is_correct: boolean;
  correct_key: string;
  explanation: string;
  fallacy_key: string;
  xp: number;
}

/**
 * Load a round's answer key server-side, compute correctness, and insert the
 * attempt (with v1 game_type/score/xp — DESIGN_V1.md §2.1, §5.1). Returns the
 * reveal payload. Does NOT touch daily_activity/streak — caller composes that
 * so it can report the streak (§3.4).
 */
export async function recordAnswer(
  roundId: string,
  chosenKey: string,
  answeredMs: number | null,
): Promise<AnswerResult | null> {
  const supabase = getServiceClient();

  const { data: round, error } = await supabase
    .from("fallacy_rounds")
    .select("id, correct_key, explanation, fallacy_key, difficulty")
    .eq("id", roundId)
    .maybeSingle();
  if (error) throw new Error(`round read failed: ${error.message}`);
  if (!round) return null;

  const isCorrect = chosenKey === round.correct_key;
  const xp = fallacyXp(isCorrect, round.difficulty);

  const { error: insErr } = await supabase.from("game_attempts").insert({
    game_type: "fallacy",
    round_id: round.id,
    chosen_key: chosenKey,
    is_correct: isCorrect,
    fallacy_key: round.fallacy_key,
    score: isCorrect ? 100 : 0,
    detail: null, // fallacy rows carry no per-game payload (DESIGN_V1.md §2.1)
    xp,
    answered_ms: answeredMs,
    local_day: todayLocal(),
  });
  if (insErr) throw new Error(`attempt insert failed: ${insErr.message}`);

  return {
    is_correct: isCorrect,
    correct_key: round.correct_key,
    explanation: round.explanation,
    fallacy_key: round.fallacy_key,
    xp,
  };
}

export interface InsertBatchResult {
  generated: number;
  inserted: number;
  skipped_duplicates: number;
}

/**
 * Insert a batch of generated rounds with dedup on content_hash (§3.5/§5).
 * `needsReviewSummaries` marks rounds flagged by the self-critique pass — those
 * are stored with status 'needs_review' so they are never served (§2.8).
 * Uses upsert with ignoreDuplicates so re-runs are safe.
 */
export async function insertGeneratedRounds(
  rounds: GeneratedRound[],
  batchId: string,
  model: string,
  needsReviewSummaries: Set<string>,
): Promise<InsertBatchResult> {
  const supabase = getServiceClient();
  if (rounds.length === 0) {
    return { generated: 0, inserted: 0, skipped_duplicates: 0 };
  }

  // Dedup within the batch itself first (same content_hash appearing twice).
  const byHash = new Map<
    string,
    {
      fallacy_key: string;
      argument_text: string;
      choices: FallacyChoice[];
      correct_key: string;
      explanation: string;
      difficulty: number;
      content_hash: string;
      gen_batch_id: string;
      gen_model: string;
      status: string;
    }
  >();

  for (const r of rounds) {
    const hash = contentHash(r.argument_text);
    if (byHash.has(hash)) continue;
    byHash.set(hash, {
      fallacy_key: r.fallacy_key,
      argument_text: r.argument_text,
      choices: r.choices,
      correct_key: r.correct_key,
      explanation: r.explanation,
      difficulty: r.difficulty,
      content_hash: hash,
      gen_batch_id: batchId,
      gen_model: model,
      status: needsReviewSummaries.has(r.scenario_summary) ? "needs_review" : "active",
    });
  }

  const rows = [...byHash.values()];

  // Upsert on content_hash, ignoring duplicates already in the DB. `count` on
  // the response tells us how many rows were actually written.
  const { data, error } = await supabase
    .from("fallacy_rounds")
    .upsert(rows, { onConflict: "content_hash", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(`round insert failed: ${error.message}`);

  const inserted = data?.length ?? 0;
  return {
    generated: rounds.length,
    inserted,
    skipped_duplicates: rounds.length - inserted,
  };
}

export interface PoolStatus {
  total: number;
  by_status: Record<string, number>;
  /** Active rounds only, keyed by difficulty ("1" | "2" | "3"). */
  active_by_difficulty: Record<string, number>;
  /** Active rounds not yet attempted today (what's left to serve). */
  unseen_today: number;
}

/**
 * Fallacy content-pool status for the admin top-up panel (DESIGN_V1.md §4.7;
 * page ships in Wave C). Two cheap reads, aggregated in TS.
 */
export async function getPoolStatus(): Promise<PoolStatus> {
  const supabase = getServiceClient();

  const { data: rounds, error: roundsErr } = await supabase
    .from("fallacy_rounds")
    .select("id, status, difficulty");
  if (roundsErr) throw new Error(`pool read failed: ${roundsErr.message}`);

  const { data: attempted, error: attemptedErr } = await supabase
    .from("game_attempts")
    .select("round_id")
    .eq("game_type", "fallacy")
    .eq("local_day", todayLocal());
  if (attemptedErr) throw new Error(`attempts read failed: ${attemptedErr.message}`);

  const seenToday = new Set(
    (attempted ?? [])
      .map((r: { round_id: string | null }) => r.round_id)
      .filter((id): id is string => typeof id === "string"),
  );

  const all = (rounds ?? []) as Pick<FallacyRound, "id" | "status" | "difficulty">[];
  const byStatus: Record<string, number> = {};
  const activeByDifficulty: Record<string, number> = {};
  let unseenToday = 0;

  for (const r of all) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    if (r.status === "active") {
      const d = String(r.difficulty);
      activeByDifficulty[d] = (activeByDifficulty[d] ?? 0) + 1;
      if (!seenToday.has(r.id)) unseenToday += 1;
    }
  }

  return {
    total: all.length,
    by_status: byStatus,
    active_by_difficulty: activeByDifficulty,
    unseen_today: unseenToday,
  };
}

/** Read the most recent scenario summaries to feed Gemini as "avoid these" context. */
export async function recentScenarioSummaries(limit = 50): Promise<string[]> {
  // scenario_summary is not persisted to fallacy_rounds (the schema stores
  // argument_text + content_hash). We approximate the dedup context with recent
  // argument_text snippets, which the prompt treats as "already-used scenarios".
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("fallacy_rounds")
    .select("argument_text")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`recent summaries read failed: ${error.message}`);
  return (data ?? []).map((r: { argument_text: string }) =>
    r.argument_text.slice(0, 90),
  );
}
