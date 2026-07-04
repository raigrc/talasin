import "server-only";
import { getServiceClient } from "./supabase/server";

/**
 * Durable login rate limiter backed by the `login_attempts` table
 * (DESIGN_V1.md §4.6, §2.5) — replaces the per-lambda in-memory Map the
 * security review flagged. Flow per login request:
 *
 *   prune old rows → count window failures for this IP → ≥ max → 429 BEFORE
 *   scrypt runs (cheap DoS shield for the KDF) → verify → record the attempt.
 *
 * FAIL-OPEN by design (stated trade-off, §7): if Supabase is unreachable the
 * limiter logs `[auth] limiter degraded` and allows the attempt to proceed to
 * scrypt verification — availability for the single legit user; the
 * scrypt-verified passphrase remains the actual gate.
 *
 * Pruning: no cron. Rows older than 24h are deleted opportunistically before
 * each check — trivially cheap at single-user volume, and the (ip,
 * attempted_at) index covers both the window count and the prune.
 */

export const LOGIN_WINDOW_MIN = 15;
export const LOGIN_MAX_FAILS = 10;

const PRUNE_AGE_HOURS = 24;

/**
 * True when this IP is still allowed to attempt a login (fails in the window
 * below the max). Prunes stale rows first. Fails OPEN on any DB error.
 */
export async function checkLoginAllowed(
  ip: string,
  now: Date = new Date(),
): Promise<boolean> {
  const supabase = getServiceClient();

  // Opportunistic prune — best-effort; a failure here must not block the check.
  try {
    const pruneBefore = new Date(now.getTime() - PRUNE_AGE_HOURS * 3_600_000).toISOString();
    const { error: pruneErr } = await supabase
      .from("login_attempts")
      .delete()
      .lt("attempted_at", pruneBefore);
    if (pruneErr) {
      console.warn(`[auth] limiter prune failed: ${pruneErr.message}`);
    }
  } catch (err) {
    console.warn(`[auth] limiter prune failed: ${(err as Error)?.message}`);
  }

  try {
    const windowStart = new Date(now.getTime() - LOGIN_WINDOW_MIN * 60_000).toISOString();
    const { count, error } = await supabase
      .from("login_attempts")
      .select("id", { count: "exact", head: true })
      .eq("ip", ip)
      .eq("success", false)
      .gte("attempted_at", windowStart);
    if (error) {
      console.warn(`[auth] limiter degraded (count failed): ${error.message}`);
      return true; // fail-open — scrypt still gates
    }
    return (count ?? 0) < LOGIN_MAX_FAILS;
  } catch (err) {
    console.warn(`[auth] limiter degraded: ${(err as Error)?.message}`);
    return true; // fail-open
  }
}

/**
 * Record the outcome of a verified login attempt. Best-effort: a write failure
 * is logged and swallowed (fail-open — it must never block a legit login or
 * mask the 401 for a wrong passphrase).
 */
export async function recordLoginAttempt(ip: string, success: boolean): Promise<void> {
  try {
    const supabase = getServiceClient();
    const { error } = await supabase.from("login_attempts").insert({ ip, success });
    if (error) {
      console.warn(`[auth] limiter record failed: ${error.message}`);
    }
  } catch (err) {
    console.warn(`[auth] limiter record failed: ${(err as Error)?.message}`);
  }
}
