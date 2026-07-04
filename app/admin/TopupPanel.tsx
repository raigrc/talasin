"use client";

import { useState } from "react";

/**
 * Admin top-up form (DESIGN_V1.md §4.7). POSTs to the EXISTING /api/game/topup
 * — that route's session + x-talasin-admin auth is unchanged. The admin token
 * is typed per use into a password field held in component state ONLY: never
 * localStorage, never sessionStorage, never a cookie. That preserves its
 * "second factor" property — a stolen session cookie alone can't burn quota.
 */

// Kept in sync with FALLACY_KEYS in lib/gemini/schemas.ts (server-only module —
// clients can't import it). These keys are already public via the game choices.
const FALLACY_OPTIONS: { key: string; label: string }[] = [
  { key: "strawman", label: "Straw Man" },
  { key: "ad_hominem", label: "Ad Hominem" },
  { key: "false_cause", label: "False Cause" },
  { key: "appeal_to_authority", label: "Appeal to Authority" },
  { key: "slippery_slope", label: "Slippery Slope" },
  { key: "false_dilemma", label: "False Dilemma" },
  { key: "hasty_generalization", label: "Hasty Generalization" },
  { key: "circular_reasoning", label: "Circular Reasoning" },
  { key: "appeal_to_emotion", label: "Appeal to Emotion" },
  { key: "bandwagon", label: "Bandwagon" },
  { key: "red_herring", label: "Red Herring" },
  { key: "tu_quoque", label: "Tu Quoque" },
];

interface TopupResult {
  requested: number;
  generated: number;
  inserted: number;
  skipped_duplicates: number;
  needs_review: number;
  batch_id: string;
}

export function TopupPanel() {
  const [count, setCount] = useState(20);
  const [difficulty, setDifficulty] = useState<"" | "1" | "2" | "3">("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Held in component state ONLY — never persisted anywhere (§4.7).
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TopupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);

    const body: Record<string, unknown> = { count };
    if (difficulty) body.difficulty = Number(difficulty);
    if (selectedKeys.size > 0) body.fallacy_keys = [...selectedKeys];

    try {
      const res = await fetch("/api/game/topup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-talasin-admin": token,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        window.location.href = "/gate";
        return;
      }
      if (res.status === 403) {
        setError("Wrong admin token.");
        return;
      }
      if (res.status === 429) {
        setError("Gemini quota reached — try again after midnight Pacific.");
        return;
      }
      if (!res.ok) {
        let msg = "Top-up failed. Check the server logs.";
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error === "no_api_key") msg = "No Gemini key configured on the server.";
          else if (data.error === "invalid body") msg = "Invalid request values.";
        } catch {
          /* keep generic message */
        }
        setError(msg);
        return;
      }

      setResult((await res.json()) as TopupResult);
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="mb-1 text-sm font-medium">Top up rounds</h2>
      <p className="mb-4 text-xs text-[var(--muted)]">
        Generates fresh fallacy rounds via Gemini (one batched call, deduped on
        content hash). The admin token is required per use and never stored.
      </p>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-4">
          <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
            Count (1–50)
            <input
              type="number"
              min={1}
              max={50}
              value={count}
              onChange={(e) =>
                setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
              }
              className="w-24 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)]"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
            Difficulty
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as "" | "1" | "2" | "3")}
              className="w-32 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)]"
            >
              <option value="">Mixed</option>
              <option value="1">Easy</option>
              <option value="2">Medium</option>
              <option value="3">Hard</option>
            </select>
          </label>
        </div>

        <fieldset>
          <legend className="mb-2 text-xs text-[var(--muted)]">
            Target fallacies (optional — none selected = cover the taxonomy)
          </legend>
          <div className="flex flex-wrap gap-2">
            {FALLACY_OPTIONS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => toggleKey(f.key)}
                className={`rounded-full px-3 py-1 text-xs transition-colors ${
                  selectedKeys.has(f.key)
                    ? "bg-[var(--accent-strong)]/20 text-[var(--accent-strong)]"
                    : "bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Admin token (typed per use — not stored)
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            required
            className="max-w-sm rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--foreground)]"
          />
        </label>

        {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

        {result && (
          <div className="rounded-lg border border-[var(--accent-strong)]/40 bg-[var(--accent-strong)]/10 p-3 text-sm">
            <p className="text-[var(--accent-strong)]">
              Inserted {result.inserted} of {result.generated} generated
              (requested {result.requested}).
            </p>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {result.skipped_duplicates} duplicates skipped ·{" "}
              {result.needs_review} held for review · batch{" "}
              <code>{result.batch_id}</code>
            </p>
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={busy || token.length === 0}
            className="rounded-lg bg-[var(--accent-strong)] px-4 py-2.5 text-sm font-medium text-[#04120b] disabled:opacity-50"
          >
            {busy ? "Generating…" : "Generate rounds"}
          </button>
        </div>
      </form>
    </section>
  );
}
