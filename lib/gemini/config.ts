import "server-only";

/**
 * Centralized Gemini model config (AI_DESIGN.md §4.1, §5).
 *
 * Model IDs drift — keeping them in ONE place means a re-verify against AI Studio
 * touches a single file. Both features use the same Flash model per AI_DESIGN.
 */

/** Model used for both voice feedback and fallacy batch generation. */
export const GEMINI_MODEL = "gemini-3.5-flash";

/** Server-side ceiling on a Gemini call. Audio → 60s (AI_DESIGN §1.8). */
export const VOICE_TIMEOUT_MS = 60_000;
/** Text batch generation ceiling. */
export const BATCH_TIMEOUT_MS = 45_000;

/** Retry policy — capped at 2 retries; retries burn the same quota (AI_DESIGN §1.8). */
export const MAX_RETRIES = 2;
export const BASE_BACKOFF_MS = 1_000;

/**
 * Structured error for the Gemini boundary. `kind` lets Route Handlers map to the
 * right HTTP status without string-matching:
 *   - "no_api_key"    → 500 config error (fail gracefully, never crash the build)
 *   - "rate_limited"  → 429 (quota exhausted / RESOURCE_EXHAUSTED)
 *   - "invalid_output"→ 502 (model returned non-conforming JSON after retry)
 *   - "failed"        → 502 (transient/5xx/timeout/other)
 */
export type GeminiErrorKind =
  | "no_api_key"
  | "rate_limited"
  | "invalid_output"
  | "failed";

export class GeminiError extends Error {
  readonly kind: GeminiErrorKind;
  readonly detail?: string;
  constructor(kind: GeminiErrorKind, message: string, detail?: string) {
    super(message);
    this.name = "GeminiError";
    this.kind = kind;
    this.detail = detail;
  }
}
