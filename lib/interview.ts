import "server-only";
import { getServiceClient } from "./supabase/server";
import { todayLocal } from "./day";
import { INTERVIEW_XP } from "./xp";
import type { InterviewFeedback, StarFlags } from "./gemini/schemas";

/**
 * Server-side interview data operations (DESIGN.md §2.4, §2.5, §3.6).
 *
 * Transcribe-then-discard: NOTHING here ever writes audio. We only persist the
 * transcript + numeric scores. There is no audio column, bytea, or storage path
 * anywhere in this project (DESIGN.md §2.5).
 */

/** Minimal prompt shape the interview UI needs. */
export interface Prompt {
  id: string;
  prompt_text: string;
  category: string | null;
}

/**
 * Fetch all active interview prompts (small seeded list). The page/route rotate
 * through them client-side and pick a fresh one. At a dozen rows this single read
 * is trivial and lets the client swap prompts without another round-trip.
 */
export async function getActivePrompts(): Promise<Prompt[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("interview_prompts")
    .select("id, prompt_text, category")
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`interview_prompts read failed: ${error.message}`);
  return (data ?? []) as Prompt[];
}

/** Fetch a single active prompt by id (validates the client-supplied prompt_id). */
export async function getPromptById(id: string): Promise<Prompt | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("interview_prompts")
    .select("id, prompt_text, category")
    .eq("id", id)
    .eq("status", "active")
    .maybeSingle();
  if (error) throw new Error(`interview_prompt read failed: ${error.message}`);
  return (data as Prompt | null) ?? null;
}

/**
 * Persist one interview attempt (transcript + scores ONLY — DESIGN.md §2.5) and
 * return the new attempt id. `coaching` (an array in the feedback) is stored as a
 * single newline-joined text blob to match the `coaching text` column.
 * v1 (DESIGN_V1.md §2.3, §5.1): STAR flags + structure_score persist (NULL for
 * non-behavioral) and the flat interview XP is written on the row.
 */
export async function insertInterviewAttempt(
  feedback: InterviewFeedback,
  promptId: string | null,
  durationSeconds: number,
): Promise<string> {
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from("interview_attempts")
    .insert({
      prompt_id: promptId,
      transcript: feedback.transcript,
      filler_count: feedback.filler_count,
      words_per_minute: feedback.words_per_minute,
      clarity_score: feedback.clarity_score,
      structure_note: feedback.structure_note,
      coaching: feedback.coaching.join("\n"),
      overall_delivery_score: feedback.overall_delivery_score,
      duration_sec: Math.round(durationSeconds * 10) / 10,
      star_situation: feedback.star?.situation ?? null,
      star_task: feedback.star?.task ?? null,
      star_action: feedback.star?.action ?? null,
      star_result: feedback.star?.result ?? null,
      structure_score: feedback.structure_score ?? null,
      xp: INTERVIEW_XP,
      local_day: todayLocal(),
    })
    .select("id")
    .single();

  if (error) throw new Error(`interview_attempt insert failed: ${error.message}`);
  return data.id as string;
}

// ===========================================================================
// v1 — attempt history / personal bests / delta strip (DESIGN_V1.md §4.5)
// ===========================================================================

/** One row of the /interview/history list (prompt joined in TS). */
export interface AttemptListItem {
  id: string;
  created_at: string;
  local_day: string;
  prompt_id: string | null; // for the "Retry this prompt" link
  prompt_text: string | null;
  category: string | null;
  overall_delivery_score: number | null;
  clarity_score: number | null;
  filler_count: number;
  duration_sec: number | null; // filler/min derived in the UI
  words_per_minute: number | null;
  structure_score: number | null;
  star: StarFlags | null;
  transcript: string;
}

const ATTEMPT_COLUMNS =
  "id, created_at, local_day, prompt_id, transcript, filler_count, duration_sec, " +
  "words_per_minute, clarity_score, overall_delivery_score, structure_score, " +
  "star_situation, star_task, star_action, star_result";

interface AttemptRowRaw {
  id: string;
  created_at: string;
  local_day: string;
  prompt_id: string | null;
  transcript: string;
  filler_count: number;
  duration_sec: number | null;
  words_per_minute: number | null;
  clarity_score: number | null;
  overall_delivery_score: number | null;
  structure_score: number | null;
  star_situation: boolean | null;
  star_task: boolean | null;
  star_action: boolean | null;
  star_result: boolean | null;
}

/** STAR columns → flags object; all-NULL (pre-v1 / non-behavioral) → null. */
function starFromRow(r: AttemptRowRaw): StarFlags | null {
  if (
    r.star_situation === null &&
    r.star_task === null &&
    r.star_action === null &&
    r.star_result === null
  ) {
    return null;
  }
  return {
    situation: r.star_situation === true,
    task: r.star_task === true,
    action: r.star_action === true,
    result: r.star_result === true,
  };
}

/**
 * Paged attempt history, newest first, optionally filtered by prompt category.
 * Prompt text/category are joined in TS from one small prompts read (~24 rows)
 * — the category filter then becomes a plain `in (prompt_ids)` on the attempts
 * page query, so pagination stays DB-side (`range` + exact count).
 */
export async function listAttempts(opts: {
  page: number;
  pageSize?: number;
  category?: string;
}): Promise<{ items: AttemptListItem[]; total: number }> {
  const supabase = getServiceClient();
  const pageSize = opts.pageSize ?? 10;
  const page = Math.max(1, Math.floor(opts.page) || 1);

  const { data: promptRows, error: promptErr } = await supabase
    .from("interview_prompts")
    .select("id, prompt_text, category");
  if (promptErr) throw new Error(`interview_prompts read failed: ${promptErr.message}`);

  const promptById = new Map<string, { prompt_text: string; category: string | null }>();
  for (const p of (promptRows ?? []) as Prompt[]) {
    promptById.set(p.id, { prompt_text: p.prompt_text, category: p.category });
  }

  let categoryIds: string[] | null = null;
  if (opts.category) {
    categoryIds = [...promptById.entries()]
      .filter(([, v]) => v.category === opts.category)
      .map(([id]) => id);
    if (categoryIds.length === 0) return { items: [], total: 0 };
  }

  const from = (page - 1) * pageSize;
  let query = supabase
    .from("interview_attempts")
    .select(ATTEMPT_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false });
  if (categoryIds) query = query.in("prompt_id", categoryIds);
  const { data, error, count } = await query.range(from, from + pageSize - 1);
  if (error) throw new Error(`interview_attempts read failed: ${error.message}`);

  const items: AttemptListItem[] = ((data ?? []) as unknown as AttemptRowRaw[]).map((r) => {
    const prompt = r.prompt_id ? promptById.get(r.prompt_id) : undefined;
    return {
      id: r.id,
      created_at: r.created_at,
      local_day: r.local_day,
      prompt_id: r.prompt_id,
      prompt_text: prompt?.prompt_text ?? null,
      category: prompt?.category ?? null,
      overall_delivery_score: r.overall_delivery_score,
      clarity_score: r.clarity_score,
      filler_count: r.filler_count,
      duration_sec: r.duration_sec,
      words_per_minute: r.words_per_minute,
      structure_score: r.structure_score,
      star: starFromRow(r),
      transcript: r.transcript,
    };
  });

  return { items, total: count ?? items.length };
}

export interface BestEntry {
  value: number;
  attempt_id: string;
  local_day: string;
}

export interface PersonalBests {
  best_delivery: BestEntry | null;
  best_clarity: BestEntry | null;
  /** MIN filler/min — only attempts with duration_sec ≥ 30 count (§4.5). */
  best_filler_per_min: BestEntry | null;
  /** MAX structure_score — behavioral attempts only (NULL = "not assessed"). */
  best_structure_score: BestEntry | null;
}

const BEST_FILLER_MIN_DURATION_SEC = 30;

/**
 * Personal bests across all attempts. One full read of the numeric columns
 * (consistent with the existing full-table-read pattern in stats.ts), maxima /
 * minima computed in TS. NULL metrics are "not assessed", never zero (§2.3).
 */
export async function getPersonalBests(): Promise<PersonalBests> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("interview_attempts")
    .select(
      "id, local_day, overall_delivery_score, clarity_score, filler_count, duration_sec, structure_score",
    );
  if (error) throw new Error(`interview_attempts read failed: ${error.message}`);

  interface BestsRow {
    id: string;
    local_day: string;
    overall_delivery_score: number | null;
    clarity_score: number | null;
    filler_count: number;
    duration_sec: number | null;
    structure_score: number | null;
  }

  let bestDelivery: BestEntry | null = null;
  let bestClarity: BestEntry | null = null;
  let bestFiller: BestEntry | null = null;
  let bestStructure: BestEntry | null = null;

  for (const r of (data ?? []) as BestsRow[]) {
    if (r.overall_delivery_score != null &&
        (!bestDelivery || r.overall_delivery_score > bestDelivery.value)) {
      bestDelivery = { value: r.overall_delivery_score, attempt_id: r.id, local_day: r.local_day };
    }
    if (r.clarity_score != null && (!bestClarity || r.clarity_score > bestClarity.value)) {
      bestClarity = { value: r.clarity_score, attempt_id: r.id, local_day: r.local_day };
    }
    if (r.duration_sec != null && r.duration_sec >= BEST_FILLER_MIN_DURATION_SEC) {
      const perMin = Math.round((r.filler_count / (r.duration_sec / 60)) * 10) / 10;
      if (!bestFiller || perMin < bestFiller.value) {
        bestFiller = { value: perMin, attempt_id: r.id, local_day: r.local_day };
      }
    }
    if (r.structure_score != null && (!bestStructure || r.structure_score > bestStructure.value)) {
      bestStructure = { value: r.structure_score, attempt_id: r.id, local_day: r.local_day };
    }
  }

  return {
    best_delivery: bestDelivery,
    best_clarity: bestClarity,
    best_filler_per_min: bestFiller,
    best_structure_score: bestStructure,
  };
}

/** What the "vs your last attempt" delta strip needs (DESIGN_V1.md §4.3). */
export interface PreviousAttempt {
  attempt_id: string;
  created_at: string;
  overall_delivery_score: number | null;
  clarity_score: number | null;
  filler_per_min: number | null;
  words_per_minute: number | null;
}

interface PreviousRowRaw {
  id: string;
  created_at: string;
  overall_delivery_score: number | null;
  clarity_score: number | null;
  filler_count: number;
  duration_sec: number | null;
  words_per_minute: number | null;
}

function toPrevious(r: PreviousRowRaw): PreviousAttempt {
  const dur = r.duration_sec ?? 0;
  return {
    attempt_id: r.id,
    created_at: r.created_at,
    overall_delivery_score: r.overall_delivery_score,
    clarity_score: r.clarity_score,
    filler_per_min: dur > 0 ? Math.round((r.filler_count / (dur / 60)) * 10) / 10 : null,
    words_per_minute: r.words_per_minute,
  };
}

const PREVIOUS_COLUMNS =
  "id, created_at, overall_delivery_score, clarity_score, filler_count, duration_sec, words_per_minute";

/**
 * Most recent prior comparable attempt for the feedback delta strip: same
 * prompt first; if none, most recent in the same category; else null. MUST be
 * called BEFORE the new attempt row is inserted (§4.3).
 */
export async function getPreviousComparableAttempt(
  promptId: string | null,
  category: string | null,
): Promise<PreviousAttempt | null> {
  const supabase = getServiceClient();

  if (promptId) {
    const { data, error } = await supabase
      .from("interview_attempts")
      .select(PREVIOUS_COLUMNS)
      .eq("prompt_id", promptId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`interview_attempts read failed: ${error.message}`);
    const row = ((data ?? []) as unknown as PreviousRowRaw[])[0];
    if (row) return toPrevious(row);
  }

  if (category) {
    const { data: promptRows, error: promptErr } = await supabase
      .from("interview_prompts")
      .select("id")
      .eq("category", category);
    if (promptErr) throw new Error(`interview_prompts read failed: ${promptErr.message}`);
    const ids = ((promptRows ?? []) as { id: string }[]).map((p) => p.id);
    if (ids.length === 0) return null;

    const { data, error } = await supabase
      .from("interview_attempts")
      .select(PREVIOUS_COLUMNS)
      .in("prompt_id", ids)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`interview_attempts read failed: ${error.message}`);
    const row = ((data ?? []) as unknown as PreviousRowRaw[])[0];
    if (row) return toPrevious(row);
  }

  return null;
}
