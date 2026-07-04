"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Choice {
  key: string;
  label: string;
}
interface Round {
  id: string;
  argument_text: string;
  choices: Choice[];
  difficulty: number;
}
interface AnswerResponse {
  is_correct: boolean;
  correct_key: string;
  explanation: string;
  streak: number;
}

const DIFF_LABEL: Record<number, string> = { 1: "Easy", 2: "Medium", 3: "Hard" };

export function GameClient({ initialRound }: { initialRound: Round | null }) {
  const [round, setRound] = useState<Round | null>(initialRound);
  const [exhausted, setExhausted] = useState(initialRound === null);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loadingNext, setLoadingNext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streak, setStreak] = useState<number | null>(null);
  const [correct, setCorrect] = useState(0);
  const [answered, setAnswered] = useState(0);

  // Track rounds seen this session so /next doesn't repeat them.
  const seenRef = useRef<string[]>(initialRound ? [initialRound.id] : []);
  // When the current round was presented (for answered_ms). Set in an effect —
  // never call Date.now() during render (it's impure).
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    if (round) startedAtRef.current = Date.now();
  }, [round?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = useCallback(async () => {
    if (!round || !selected || submitting || result) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/game/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_type: "fallacy",
          round_id: round.id,
          chosen_key: selected,
          answered_ms: Math.max(0, Date.now() - startedAtRef.current),
        }),
      });
      if (res.status === 401) {
        window.location.href = "/gate";
        return;
      }
      if (!res.ok) {
        setError("Could not record your answer. Try again.");
        return;
      }
      const data = (await res.json()) as AnswerResponse;
      setResult(data);
      setStreak(data.streak);
      setAnswered((a) => a + 1);
      if (data.is_correct) setCorrect((c) => c + 1);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setSubmitting(false);
    }
  }, [round, selected, submitting, result]);

  const nextRound = useCallback(async () => {
    setLoadingNext(true);
    setError(null);
    try {
      const qs = seenRef.current.length
        ? `&exclude=${encodeURIComponent(seenRef.current.join(","))}`
        : "";
      const res = await fetch(`/api/game/next?type=fallacy${qs}`);
      if (res.status === 401) {
        window.location.href = "/gate";
        return;
      }
      if (!res.ok) {
        setError("Could not load the next round.");
        return;
      }
      const data = (await res.json()) as { round: Round | null; reason?: string };
      if (!data.round) {
        setExhausted(true);
        setRound(null);
      } else {
        seenRef.current = [...seenRef.current, data.round.id];
        setRound(data.round);
        setSelected(null);
        setResult(null);
        // startedAtRef is (re)set by the round-change effect above.
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setLoadingNext(false);
    }
  }, []);

  if (exhausted && !round) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
        <p className="text-lg font-medium">You&rsquo;ve cleared today&rsquo;s set.</p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Come back tomorrow, or top up more rounds (admin) to keep going.
        </p>
        {answered > 0 && (
          <p className="mt-4 text-sm text-[var(--muted)]">
            Today: {correct}/{answered} correct
            {streak !== null && ` · streak ${streak}`}
          </p>
        )}
      </div>
    );
  }

  if (!round) {
    return (
      <p className="text-sm text-[var(--muted)]">No round loaded. Refresh to try again.</p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between text-xs text-[var(--muted)]">
        <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5">
          {DIFF_LABEL[round.difficulty] ?? "?"}
        </span>
        <span>
          {answered > 0 && `${correct}/${answered} correct`}
          {streak !== null && ` · streak ${streak}`}
        </span>
      </div>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-[15px] leading-relaxed">
        {round.argument_text}
      </div>

      <div className="flex flex-col gap-2">
        {round.choices.map((c) => {
          const isSelected = selected === c.key;
          const isCorrectAnswer = result?.correct_key === c.key;
          const isWrongPick = result && isSelected && !result.is_correct;

          let cls =
            "flex items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors ";
          if (result) {
            if (isCorrectAnswer) cls += "border-[var(--accent-strong)] bg-[var(--accent-strong)]/15 ";
            else if (isWrongPick) cls += "border-[var(--danger)] bg-[var(--danger)]/10 ";
            else cls += "border-[var(--border)] opacity-60 ";
          } else if (isSelected) {
            cls += "border-[var(--accent)] bg-[var(--surface-2)] ";
          } else {
            cls += "border-[var(--border)] bg-[var(--surface)] hover:border-[var(--muted)] ";
          }

          return (
            <button
              key={c.key}
              type="button"
              disabled={!!result || submitting}
              onClick={() => setSelected(c.key)}
              className={cls}
            >
              <span
                className={`h-4 w-4 flex-none rounded-full border ${
                  isSelected ? "border-[var(--accent)] bg-[var(--accent)]" : "border-[var(--muted)]"
                }`}
              />
              {c.label}
            </button>
          );
        })}
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
              {result.is_correct ? "Correct." : "Not quite."}
            </p>
            <p className="text-[var(--foreground)]/90">{result.explanation}</p>
          </div>
          <button
            type="button"
            onClick={nextRound}
            disabled={loadingNext}
            className="self-start rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b] disabled:opacity-50"
          >
            {loadingNext ? "Loading…" : "Next round"}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={!selected || submitting}
          className="self-start rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b] disabled:opacity-50"
        >
          {submitting ? "Checking…" : "Submit"}
        </button>
      )}
    </div>
  );
}
