/**
 * Row shapes for the Talasin tables (schema.sql / DESIGN.md §2, DESIGN_V1.md §2).
 * Plain types — safe to import anywhere. No secrets here.
 */

export interface FallacyChoice {
  key: string;
  label: string;
}

export type RoundStatus = "active" | "retired" | "needs_review";

export interface FallacyRound {
  id: string;
  fallacy_key: string;
  argument_text: string;
  choices: FallacyChoice[];
  correct_key: string;
  explanation: string;
  difficulty: number;
  content_hash: string;
  gen_batch_id: string | null;
  gen_model: string | null;
  status: RoundStatus;
  created_at: string;
}

export interface FallacyType {
  key: string;
  label: string;
  short_def: string;
  sort_order: number | null;
}

/**
 * One row per answered round of ANY game type (DESIGN_V1.md §2.1). The four
 * fallacy-shaped columns are null for token-served games (nback/syllogism);
 * per-game variance lives in `detail`.
 */
export interface GameAttempt {
  id: string;
  game_type: string;
  round_id: string | null;
  chosen_key: string | null;
  is_correct: boolean | null;
  fallacy_key: string | null;
  score: number | null; // 0..100 normalized
  detail: Record<string, unknown> | null;
  xp: number;
  answered_ms: number | null;
  local_day: string;
  created_at: string;
}

export type PromptCategory = "behavioral" | "pitch" | "technical" | "negotiation";

export interface InterviewPrompt {
  id: string;
  prompt_text: string;
  category: PromptCategory | null;
  status: "active" | "retired";
  created_at: string;
}

export interface InterviewAttempt {
  id: string;
  prompt_id: string | null;
  transcript: string;
  filler_count: number;
  words_per_minute: number | null;
  clarity_score: number | null;
  overall_delivery_score: number | null;
  structure_note: string | null;
  coaching: string | null;
  duration_sec: number | null;
  star_situation: boolean | null;
  star_task: boolean | null;
  star_action: boolean | null;
  star_result: boolean | null;
  structure_score: number | null; // 0..100, behavioral prompts only
  xp: number;
  local_day: string;
  created_at: string;
  pronunciation_score: number | null;
  accent_label: string | null;
  problem_sound_categories: string[] | null;
}

export interface DailyActivity {
  local_day: string;
  game_count: number;
  interview_count: number;
  updated_at: string;
}

/** Unlock facts only — the catalog (names/predicates) lives in lib/achievements.ts. */
export interface AchievementRow {
  key: string;
  unlocked_at: string;
  context: Record<string, unknown> | null;
}

export interface LoginAttemptRow {
  id: number;
  ip: string;
  success: boolean;
  attempted_at: string;
}
