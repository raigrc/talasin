import "server-only";

/**
 * Centralized, server-only access to environment variables.
 *
 * Importing `server-only` at the top makes any attempt to pull this module into
 * a Client Component a build-time error — a hard guard against leaking secrets
 * into the browser bundle.
 */

/** Read a required env var; throw a clear error if missing (never at import time — only when called). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(
      `Missing required environment variable: ${name}. See .env.example.`,
    );
  }
  return value;
}

/** Read an optional env var. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

/** Fixed timezone used to compute the local calendar day for streaks (DESIGN.md §6). */
export const APP_TZ = optionalEnv("TALASIN_TZ") ?? "Asia/Manila";
