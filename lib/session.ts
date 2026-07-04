import "server-only";
import { createHmac, timingSafeEqual, createHash, scryptSync } from "node:crypto";
import { cookies } from "next/headers";
import { requireEnv, optionalEnv } from "./env";

/**
 * Passphrase gate + stateless HMAC-signed session cookie (DESIGN.md §4).
 *
 * - One shared passphrase → httpOnly session cookie.
 * - Secrets are read only here + Route Handlers; never in client code.
 * - Session token is stateless: base64url(payload).HMAC — no DB session table.
 */

export const SESSION_COOKIE = "talasin_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 14; // 14 days

/** Thrown by requireSession() when the caller has no valid session. */
export class UnauthorizedError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

interface SessionPayload {
  iat: number; // issued-at (unix seconds)
  exp: number; // expiry (unix seconds)
}

// --- constant-time helpers --------------------------------------------------

/**
 * Constant-time comparison of two hex/ascii strings of arbitrary length.
 * Exported so other server-side handlers (e.g. the admin-token check) reuse the
 * same hash-to-fixed-width-then-timingSafeEqual pattern instead of an early-return
 * length compare (which leaks length via timing).
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal lengths; hash both to a fixed width first so
  // length differences don't leak and don't throw.
  const ha = createHash("sha256").update(bufA).digest();
  const hb = createHash("sha256").update(bufB).digest();
  return timingSafeEqual(ha, hb);
}

// --- passphrase verification -----------------------------------------------

// scrypt is a memory-hard KDF; each stored hash carries its own N/r/p cost
// params and salt (see the format below), so verification reads them from the
// stored value rather than hard-coding them here.
const SCRYPT_MAX_MEM = 64 * 1024 * 1024; // headroom so higher N params don't throw

/**
 * Verify a candidate passphrase against TALASIN_PASSPHRASE_HASH.
 *
 * Format (self-describing, so params can evolve): `scrypt:N:r:p:saltB64url:hashB64url`.
 * The legacy `$`-delimited variant of the same format is also accepted — but
 * `$` inside .env files is mangled by Next's dotenv variable expansion unless
 * every `$` is escaped as `\$`, which is why `:` is the emitted format now
 * (scripts/hash-passphrase.mjs). Base64url never contains `:` or `$`, so the
 * delimiter is unambiguous either way.
 * The optional TALASIN_PASSPHRASE_PEPPER is a server-only secret mixed into the
 * passphrase before the KDF runs (defense-in-depth on top of the per-hash salt).
 * Constant-time compare over the derived keys; a generic boolean result.
 */
export function verifyPassphrase(candidate: string): boolean {
  const stored = requireEnv("TALASIN_PASSPHRASE_HASH").trim();
  const pepper = optionalEnv("TALASIN_PASSPHRASE_PEPPER") ?? "";

  const parts = stored.split(stored.includes(":") ? ":" : "$");
  // Expect exactly: ["scrypt", N, r, p, salt, hash].
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64url");
    expected = Buffer.from(parts[5], "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(candidate + pepper, salt, expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_MAX_MEM,
    });
  } catch {
    // Bad params (e.g. N not a power of 2) — treat as a failed verification
    // rather than crashing the login path.
    return false;
  }

  // Both derived and expected are equal-length KDF outputs → direct timing-safe
  // compare, no re-hashing needed.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// --- token sign / verify ----------------------------------------------------

function b64urlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** Build a signed session token with a fresh 14-day window. */
export function issueSessionToken(now: number = Math.floor(Date.now() / 1000)): string {
  const secret = requireEnv("TALASIN_SESSION_SECRET");
  const payload: SessionPayload = { iat: now, exp: now + MAX_AGE_SECONDS };
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const sig = hmac(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a token's HMAC signature and expiry. Returns the payload on success,
 * null on any failure (bad shape, bad signature, expired). Constant-time on the
 * signature compare.
 */
export function verifySessionToken(
  token: string | undefined | null,
  now: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const secret = optionalEnv("TALASIN_SESSION_SECRET");
  if (!secret) return null;

  const expectedSig = hmac(payloadB64, secret);
  if (!safeEqual(sig, expectedSig)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload?.exp !== "number" || payload.exp <= now) return null;
  // Defense-in-depth vs round tokens (lib/games/token.ts): the "round." HMAC
  // domain prefix already makes a round token's signature unverifiable here,
  // but also reject payloads that are structurally not a session ({iat,exp}
  // only — round tokens carry g/v/data and no iat).
  if (typeof payload?.iat !== "number") return null;
  const p = payload as unknown as Record<string, unknown>;
  if ("g" in p || "v" in p || "data" in p) return null;
  return payload;
}

// --- cookie helpers ---------------------------------------------------------

/** Cookie options for the session cookie. Secure only outside dev (localhost has no HTTPS). */
export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  };
}

/**
 * Authoritative session check for pages and Route Handlers.
 * Reads the cookie (async in Next 16), recomputes the HMAC, checks expiry.
 * Throws UnauthorizedError on failure — callers map that to 401 (API) or
 * redirect('/gate') (page).
 */
export async function requireSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!verifySessionToken(token)) {
    throw new UnauthorizedError();
  }
}

/** Non-throwing variant for pages that want to branch on auth state. */
export async function hasValidSession(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return verifySessionToken(token) !== null;
}
