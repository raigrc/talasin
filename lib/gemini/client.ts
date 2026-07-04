import "server-only";
import { GoogleGenAI } from "@google/genai";
import { optionalEnv } from "../env";
import {
  GEMINI_MODEL,
  VOICE_TIMEOUT_MS,
  BATCH_TIMEOUT_MS,
  MAX_RETRIES,
  BASE_BACKOFF_MS,
  GeminiError,
} from "./config";
import {
  voiceModelSchema,
  voiceStarModelSchema,
  fallacyBatchSchema,
  selfCritiqueSchema,
  VOICE_RESPONSE_SCHEMA,
  VOICE_STAR_RESPONSE_SCHEMA,
  FALLACY_BATCH_RESPONSE_SCHEMA,
  SELF_CRITIQUE_RESPONSE_SCHEMA,
  difficultyToInt,
  type InterviewFeedback,
  type GeneratedRound,
  type FallacyKey,
} from "./schemas";
import {
  VOICE_SYSTEM_PROMPT,
  VOICE_STAR_RUBRIC,
  voiceUserPrompt,
  FALLACY_SYSTEM_PROMPT,
  fallacyUserPrompt,
  SELF_CRITIQUE_SYSTEM_PROMPT,
  selfCritiqueUserPrompt,
  type BatchPromptOpts,
} from "./prompts";
import type { PromptCategory } from "../supabase/types";

/**
 * The app ↔ Gemini boundary (DESIGN.md §3.8). All calls are server-side, request
 * structured JSON output (responseSchema), are wrapped in a timeout, retry with
 * capped backoff, and Zod-validate the result before it can touch the DB.
 *
 * If GEMINI_API_KEY is absent, every function throws a typed GeminiError
 * (kind: "no_api_key") — it never crashes the build or the process.
 */

let cachedClient: GoogleGenAI | null = null;

/** Lazily build the client. Throws a typed error (not a crash) when the key is missing. */
function getClient(): GoogleGenAI {
  if (cachedClient) return cachedClient;
  const apiKey = optionalEnv("GEMINI_API_KEY");
  if (!apiKey) {
    throw new GeminiError(
      "no_api_key",
      "GEMINI_API_KEY is not set — AI features are unavailable.",
    );
  }
  cachedClient = new GoogleGenAI({ apiKey });
  return cachedClient;
}

/** True if the app has a Gemini key configured (used by UI to hide/disable AI actions). */
export function isGeminiConfigured(): boolean {
  return Boolean(optionalEnv("GEMINI_API_KEY"));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Recognize a quota / rate-limit error from the SDK/HTTP shape. */
function isRateLimit(err: unknown): boolean {
  const anyErr = err as { status?: number; code?: number; message?: string };
  const status = anyErr?.status ?? anyErr?.code;
  if (status === 429) return true;
  const msg = (anyErr?.message ?? String(err)).toUpperCase();
  return msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429") || msg.includes("QUOTA");
}

/** Try to extract a server-provided retry delay (seconds) from a 429 error body. */
function retryDelayMs(err: unknown): number | null {
  const msg = (err as { message?: string })?.message ?? String(err);
  const m = msg.match(/retry(?:Delay)?["\s:]+["']?(\d+)(?:\.\d+)?s/i);
  if (m) return Number(m[1]) * 1000;
  return null;
}

interface RunOpts {
  timeoutMs: number;
  systemInstruction: string;
  userText: string;
  responseSchema: unknown;
  temperature: number;
  inlineAudio?: { mimeType: string; base64: string };
  label: string;
}

/**
 * Execute one generateContent call with timeout + capped backoff. Returns the raw
 * JSON text. Classifies failures into GeminiError kinds.
 */
async function runStructured(opts: RunOpts): Promise<string> {
  const client = getClient();

  const parts: Array<Record<string, unknown>> = [];
  if (opts.inlineAudio) {
    parts.push({
      inlineData: { mimeType: opts.inlineAudio.mimeType, data: opts.inlineAudio.base64 },
    });
  }
  parts.push({ text: opts.userText });

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const started = Date.now();
    try {
      const res = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts }],
        config: {
          systemInstruction: opts.systemInstruction,
          responseMimeType: "application/json",
          responseSchema: opts.responseSchema,
          temperature: opts.temperature,
          abortSignal: controller.signal,
        },
      });
      clearTimeout(timer);

      const text = res.text;
      // Log latency + token usage for the quota budget (no transcript/audio) (§8).
      const usage = res.usageMetadata;
      console.info(
        `[gemini] ${opts.label} ok in ${Date.now() - started}ms tokens=${usage?.totalTokenCount ?? "?"}`,
      );
      if (!text || text.trim().length === 0) {
        throw new GeminiError("invalid_output", `${opts.label}: empty model response`);
      }
      return text;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err instanceof GeminiError) throw err; // no_api_key etc. — don't retry

      const rateLimited = isRateLimit(err);
      console.warn(
        `[gemini] ${opts.label} attempt ${attempt + 1} failed (${rateLimited ? "rate_limited" : "error"}): ${
          (err as Error)?.message ?? err
        }`,
      );

      if (attempt < MAX_RETRIES) {
        const serverDelay = rateLimited ? retryDelayMs(err) : null;
        const backoff =
          serverDelay ??
          BASE_BACKOFF_MS * Math.pow(3, attempt) + Math.floor(Math.random() * 300);
        await sleep(backoff);
        continue;
      }
      // Exhausted retries.
      if (rateLimited) {
        throw new GeminiError(
          "rate_limited",
          "Gemini quota reached. Analysis resumes after the daily reset (midnight Pacific).",
          (err as Error)?.message,
        );
      }
      throw new GeminiError("failed", `${opts.label} failed`, (err as Error)?.message);
    }
  }
  // Unreachable, but satisfy the type checker.
  throw new GeminiError("failed", `${opts.label} failed`, String(lastErr));
}

/** Parse JSON, throwing invalid_output on failure. */
function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GeminiError("invalid_output", `${label}: model returned non-JSON`);
  }
}

// ===========================================================================
// PUBLIC: voice interview analysis (Wave 2 wires the UI to this)
// ===========================================================================

function countWords(transcript: string): number {
  return transcript.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Transcribe + score a spoken answer in ONE Gemini call (AI_DESIGN §1). WPM and
 * filler-per-minute are computed SERVER-SIDE from the trusted client duration,
 * never from the model (AI_DESIGN §1.4).
 *
 * Category selects the structure variant (DESIGN_V1.md §4.3): 'behavioral' →
 * the STAR rubric/schema; anything else → the light beginning/middle/end
 * heuristic. Still exactly one call either way; we always know which schema we
 * requested, so we Zod-parse with that exact variant (no union guessing).
 *
 * @param audio          raw audio bytes from the recorder
 * @param mimeType       e.g. "audio/webm;codecs=opus" or "audio/ogg;codecs=opus"
 * @param promptText     the interview prompt the user was answering (or null)
 * @param durationSeconds trusted, client-measured recording length (> 0)
 * @param category       the prompt's category (null for ad-hoc answers)
 */
export async function analyzeInterviewAudio(
  audio: ArrayBuffer,
  mimeType: string,
  promptText: string | null,
  durationSeconds: number,
  category: PromptCategory | null = null,
): Promise<InterviewFeedback> {
  if (!(durationSeconds > 0)) {
    // Duration is a required INPUT, never a model output (AI_DESIGN §1.4).
    throw new GeminiError("failed", "durationSeconds must be > 0");
  }

  const base64 = Buffer.from(audio).toString("base64");
  const useStar = category === "behavioral";

  // One low-temp retry with a stricter instruction on parse/validation failure
  // (AI_DESIGN §1.8) is handled by attempting parse+validate, and on failure
  // re-running once at temperature 0.
  const attemptOnce = async (temperature: number, extraInstruction = ""): Promise<InterviewFeedback> => {
    const text = await runStructured({
      timeoutMs: VOICE_TIMEOUT_MS,
      systemInstruction:
        VOICE_SYSTEM_PROMPT + (useStar ? VOICE_STAR_RUBRIC : "") + extraInstruction,
      userText: voiceUserPrompt(promptText),
      responseSchema: useStar ? VOICE_STAR_RESPONSE_SCHEMA : VOICE_RESPONSE_SCHEMA,
      temperature,
      inlineAudio: { mimeType, base64 },
      label: "voice",
    });
    // Parse with the exact variant we requested — never union-guess (§4.3).
    const parsed = (useStar ? voiceStarModelSchema : voiceModelSchema).safeParse(
      parseJson(text, "voice"),
    );
    if (!parsed.success) {
      throw new GeminiError("invalid_output", "voice: JSON did not match schema");
    }
    const model = parsed.data;

    // Authoritative server math (AI_DESIGN §1.4 / §1.7).
    const serverWordCount = countWords(model.transcript);
    const minutes = durationSeconds / 60;
    const wpm = minutes > 0 ? Math.round(serverWordCount / minutes) : 0;
    const fillerPerMin =
      minutes > 0 ? Math.round((model.filler_words.count / minutes) * 10) / 10 : 0;
    const confidence: "high" | "low" =
      serverWordCount > 0 &&
      Math.abs(serverWordCount - model.word_count) / serverWordCount < 0.1
        ? "high"
        : "low";

    // Structure mapping: the STAR variant fills star/structure_score and derives
    // the legacy beginning/middle/end flags (Situation frames, Action is the
    // substance, Result closes) so the existing structure/structure_note fields
    // keep working unchanged; the light variant leaves star/structure_score null.
    const sa = model.structure_assessment;
    const star =
      "has_situation" in sa
        ? {
            situation: sa.has_situation,
            task: sa.has_task,
            action: sa.has_action,
            result: sa.has_result,
          }
        : null;
    const structure = star
      ? {
          has_beginning: star.situation,
          has_middle: star.action,
          has_end: star.result,
          note: sa.note,
        }
      : (sa as { has_beginning: boolean; has_middle: boolean; has_end: boolean; note: string });

    return {
      transcript: model.transcript,
      word_count: serverWordCount,
      filler_count: model.filler_words.count,
      filler_items: model.filler_words.items,
      filler_per_min: fillerPerMin,
      words_per_minute: wpm,
      clarity_score: model.clarity_score,
      structure,
      structure_note: sa.note,
      star,
      structure_score: "structure_score" in sa ? sa.structure_score : null,
      coaching: model.coaching,
      overall_delivery_score: model.overall_delivery_score,
      confidence,
      model: GEMINI_MODEL,
    };
  };

  try {
    return await attemptOnce(0.2);
  } catch (err) {
    if (err instanceof GeminiError && err.kind === "invalid_output") {
      // One retry at temperature 0 with a stricter instruction (AI_DESIGN §1.8).
      return await attemptOnce(0, "\n\nReturn ONLY the JSON object, nothing else.");
    }
    throw err;
  }
}

// ===========================================================================
// PUBLIC: fallacy batch generation (used by /api/game/topup and the seed script)
// ===========================================================================

export interface GenerateBatchResult {
  rounds: GeneratedRound[];
  needsReviewSummaries: Set<string>; // scenario_summaries flagged by self-critique
}

/**
 * Generate a batch of fallacy rounds in ONE Gemini call (AI_DESIGN §2.4), validate
 * each, shuffle option order, map to the app-side GeneratedRound shape, and
 * optionally run the self-critique pass to flag multi-fallacy items.
 */
export async function generateFallacyRounds(
  count: number,
  opts: {
    difficulty?: 1 | 2 | 3;
    fallacyKeys?: FallacyKey[];
    avoidSummaries?: string[];
    selfCritique?: boolean;
  } = {},
): Promise<GenerateBatchResult> {
  const promptOpts: BatchPromptOpts = {
    count,
    avoidSummaries: opts.avoidSummaries,
    distribution: buildDistribution(count, opts.difficulty, opts.fallacyKeys),
  };

  const text = await runStructured({
    timeoutMs: BATCH_TIMEOUT_MS,
    systemInstruction: FALLACY_SYSTEM_PROMPT,
    userText: fallacyUserPrompt(promptOpts),
    responseSchema: FALLACY_BATCH_RESPONSE_SCHEMA,
    temperature: 0.9, // variety across a batch (AI_DESIGN §2.1)
    label: "fallacy-batch",
  });

  const parsed = fallacyBatchSchema.safeParse(parseJson(text, "fallacy-batch"));
  if (!parsed.success) {
    throw new GeminiError("invalid_output", "fallacy-batch: JSON did not match schema");
  }

  // Validate each round per AI_DESIGN §2.8 guardrails, then map to app shape.
  const valid: GeneratedRound[] = [];
  const rawValid: { argument: string; correct_fallacy: FallacyKey; options: FallacyKey[]; scenario_summary: string }[] = [];

  for (const r of parsed.data.rounds) {
    const uniqueOptions = new Set(r.options);
    if (uniqueOptions.size !== 4) continue; // exactly 4 distinct
    if (!uniqueOptions.has(r.correct_fallacy)) continue; // correct ∈ options
    if (r.explanation.trim().length < 120) continue; // explanation sanity (§2.8)

    const shuffled = shuffle(r.options);
    valid.push({
      fallacy_key: r.correct_fallacy,
      argument_text: r.argument,
      scenario_summary: r.scenario_summary,
      choices: shuffled.map((k) => ({ key: k, label: labelFor(k) })),
      correct_key: r.correct_fallacy,
      explanation: r.explanation,
      difficulty: difficultyToInt(r.difficulty),
    });
    rawValid.push({
      argument: r.argument,
      correct_fallacy: r.correct_fallacy,
      options: shuffled,
      scenario_summary: r.scenario_summary,
    });
  }

  const needsReviewSummaries = new Set<string>();
  if (opts.selfCritique && rawValid.length > 0) {
    try {
      const critiqueText = await runStructured({
        timeoutMs: BATCH_TIMEOUT_MS,
        systemInstruction: SELF_CRITIQUE_SYSTEM_PROMPT,
        userText: selfCritiqueUserPrompt(rawValid),
        responseSchema: SELF_CRITIQUE_RESPONSE_SCHEMA,
        temperature: 0.1,
        label: "fallacy-critique",
      });
      const critique = selfCritiqueSchema.safeParse(parseJson(critiqueText, "fallacy-critique"));
      if (critique.success) {
        for (const v of critique.data.verdicts) {
          if (!v.single_fallacy && rawValid[v.index]) {
            needsReviewSummaries.add(rawValid[v.index].scenario_summary);
          }
        }
      }
    } catch (err) {
      // Self-critique is best-effort; a failure must not sink the whole batch.
      console.warn(`[gemini] self-critique skipped: ${(err as Error)?.message ?? err}`);
    }
  }

  return { rounds: valid, needsReviewSummaries };
}

// --- helpers ---------------------------------------------------------------

function buildDistribution(
  count: number,
  difficulty?: 1 | 2 | 3,
  fallacyKeys?: FallacyKey[],
): string {
  const parts: string[] = [];
  if (difficulty) {
    const label = difficulty === 1 ? "easy" : difficulty === 2 ? "medium" : "hard";
    parts.push(`Make all ${count} items difficulty "${label}".`);
  } else {
    parts.push(
      `Mix difficulties: roughly 30% easy, 50% medium, 20% hard across the ${count} items.`,
    );
  }
  if (fallacyKeys && fallacyKeys.length > 0) {
    parts.push(`Only use these correct fallacies: ${fallacyKeys.join(", ")}.`);
  } else {
    parts.push(
      "Cover at least 8 different fallacies; do not make more than 2 items share the same correct_fallacy.",
    );
  }
  return parts.join(" ");
}

/** Fisher-Yates shuffle (server-side, so option order isn't predictable). */
function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Human label for a fallacy key. Kept in sync with fallacy_types seed. */
const LABELS: Record<FallacyKey, string> = {
  strawman: "Straw Man",
  ad_hominem: "Ad Hominem",
  false_cause: "False Cause",
  appeal_to_authority: "Appeal to Authority",
  slippery_slope: "Slippery Slope",
  false_dilemma: "False Dilemma",
  hasty_generalization: "Hasty Generalization",
  circular_reasoning: "Circular Reasoning",
  appeal_to_emotion: "Appeal to Emotion",
  bandwagon: "Bandwagon",
  red_herring: "Red Herring",
  tu_quoque: "Tu Quoque",
};

function labelFor(key: FallacyKey): string {
  return LABELS[key];
}
