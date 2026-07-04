"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Syllogism sprint play client (DESIGN_V1.md §3.5, §6). Two premises + a
 * conclusion → "Follows" / "Doesn't follow". Validity never reaches the client
 * before answering — it lives in the signed round token, re-derived server-side.
 * The 60-second sprint is purely presentational: each answer is still one
 * server-scored attempt row; the timer just frames a quick-fire run.
 */

export interface SyllogismRound {
  game_type: "syllogism";
  premises: string[];
  conclusion: string;
  token: string;
}

interface AnswerResponse {
  is_correct: boolean;
  valid: boolean;
  explanation: string;
  streak: number;
  xp_awarded: number;
  xp_total: number;
  level: number;
}

const SPRINT_SECONDS = 60;

export function SyllogismClient({ initialRound }: { initialRound: SyllogismRound | null }) {
  const [round, setRound] = useState<SyllogismRound | null>(initialRound);
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingNext, setLoadingNext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streak, setStreak] = useState<number | null>(null);
  const [correct, setCorrect] = useState(0);
  const [answered, setAnswered] = useState(0);

  // Presentational sprint window: starts on the first answer, ends after 60s.
  const [sprintEndsAt, setSprintEndsAt] = useState<number | null>(null);
  const [remainingSec, setRemainingSec] = useState(SPRINT_SECONDS);
  const sprintOver = sprintEndsAt !== null && remainingSec <= 0;

  const startedAtRef = useRef<number>(0);
  useEffect(() => {
    if (round) startedAtRef.current = Date.now();
  }, [round?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (sprintEndsAt === null) return;
    const tick = () => {
      setRemainingSec(Math.max(0, Math.ceil((sprintEndsAt - Date.now()) / 1000)));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [sprintEndsAt]);

  const fetchNext = useCallback(async () => {
    setLoadingNext(true);
    setError(null);
    try {
      const res = await fetch("/api/game/next?type=syllogism");
      if (res.status === 401) {
        window.location.href = "/gate";
        return;
      }
      if (!res.ok) {
        setError("Could not load the next one.");
        return;
      }
      const data = (await res.json()) as { round: SyllogismRound | null };
      if (data.round) {
        setRound(data.round);
        setResult(null);
      } else {
        setError("Could not load the next one.");
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setLoadingNext(false);
    }
  }, []);

  const submit = useCallback(
    async (answer: "follows" | "does_not_follow") => {
      if (!round || submitting || result) return;
      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/game/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            game_type: "syllogism",
            token: round.token,
            answer,
            answered_ms: Math.max(0, Date.now() - startedAtRef.current),
          }),
        });
        if (res.status === 401) {
          window.location.href = "/gate";
          return;
        }
        if (res.status === 410 || res.status === 409) {
          // Expired or already scored — just move on to a fresh round.
          await fetchNext();
          return;
        }
        if (!res.ok) {
          setError("Could not record your answer. Try again.");
          return;
        }
        const data = (await res.json()) as AnswerResponse;
        setResult(data);
        setStreak(data.streak);
        if (sprintEndsAt === null) {
          setSprintEndsAt(Date.now() + SPRINT_SECONDS * 1000);
        }
        if (sprintEndsAt === null || Date.now() <= sprintEndsAt) {
          setAnswered((a) => a + 1);
          if (data.is_correct) setCorrect((c) => c + 1);
        }
      } catch {
        setError("Network error. Try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [round, submitting, result, fetchNext, sprintEndsAt],
  );

  const resetSprint = useCallback(() => {
    setSprintEndsAt(null);
    setRemainingSec(SPRINT_SECONDS);
    setCorrect(0);
    setAnswered(0);
  }, []);

  if (!round) {
    return (
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
        <button
          type="button"
          onClick={fetchNext}
          disabled={loadingNext}
          className="self-start rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b] disabled:opacity-50"
        >
          {loadingNext ? "Loading…" : "Load a round"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between text-xs text-[var(--muted)]">
        <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 font-mono">
          {sprintEndsAt === null
            ? "60s sprint starts on your first answer"
            : sprintOver
              ? "Sprint over"
              : `0:${String(remainingSec).padStart(2, "0")}`}
        </span>
        <span>
          {answered > 0 && `${correct}/${answered} correct`}
          {streak !== null && ` · streak ${streak}`}
        </span>
      </div>

      {sprintOver && (
        <div className="flex items-center justify-between rounded-lg border border-[var(--accent-strong)]/40 bg-[var(--accent-strong)]/10 p-4 text-sm">
          <p>
            Sprint done: <span className="font-medium">{correct}/{answered}</span> in{" "}
            {SPRINT_SECONDS}s. Keep practicing or go again.
          </p>
          <button
            type="button"
            onClick={resetSprint}
            className="rounded-lg bg-[var(--accent-strong)] px-3 py-1.5 text-xs font-medium text-[#04120b]"
          >
            New sprint
          </button>
        </div>
      )}

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-[15px] leading-relaxed">
        <ol className="list-decimal space-y-2 pl-5">
          {round.premises.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ol>
        <p className="mt-4 border-t border-[var(--border)] pt-4 font-medium">
          Therefore: {round.conclusion}
        </p>
      </div>

      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

      {result ? (
        <div className="flex flex-col gap-4">
          <div
            className={`rounded-lg border p-4 text-sm ${
              result.is_correct
                ? "border-[var(--accent-strong)]/40 bg-[var(--accent-strong)]/10"
                : "border-[var(--danger)]/40 bg-[var(--danger)]/10"
            }`}
          >
            <p className="mb-1 font-medium">
              {result.is_correct ? "Correct." : "Not quite."} The conclusion{" "}
              {result.valid ? "follows" : "does not follow"}.
            </p>
            <p className="text-[var(--foreground)]/90">{result.explanation}</p>
          </div>
          <button
            type="button"
            onClick={fetchNext}
            disabled={loadingNext}
            className="self-start rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b] disabled:opacity-50"
          >
            {loadingNext ? "Loading…" : "Next round"}
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void submit("follows")}
            disabled={submitting}
            className="rounded-lg bg-[var(--accent-strong)] px-4 py-4 text-sm font-medium text-[#04120b] disabled:opacity-50"
          >
            Follows
          </button>
          <button
            type="button"
            onClick={() => void submit("does_not_follow")}
            disabled={submitting}
            className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-sm font-medium disabled:opacity-50"
          >
            Doesn&rsquo;t follow
          </button>
        </div>
      )}
    </div>
  );
}
