import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { requireEnv, optionalEnv } from "../env";
import { safeEqual } from "../session";
import type { GameType } from "./types";

/**
 * Stateless HMAC-signed round tokens (DESIGN_V1.md §3.3). N-back and syllogism
 * rounds are generated per request — no rounds tables. Ground truth (or the
 * seed that regenerates it) travels in a signed token the client must echo back.
 *
 * - Reuses TALASIN_SESSION_SECRET with the "round." domain-separation prefix,
 *   so a round token can never verify as a session token and vice versa.
 * - Tokens are SIGNED, not encrypted — the payload is base64-readable by the
 *   client. Never put anything in `data` the client shouldn't see beyond what
 *   the round itself already shows (see DESIGN_V1.md §8 anti-cheat stance).
 * - Replay is handled downstream: `uid` is stored as detail.round_uid and the
 *   partial unique index makes a second insert fail (409).
 */

const DOMAIN_PREFIX = "round.";

interface RoundTokenPayload<T> {
  v: 1;
  g: GameType;
  uid: string;
  exp: number; // unix seconds
  data: T;
}

function hmacRound(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(DOMAIN_PREFIX + payloadB64)
    .digest("base64url");
}

/**
 * Sign a round token for game `g` carrying `data`, valid for `ttlSec` seconds.
 * `uid` defaults to a fresh UUID; callers that derive state from the uid (n-back
 * seeds) pass their own so the round and the token agree.
 */
export function signRoundToken(
  g: GameType,
  data: object,
  ttlSec: number,
  uid: string = randomUUID(),
  now: number = Math.floor(Date.now() / 1000),
): string {
  const secret = requireEnv("TALASIN_SESSION_SECRET");
  const payload: RoundTokenPayload<object> = { v: 1, g, uid, exp: now + ttlSec, data };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmacRound(payloadB64, secret);
  return `${payloadB64}.${sig}`;
}

/**
 * Verify a round token's signature, game type, and expiry. Returns the uid +
 * data on success, null on ANY failure (fails closed). Constant-time signature
 * compare. Never logs token contents.
 */
export function verifyRoundToken<T = Record<string, unknown>>(
  token: string | undefined | null,
  g: GameType,
  now: number = Math.floor(Date.now() / 1000),
): { uid: string; data: T } | null {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const secret = optionalEnv("TALASIN_SESSION_SECRET");
  if (!secret) return null;

  const expectedSig = hmacRound(payloadB64, secret);
  if (!safeEqual(sig, expectedSig)) return null;

  let payload: RoundTokenPayload<T>;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.v !== 1 || payload.g !== g) return null;
  if (typeof payload.uid !== "string" || payload.uid.length === 0) return null;
  if (typeof payload.exp !== "number" || payload.exp <= now) return null;
  return { uid: payload.uid, data: payload.data };
}
