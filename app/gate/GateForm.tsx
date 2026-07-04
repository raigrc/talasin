"use client";

import { useState } from "react";

/**
 * Passphrase entry form. Posts to /api/auth/login; on success does a hard nav to
 * "/" so the proxy sees the fresh cookie. The passphrase never leaves this form
 * except as the login POST body.
 */
export function GateForm() {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase || loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (res.ok) {
        window.location.href = "/";
        return;
      }
      if (res.status === 429) {
        setError("Too many attempts. Wait a minute and try again.");
      } else if (res.status === 500) {
        setError("Server not configured. Check the passphrase env vars.");
      } else {
        setError("Invalid passphrase.");
      }
    } catch {
      setError("Network error. Try again.");
    } finally {
      setLoading(false);
      setPassphrase("");
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <label htmlFor="passphrase" className="sr-only">
        Passphrase
      </label>
      <input
        id="passphrase"
        type="password"
        autoComplete="current-password"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="Passphrase"
        autoFocus
        className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
      />
      {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
      <button
        type="submit"
        disabled={loading || !passphrase}
        className="rounded-lg bg-[var(--accent-strong)] px-4 py-3 font-medium text-[#04120b] transition-opacity disabled:opacity-50"
      >
        {loading ? "Unlocking…" : "Unlock"}
      </button>
    </form>
  );
}
