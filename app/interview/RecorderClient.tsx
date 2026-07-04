"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FeedbackView, type Feedback } from "./FeedbackView";
import { savePending } from "./pendingStore";
import type { Prompt } from "@/lib/interview";
import {
  INTERVIEW_CATEGORIES,
  CATEGORY_LABELS,
  categoryLabel,
  type InterviewCategoryKey,
} from "@/lib/interviewCategories";

/**
 * Voice interview recorder (DESIGN.md §3.6, AI_DESIGN §1.2; v2 per
 * DESIGN_V1.md §4.5: category chips filter the already-loaded prompt list
 * client-side, `initialPromptId` supports the retry-same-prompt deep link,
 * and the feedback screen keeps the same prompt on "Retry this prompt").
 *
 * - MediaRecorder, mono/low-bitrate, HARD 120s cap, live timer.
 * - Measures TRUE recording duration client-side (start/stop timestamps) and
 *   sends it with the audio — the server computes WPM from it (AI_DESIGN §1.4).
 * - In-browser playback before submit; reject empty/near-silent clips.
 * - On a 429 (quota) response, stashes the blob in IndexedDB and tells the user
 *   to retry after the Pacific-midnight reset (AI_DESIGN §1.8) — no silent loss.
 */

type CategoryFilter = "all" | InterviewCategoryKey;

const MAX_SECONDS = 120; // hard cap (AI_DESIGN §1.2)
const MIN_SECONDS = 3; // reject clips shorter than this (AI_DESIGN §1.2)
const MIN_BYTES = 1024; // reject empty blobs
const AUDIO_BITS_PER_SECOND = 32_000; // ~32 kbps mono keeps the clip tiny

type Phase =
  | "idle" // ready, mic not yet acquired
  | "requesting" // asking for mic permission
  | "denied" // permission denied — show re-permission UI
  | "recording"
  | "recorded" // stopped, blob ready for playback/submit
  | "analyzing"
  | "feedback"
  | "quota" // 429 — stashed to IndexedDB
  | "error";

/** Pick a supported low-bitrate, Gemini-accepted mime for MediaRecorder. */
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/ogg;codecs=opus",
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4", // Safari/iOS
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* isTypeSupported can throw on some engines — keep trying */
    }
  }
  return ""; // let the browser choose its default
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function RecorderClient({
  prompts,
  initialPromptId,
  initialCategory,
}: {
  prompts: Prompt[];
  initialPromptId?: string;
  initialCategory?: InterviewCategoryKey;
}) {
  const [category, setCategory] = useState<CategoryFilter>(initialCategory ?? "all");
  const visiblePrompts = useMemo(
    () => (category === "all" ? prompts : prompts.filter((p) => p.category === category)),
    [prompts, category],
  );
  const [promptIdx, setPromptIdx] = useState(() => {
    if (!initialPromptId) return 0;
    const list = initialCategory
      ? prompts.filter((p) => p.category === initialCategory)
      : prompts;
    const idx = list.findIndex((p) => p.id === initialPromptId);
    return idx >= 0 ? idx : 0;
  });
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0); // seconds, live during recording
  const [recordedDuration, setRecordedDuration] = useState(0); // seconds, for display after stop
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [streak, setStreak] = useState<number | null>(null);
  const [supported] = useState(
    () =>
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== "undefined",
  );

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef<number>(0); // ms, for true duration
  const durationRef = useRef<number>(0); // measured seconds
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blobRef = useRef<Blob | null>(null);
  const mimeRef = useRef<string>("");

  const prompt = visiblePrompts[promptIdx] ?? visiblePrompts[0] ?? null;
  const hasPrompts = prompts.length > 0;

  // --- cleanup helpers ------------------------------------------------------
  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const clearTimers = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (capTimerRef.current) clearTimeout(capTimerRef.current);
    timerRef.current = null;
    capTimerRef.current = null;
  }, []);

  // Revoke the object URL when it changes / on unmount to avoid leaks.
  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  // Full teardown on unmount.
  useEffect(() => {
    return () => {
      clearTimers();
      stopStream();
    };
  }, [clearTimers, stopStream]);

  const resetRecording = useCallback(() => {
    clearTimers();
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);
    blobRef.current = null;
    chunksRef.current = [];
    durationRef.current = 0;
    setElapsed(0);
    setRecordedDuration(0);
    setError(null);
    setFeedback(null);
  }, [audioUrl, clearTimers]);

  // --- recording ------------------------------------------------------------
  const stopRecording = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      // Capture true duration at stop from the wall-clock start timestamp.
      durationRef.current = (Date.now() - startedAtRef.current) / 1000;
      mr.stop();
    }
    clearTimers();
  }, [clearTimers]);

  const startRecording = useCallback(async () => {
    setError(null);
    setFeedback(null);
    setPhase("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1, // mono keeps the clip tiny
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPhase("denied");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setError("No microphone found. Connect a mic and try again.");
        setPhase("error");
      } else {
        setError("Could not access the microphone. Try again.");
        setPhase("error");
      }
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];
    const mimeType = pickMimeType();
    mimeRef.current = mimeType;

    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(
        stream,
        mimeType
          ? { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND }
          : { audioBitsPerSecond: AUDIO_BITS_PER_SECOND },
      );
    } catch {
      stopStream();
      setError("Recording is not supported in this browser.");
      setPhase("error");
      return;
    }
    mediaRecorderRef.current = mr;

    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    mr.onstop = () => {
      stopStream();
      const type = mr.mimeType || mimeType || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      blobRef.current = blob;
      // Fall back to the live-timer elapsed if the wall-clock delta looks off.
      if (!(durationRef.current > 0)) durationRef.current = elapsed;
      setRecordedDuration(durationRef.current);
      const url = URL.createObjectURL(blob);
      setAudioUrl(url);
      setPhase("recorded");
    };

    startedAtRef.current = Date.now();
    setElapsed(0);
    // timeslice so we get periodic chunks (more robust than one final chunk).
    mr.start(1000);
    setPhase("recording");

    timerRef.current = setInterval(() => {
      const secs = (Date.now() - startedAtRef.current) / 1000;
      setElapsed(secs);
    }, 200);

    // Hard 120s cap — auto-stop.
    capTimerRef.current = setTimeout(() => {
      stopRecording();
    }, MAX_SECONDS * 1000);
  }, [elapsed, stopRecording, stopStream]);

  // --- submit ---------------------------------------------------------------
  const submit = useCallback(async () => {
    const blob = blobRef.current;
    const duration = durationRef.current;
    if (!blob) return;

    // Client-side rejection of empty/too-short clips (AI_DESIGN §1.2).
    if (duration < MIN_SECONDS || blob.size < MIN_BYTES) {
      setError(
        `That recording was too short (min ${MIN_SECONDS}s). Record a fuller answer.`,
      );
      return;
    }

    setPhase("analyzing");
    setError(null);

    const form = new FormData();
    // Give the blob a filename so some servers/parsers treat it as a file part.
    const ext = (blob.type.split("/")[1] || "webm").split(";")[0];
    form.append("audio", blob, `answer.${ext}`);
    form.append("duration_sec", duration.toFixed(1));
    if (prompt) form.append("prompt_id", prompt.id);

    try {
      const res = await fetch("/api/interview/feedback", {
        method: "POST",
        body: form,
      });

      if (res.status === 401) {
        window.location.href = "/gate";
        return;
      }

      if (res.status === 429) {
        // Quota exhausted — stash locally so the recording isn't lost.
        const saved = await savePending({
          id: `${Date.now()}`,
          blob,
          mimeType: blob.type,
          durationSeconds: duration,
          promptId: prompt?.id ?? null,
          promptText: prompt?.prompt_text ?? "",
          createdAt: Date.now(),
        });
        setError(
          saved
            ? "Daily practice limit reached. Your recording is saved on this device — analysis resumes after midnight Pacific."
            : "Daily practice limit reached — analysis resumes after midnight Pacific.",
        );
        setPhase("quota");
        return;
      }

      if (!res.ok) {
        let msg = "Analysis failed. Try re-recording.";
        try {
          const body = (await res.json()) as { error?: string; code?: string };
          if (body.code === "no_api_key" || body.error === "no_api_key") {
            msg = "AI is not configured on the server yet (no Gemini key).";
          } else if (body.error === "audio_too_large" || body.code === "audio_too_large") {
            msg = "That recording is too large. Keep it under 2 minutes.";
          } else if (body.error === "gemini_failed") {
            msg = "The analyzer had a problem. Try re-recording.";
          }
        } catch {
          /* non-JSON error body — keep the generic message */
        }
        setError(msg);
        // Keep the blob in memory so the user can retry once (§8).
        setPhase("recorded");
        return;
      }

      const data = (await res.json()) as Feedback & { streak: number };
      setFeedback(data);
      setStreak(data.streak);
      setPhase("feedback");
      // Feedback is stored server-side; drop the local blob now (audio not needed).
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
      blobRef.current = null;
    } catch {
      setError("Network error. Your recording is still here — try submitting again.");
      setPhase("recorded");
    }
  }, [prompt, audioUrl]);

  const newPrompt = useCallback(() => {
    if (visiblePrompts.length <= 1) return;
    setPromptIdx((i) => (i + 1) % visiblePrompts.length);
    resetRecording();
    setPhase("idle");
  }, [visiblePrompts.length, resetRecording]);

  // Retry-same-prompt: reset the recorder WITHOUT rotating the prompt (§4.5).
  const startOver = useCallback(() => {
    resetRecording();
    setStreak(null);
    setPhase("idle");
  }, [resetRecording]);

  const selectCategory = useCallback(
    (next: CategoryFilter) => {
      if (next === category) return;
      setCategory(next);
      setPromptIdx(0);
      resetRecording();
      setStreak(null);
      setPhase("idle");
    },
    [category, resetRecording],
  );

  // --- render ---------------------------------------------------------------
  if (!supported) {
    return (
      <div className="rounded-lg border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-5 text-sm text-[var(--danger)]">
        This browser doesn&rsquo;t support in-browser recording. Use a recent
        Chrome, Edge, or Android browser.
      </div>
    );
  }

  if (!hasPrompts) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-sm text-[var(--muted)]">
        No interview prompts found. Run <code>schema.sql</code> to seed them.
      </div>
    );
  }

  const chipsDisabled = phase === "recording" || phase === "analyzing";

  return (
    <div className="flex flex-col gap-6">
      {/* Category chips — client-side filter over the loaded prompt list (§4.5). */}
      <div className="flex flex-wrap gap-2">
        {(["all", ...INTERVIEW_CATEGORIES] as CategoryFilter[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => selectCategory(c)}
            disabled={chipsDisabled}
            className={`rounded-full px-3 py-1 text-xs transition-colors disabled:opacity-40 ${
              category === c
                ? "bg-[var(--accent-strong)]/20 text-[var(--accent-strong)]"
                : "bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
            }`}
          >
            {c === "all" ? "All" : CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>

      {/* Prompt card. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs uppercase tracking-wide text-[var(--muted)]">
            {prompt ? categoryLabel(prompt.category) : "prompt"}
          </span>
          <button
            type="button"
            onClick={newPrompt}
            disabled={visiblePrompts.length <= 1 || chipsDisabled}
            className="rounded-md px-2 py-1 text-xs text-[var(--muted)] transition-colors hover:text-[var(--foreground)] disabled:opacity-40"
          >
            New prompt
          </button>
        </div>
        <p className="text-[15px] leading-relaxed">
          {prompt?.prompt_text ?? "No prompts in this category yet."}
        </p>
      </div>

      {/* Recorder controls / states. */}
      {phase !== "feedback" && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-6">
          {phase === "denied" ? (
            <div className="text-sm">
              <p className="mb-2 font-medium text-[var(--danger)]">
                Microphone access was blocked.
              </p>
              <p className="mb-4 text-[var(--muted)]">
                Allow microphone access for this site in your browser&rsquo;s
                address-bar permissions (or site settings), then try again.
              </p>
              <button
                type="button"
                onClick={startRecording}
                className="rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b]"
              >
                Try again
              </button>
            </div>
          ) : phase === "recording" ? (
            <div className="flex flex-col items-center gap-4">
              <div className="flex items-center gap-2 text-[var(--danger)]">
                <span className="h-3 w-3 animate-pulse rounded-full bg-[var(--danger)]" />
                <span className="font-mono text-2xl tabular-nums">
                  {fmtTime(elapsed)}
                </span>
                <span className="text-sm text-[var(--muted)]">/ {fmtTime(MAX_SECONDS)}</span>
              </div>
              <div className="h-1.5 w-full max-w-sm overflow-hidden rounded-full bg-[var(--surface-2)]">
                <div
                  className="h-full bg-[var(--danger)] transition-[width] duration-200"
                  style={{ width: `${Math.min(100, (elapsed / MAX_SECONDS) * 100)}%` }}
                />
              </div>
              <button
                type="button"
                onClick={stopRecording}
                className="rounded-lg bg-[var(--danger)] px-5 py-2.5 text-sm font-medium text-white"
              >
                Stop
              </button>
            </div>
          ) : phase === "recorded" ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-[var(--muted)]">
                Recorded {fmtTime(recordedDuration)}. Play it back, then submit
                for feedback or re-record.
              </p>
              {audioUrl && (
                <audio controls src={audioUrl} className="w-full">
                  <track kind="captions" />
                </audio>
              )}
              {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={submit}
                  className="rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b]"
                >
                  Get feedback
                </button>
                <button
                  type="button"
                  onClick={startRecording}
                  className="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
                >
                  Re-record
                </button>
              </div>
            </div>
          ) : phase === "analyzing" ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <span className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--surface-2)] border-t-[var(--accent)]" />
              <p className="text-sm text-[var(--muted)]">
                Analyzing your delivery… this takes a few seconds.
              </p>
            </div>
          ) : phase === "quota" ? (
            <div className="text-sm">
              <p className="mb-2 font-medium text-[var(--foreground)]">
                Daily limit reached.
              </p>
              <p className="mb-4 text-[var(--muted)]">{error}</p>
              <button
                type="button"
                onClick={startOver}
                className="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
              >
                Done
              </button>
            </div>
          ) : (
            // idle / requesting / error
            <div className="flex flex-col items-center gap-4 py-2">
              {error && phase === "error" && (
                <p className="text-sm text-[var(--danger)]">{error}</p>
              )}
              <p className="text-center text-sm text-[var(--muted)]">
                Record a spoken answer (up to 2 minutes). Speak as if you were in
                the real interview.
              </p>
              <button
                type="button"
                onClick={startRecording}
                disabled={phase === "requesting"}
                className="flex items-center gap-2 rounded-lg bg-[var(--accent-strong)] px-5 py-3 text-sm font-medium text-[#04120b] disabled:opacity-50"
              >
                <span className="h-2.5 w-2.5 rounded-full bg-[#04120b]" />
                {phase === "requesting" ? "Allow mic access…" : "Start recording"}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Feedback results. */}
      {phase === "feedback" && feedback && (
        <div className="flex flex-col gap-4">
          {streak !== null && (
            <p className="text-sm text-[var(--muted)]">
              Streak: <span className="text-[var(--accent)]">{streak}</span> day
              {streak === 1 ? "" : "s"}
              {typeof feedback.xp_awarded === "number" && (
                <>
                  {" "}
                  · <span className="text-[var(--accent)]">+{feedback.xp_awarded} XP</span>
                  {typeof feedback.level === "number" && ` · Level ${feedback.level}`}
                </>
              )}
              . Nice work.
            </p>
          )}
          {feedback.new_achievements && feedback.new_achievements.length > 0 && (
            <div className="rounded-lg border border-[var(--accent-strong)]/40 bg-[var(--accent-strong)]/10 p-3 text-sm">
              {feedback.new_achievements.map((a) => (
                <p key={a.key} className="text-[var(--accent-strong)]">
                  Achievement unlocked: {a.name}
                </p>
              ))}
            </div>
          )}
          <FeedbackView feedback={feedback} />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={startOver}
              className="rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b]"
            >
              Retry this prompt
            </button>
            <button
              type="button"
              onClick={() => {
                newPrompt();
              }}
              disabled={visiblePrompts.length <= 1}
              className="rounded-lg border border-[var(--border)] px-4 py-2.5 text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)] disabled:opacity-40"
            >
              New prompt
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
