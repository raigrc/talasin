"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Dual N-back play client (DESIGN_V1.md §3.4, §6). The server seeds the trial
 * list and holds ground truth in the signed round token; this client only
 * renders stimuli on a timer and collects RAW per-trial booleans — it never
 * computes a score. Letters are always rendered visually; SpeechSynthesis is
 * best-effort (feature-detected) and purely presentational.
 */

interface NBackTrial {
  pos: number; // 0..8
  letter: string;
}

export interface NBackRound {
  game_type: "nback";
  n: number;
  trial_ms: number;
  trials: NBackTrial[]; // n lead-in + 20 scoreable
  token: string;
}

interface ModalityBreakdown {
  hits: number;
  misses: number;
  false_alarms: number;
}

interface NBackResult {
  score: number;
  n: number;
  next_n: number;
  position: ModalityBreakdown;
  letter: ModalityBreakdown;
  streak: number;
  xp_awarded: number;
  xp_total: number;
  level: number;
}

type Phase = "idle" | "playing" | "submitting" | "done";

function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function NBackClient({ initialRound }: { initialRound: NBackRound | null }) {
  const [round, setRound] = useState<NBackRound | null>(initialRound);
  const [phase, setPhase] = useState<Phase>("idle");
  const [trialIdx, setTrialIdx] = useState(0);
  // Pressed-state is keyed to the trial it belongs to, so advancing the trial
  // "resets" it by derivation — no setState needed inside the pacing effect.
  const [pressedAt, setPressedAt] = useState({ idx: -1, position: false, letter: false });
  const [result, setResult] = useState<NBackResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingNext, setLoadingNext] = useState(false);
  const [audioOn, setAudioOn] = useState(true);

  // Raw per-scoreable-trial responses — the only thing the server trusts us to send.
  const posRespRef = useRef<boolean[]>([]);
  const letRespRef = useRef<boolean[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioOnRef = useRef(true);
  useEffect(() => {
    audioOnRef.current = audioOn;
  }, [audioOn]);

  const pressed =
    pressedAt.idx === trialIdx
      ? { position: pressedAt.position, letter: pressedAt.letter }
      : { position: false, letter: false };

  const scoreableCount = round ? round.trials.length - round.n : 0;

  const speak = useCallback((letter: string) => {
    if (!speechAvailable() || !audioOnRef.current) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(letter);
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch {
      // best-effort only — the letter is always rendered visually
    }
  }, []);

  const submit = useCallback(
    async (r: NBackRound) => {
      setPhase("submitting");
      setError(null);
      try {
        const res = await fetch("/api/game/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            game_type: "nback",
            token: r.token,
            responses: {
              position: posRespRef.current,
              letter: letRespRef.current,
            },
          }),
        });
        if (res.status === 401) {
          window.location.href = "/gate";
          return;
        }
        if (res.status === 410 || res.status === 409) {
          setError(
            res.status === 410
              ? "This round expired. Grab a fresh one below."
              : "This round was already scored. Grab a fresh one below.",
          );
          setPhase("idle");
          setRound(null);
          return;
        }
        if (!res.ok) {
          setError("Could not record the session. Try submitting again.");
          setPhase("done"); // result stays null → retry button renders
          return;
        }
        setResult((await res.json()) as NBackResult);
        setPhase("done");
      } catch {
        setError("Network error. Try submitting again.");
        setPhase("done");
      }
    },
    [],
  );

  // Trial pacing: one timeout per trial; the last trial auto-submits.
  useEffect(() => {
    if (phase !== "playing" || !round) return;
    speak(round.trials[trialIdx].letter);
    timerRef.current = setTimeout(() => {
      if (trialIdx + 1 < round.trials.length) {
        setTrialIdx(trialIdx + 1);
      } else {
        void submit(round);
      }
    }, round.trial_ms);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [phase, trialIdx, round, speak, submit]);

  // Cancel any queued speech when leaving the page mid-round.
  useEffect(() => {
    return () => {
      if (speechAvailable()) window.speechSynthesis.cancel();
    };
  }, []);

  const start = useCallback(() => {
    if (!round) return;
    posRespRef.current = Array.from({ length: round.trials.length - round.n }, () => false);
    letRespRef.current = Array.from({ length: round.trials.length - round.n }, () => false);
    setResult(null);
    setError(null);
    setPressedAt({ idx: -1, position: false, letter: false });
    setTrialIdx(0);
    setPhase("playing");
  }, [round]);

  const press = useCallback(
    (modality: "position" | "letter") => {
      if (phase !== "playing" || !round) return;
      const k = trialIdx - round.n;
      if (k < 0) return; // lead-in trials collect no responses
      (modality === "position" ? posRespRef : letRespRef).current[k] = true;
      setPressedAt((prev) =>
        prev.idx === trialIdx
          ? { ...prev, [modality]: true }
          : {
              idx: trialIdx,
              position: modality === "position",
              letter: modality === "letter",
            },
      );
    },
    [phase, round, trialIdx],
  );

  const fetchNext = useCallback(async () => {
    setLoadingNext(true);
    setError(null);
    try {
      const res = await fetch("/api/game/next?type=nback");
      if (res.status === 401) {
        window.location.href = "/gate";
        return;
      }
      if (!res.ok) {
        setError("Could not load a new session.");
        return;
      }
      const data = (await res.json()) as { round: NBackRound | null };
      if (data.round) {
        setRound(data.round);
        setResult(null);
        setPhase("idle");
      } else {
        setError("Could not load a new session.");
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setLoadingNext(false);
    }
  }, []);

  // --- render ----------------------------------------------------------------

  if (!round && !result) {
    return (
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
        <button
          type="button"
          onClick={fetchNext}
          disabled={loadingNext}
          className="self-start rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b] disabled:opacity-50"
        >
          {loadingNext ? "Loading…" : "Load a session"}
        </button>
      </div>
    );
  }

  if (phase === "done" && result) {
    return (
      <div className="flex flex-col gap-5">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 text-center">
          <p className="text-xs uppercase tracking-wide text-[var(--muted)]">Session score</p>
          <p className="mt-1 text-5xl font-semibold text-[var(--accent)]">{result.score}</p>
          <p className="mt-2 text-sm text-[var(--muted)]">
            N={result.n} · next session N={result.next_n} · +{result.xp_awarded} XP · streak{" "}
            {result.streak}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <BreakdownCard title="Position" b={result.position} />
          <BreakdownCard title="Letter" b={result.letter} />
        </div>

        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

        <button
          type="button"
          onClick={fetchNext}
          disabled={loadingNext}
          className="self-start rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b] disabled:opacity-50"
        >
          {loadingNext ? "Loading…" : `Next session (N=${result.next_n})`}
        </button>
      </div>
    );
  }

  if (phase === "done" && !result && round) {
    // Submit failed after play — the responses are still in the refs; retry.
    return (
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
        <button
          type="button"
          onClick={() => void submit(round)}
          className="self-start rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b]"
        >
          Retry submit
        </button>
      </div>
    );
  }

  if (phase === "submitting") {
    return <p className="text-sm text-[var(--muted)]">Scoring your session…</p>;
  }

  if (phase === "idle" && round) {
    return (
      <div className="flex flex-col gap-5">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 text-sm leading-relaxed">
          <p className="mb-2 font-medium">N = {round.n}</p>
          <p className="text-[var(--muted)]">
            A square lights up and a letter appears every{" "}
            {(round.trial_ms / 1000).toFixed(1)}s. Tap{" "}
            <span className="text-[var(--foreground)]">Position</span> when the square matches
            the one {round.n} steps back, and{" "}
            <span className="text-[var(--foreground)]">Letter</span> when the letter matches the
            one {round.n} steps back. Both can match at once. The first {round.n} trials are
            lead-in — just memorize.
          </p>
        </div>

        {speechAvailable() && (
          <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
            <input
              type="checkbox"
              checked={audioOn}
              onChange={(e) => setAudioOn(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            Speak the letters out loud
          </label>
        )}

        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

        <button
          type="button"
          onClick={start}
          className="self-start rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b]"
        >
          Start session
        </button>
      </div>
    );
  }

  // phase === "playing"
  if (!round) return null;
  const trial = round.trials[trialIdx];
  const isLeadIn = trialIdx < round.n;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between text-xs text-[var(--muted)]">
        <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5">N = {round.n}</span>
        <span>
          {isLeadIn
            ? `Lead-in ${trialIdx + 1}/${round.n}`
            : `Trial ${trialIdx - round.n + 1}/${scoreableCount}`}
        </span>
      </div>

      <div className="mx-auto grid w-full max-w-xs grid-cols-3 gap-2">
        {Array.from({ length: 9 }, (_, cell) => (
          <div
            key={cell}
            className={`aspect-square rounded-lg border ${
              cell === trial.pos
                ? "border-[var(--accent-strong)] bg-[var(--accent-strong)]/40"
                : "border-[var(--border)] bg-[var(--surface)]"
            }`}
          />
        ))}
      </div>

      <p className="text-center font-mono text-5xl font-semibold text-[var(--accent)]">
        {trial.letter}
      </p>

      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => press("position")}
          disabled={isLeadIn || pressed.position}
          className={`rounded-lg border px-4 py-4 text-sm font-medium transition-colors disabled:opacity-50 ${
            pressed.position
              ? "border-[var(--accent-strong)] bg-[var(--accent-strong)]/20"
              : "border-[var(--border)] bg-[var(--surface)]"
          }`}
        >
          Position match
        </button>
        <button
          type="button"
          onClick={() => press("letter")}
          disabled={isLeadIn || pressed.letter}
          className={`rounded-lg border px-4 py-4 text-sm font-medium transition-colors disabled:opacity-50 ${
            pressed.letter
              ? "border-[var(--accent-strong)] bg-[var(--accent-strong)]/20"
              : "border-[var(--border)] bg-[var(--surface)]"
          }`}
        >
          Letter match
        </button>
      </div>

      {isLeadIn && (
        <p className="text-center text-xs text-[var(--muted)]">Memorize — no responses yet.</p>
      )}
    </div>
  );
}

function BreakdownCard({ title, b }: { title: string; b: ModalityBreakdown }) {
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 text-sm">
      <p className="mb-2 font-medium">{title}</p>
      <dl className="space-y-1 text-[var(--muted)]">
        <div className="flex justify-between">
          <dt>Hits</dt>
          <dd className="text-[var(--foreground)]">{b.hits}</dd>
        </div>
        <div className="flex justify-between">
          <dt>Misses</dt>
          <dd className="text-[var(--foreground)]">{b.misses}</dd>
        </div>
        <div className="flex justify-between">
          <dt>False alarms</dt>
          <dd className="text-[var(--foreground)]">{b.false_alarms}</dd>
        </div>
      </dl>
    </div>
  );
}
