import { NextResponse } from "next/server";
import { requireSession, UnauthorizedError } from "@/lib/session";
import { analyzeInterviewAudio } from "@/lib/gemini/client";
import { GeminiError } from "@/lib/gemini/config";
import {
  getPromptById,
  insertInterviewAttempt,
  getPreviousComparableAttempt,
  type PreviousAttempt,
} from "@/lib/interview";
import { afterActivity } from "@/lib/progression";
import { INTERVIEW_XP } from "@/lib/xp";
import type { PromptCategory } from "@/lib/supabase/types";

/**
 * POST /api/interview/feedback (DESIGN.md §3.6; v2 per DESIGN_V1.md §4.3) —
 * multipart audio in, structured feedback out. The prompt's category selects
 * the Gemini structure variant (behavioral → STAR rubric) — still exactly ONE
 * call per attempt. Response adds the additive v1 fields: star /
 * structure_score, the previous-comparable-attempt delta payload, and the
 * gamification fields from afterActivity().
 *
 * Path note: DESIGN §3.6 and AI_DESIGN §1.3 disagree on the path
 * (/api/interview/feedback vs /api/voice/analyze). We use
 * /api/interview/feedback per the Wave 2 brief.
 *
 * Transcribe-then-discard: the audio ArrayBuffer is read into memory, handed to
 * the Gemini boundary, and then goes out of scope. It is NEVER written to the DB
 * or to Storage (there is no audio column and no bucket — DESIGN §2.5).
 */

// Ceiling on the Gemini audio call is 60s (AI_DESIGN §1.8); give the function
// headroom over that for upload + insert. Vercel reads this from the build output.
export const maxDuration = 90;

// A 2-min mono Opus clip is well under 0.5 MB (AI_DESIGN §1.2); even a WAV
// fallback for 2 min mono is a few MB. Cap generously but far under Gemini's
// 20 MB inline limit so we never need the Files API.
const MAX_AUDIO_BYTES = 12 * 1024 * 1024; // 12 MB
// Below this the clip is empty/near-silent — reject before spending a request.
const MIN_AUDIO_BYTES = 1024; // 1 KB
// The recorder hard-caps at 120s; allow a little slack for measurement jitter.
const MAX_DURATION_SEC = 130;
const MIN_DURATION_SEC = 1;

// Only accept the audio MIME types Gemini understands (or the codecs browsers
// actually emit that map to them). We pass the browser mime straight through.
const ACCEPTED_MIME_PREFIXES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/flac",
  "audio/aiff",
];

function isAcceptedMime(mime: string): boolean {
  const m = mime.toLowerCase();
  return ACCEPTED_MIME_PREFIXES.some((p) => m.startsWith(p));
}

export async function POST(request: Request) {
  // 1) Auth.
  try {
    await requireSession();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  // 2) Parse multipart body.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const audio = form.get("audio");
  const durationRaw = form.get("duration_sec");
  const promptIdRaw = form.get("prompt_id");

  if (!(audio instanceof Blob)) {
    return NextResponse.json({ error: "missing audio" }, { status: 400 });
  }

  // Duration is a REQUIRED input, never a model output (AI_DESIGN §1.4).
  const durationSeconds = Number(durationRaw);
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds < MIN_DURATION_SEC ||
    durationSeconds > MAX_DURATION_SEC
  ) {
    return NextResponse.json({ error: "invalid duration" }, { status: 400 });
  }

  // 3) Size + type guards (413 on oversize, 400 on empty/wrong type).
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: "audio too large", code: "audio_too_large" },
      { status: 413 },
    );
  }
  if (audio.size < MIN_AUDIO_BYTES) {
    return NextResponse.json(
      { error: "recording too short or empty", code: "empty_audio" },
      { status: 400 },
    );
  }

  // MediaRecorder mime may carry a codecs= suffix; strip it for Gemini which
  // wants the bare type, but keep the container type.
  const rawMime = audio.type || "audio/webm";
  const mimeType = rawMime.split(";")[0].trim() || "audio/webm";
  if (!isAcceptedMime(rawMime)) {
    return NextResponse.json(
      { error: "unsupported audio format", code: "unsupported_format" },
      { status: 400 },
    );
  }

  // 4) Validate the optional prompt_id and fetch its text + category — the
  //    category picks the structure variant (behavioral → STAR, §4.3).
  let promptId: string | null = null;
  let promptText: string | null = null;
  let promptCategory: PromptCategory | null = null;
  if (typeof promptIdRaw === "string" && promptIdRaw.length > 0) {
    try {
      const prompt = await getPromptById(promptIdRaw);
      if (prompt) {
        promptId = prompt.id;
        promptText = prompt.prompt_text;
        promptCategory = (prompt.category as PromptCategory | null) ?? null;
      }
      // Unknown/retired prompt id → treat as ad-hoc (promptId stays null).
    } catch (err) {
      console.error("[interview/feedback] prompt lookup", (err as Error)?.message);
      return NextResponse.json({ error: "server_error" }, { status: 500 });
    }
  }

  // 5) Read bytes → analyze → DISCARD. The ArrayBuffer is never persisted; it
  //    falls out of scope when this handler returns.
  let audioBuffer: ArrayBuffer;
  try {
    audioBuffer = await audio.arrayBuffer();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    const feedback = await analyzeInterviewAudio(
      audioBuffer,
      mimeType,
      promptText,
      durationSeconds,
      promptCategory,
    );

    // Delta strip: the previous comparable attempt (same prompt → same
    // category → null), fetched BEFORE the new row is inserted (§4.3).
    // Best-effort — a read hiccup must not sink an already-paid Gemini call.
    let previous: PreviousAttempt | null = null;
    try {
      previous = await getPreviousComparableAttempt(promptId, promptCategory);
    } catch (err) {
      console.error("[interview/feedback] previous lookup", (err as Error)?.message);
    }

    // Nothing is written until analysis succeeds — no half-written rows (§8).
    const attemptId = await insertInterviewAttempt(feedback, promptId, durationSeconds);
    const activity = await afterActivity({
      pillar: "interview",
      xpAwarded: INTERVIEW_XP,
      attemptFacts: {
        category: promptCategory,
        duration_sec: durationSeconds,
        filler_per_min: feedback.filler_per_min,
        overall_delivery_score: feedback.overall_delivery_score,
        star: feedback.star,
        structure_score: feedback.structure_score,
      },
    });

    return NextResponse.json({
      attempt_id: attemptId,
      transcript: feedback.transcript,
      word_count: feedback.word_count,
      filler_count: feedback.filler_count,
      filler_items: feedback.filler_items,
      filler_per_min: feedback.filler_per_min,
      words_per_minute: feedback.words_per_minute,
      clarity_score: feedback.clarity_score,
      structure: feedback.structure,
      structure_note: feedback.structure_note,
      coaching: feedback.coaching,
      overall_delivery_score: feedback.overall_delivery_score,
      confidence: feedback.confidence,
      streak: activity.streak,
      // additive v1 fields (DESIGN_V1.md §4.3)
      star: feedback.star ?? null,
      structure_score: feedback.structure_score ?? null,
      previous,
      xp_awarded: activity.xpAwarded,
      xp_total: activity.xpTotal,
      level: activity.level,
      new_achievements: activity.newAchievements,
    });
  } catch (err) {
    if (err instanceof GeminiError) {
      // Map typed errors to HTTP status without string-matching (config.ts).
      const status =
        err.kind === "rate_limited"
          ? 429
          : err.kind === "no_api_key"
            ? 500
            : 502; // invalid_output / failed / timeout
      const code =
        err.kind === "rate_limited"
          ? "gemini_rate_limited"
          : err.kind === "no_api_key"
            ? "no_api_key"
            : "gemini_failed";
      console.error(`[interview/feedback] gemini ${err.kind}: ${err.detail ?? err.message}`);
      // Return only the stable error code — never leak err.message to the client.
      return NextResponse.json({ error: code }, { status });
    }
    console.error("[interview/feedback]", (err as Error)?.message);
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
