import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";

/**
 * Passphrase / session-token tests (lib/session.ts, DESIGN.md §4). These are
 * pure crypto/logic — no DB, no network — but security-critical, so covered
 * even though not explicitly called out in the QA brief's priority list.
 *
 * The passphrase hash uses scrypt (a memory-hard KDF) in the self-describing
 * format `scrypt$N$r$p$saltB64url$hashB64url`. `makeScryptHash` mirrors what
 * scripts/hash-passphrase.mjs emits so these tests exercise the real format.
 */

// Keep in sync with lib/session.ts / scripts/hash-passphrase.mjs.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

function makeScryptHash(passphrase: string, pepper: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(passphrase + pepper, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/** Colon-delimited variant — what scripts/hash-passphrase.mjs emits now
 *  ($ gets mangled by Next's .env variable expansion; both are accepted). */
function makeColonScryptHash(passphrase: string, pepper: string): string {
  return makeScryptHash(passphrase, pepper).replaceAll("$", ":");
}

const ORIGINAL_ENV = { ...process.env };

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("verifyPassphrase", () => {
  it("accepts the colon-delimited format (current emit; .env-expansion-safe)", async () => {
    const pepper = "test-pepper";
    const passphrase = "colon-format-test-phrase";
    setEnv({
      TALASIN_PASSPHRASE_HASH: makeColonScryptHash(passphrase, pepper),
      TALASIN_PASSPHRASE_PEPPER: pepper,
    });
    const { verifyPassphrase } = await import("@/lib/session");
    expect(verifyPassphrase(passphrase)).toBe(true);
    expect(verifyPassphrase("wrong")).toBe(false);
  });

  it("accepts the correct passphrase + pepper combination", async () => {
    const pepper = "test-pepper";
    const passphrase = "correct horse battery staple";
    const hash = makeScryptHash(passphrase, pepper);
    setEnv({ TALASIN_PASSPHRASE_HASH: hash, TALASIN_PASSPHRASE_PEPPER: pepper });

    const { verifyPassphrase } = await import("@/lib/session");
    expect(verifyPassphrase(passphrase)).toBe(true);
  });

  it("rejects a wrong passphrase", async () => {
    const pepper = "test-pepper";
    const hash = makeScryptHash("correct", pepper);
    setEnv({ TALASIN_PASSPHRASE_HASH: hash, TALASIN_PASSPHRASE_PEPPER: pepper });

    const { verifyPassphrase } = await import("@/lib/session");
    expect(verifyPassphrase("wrong")).toBe(false);
  });

  it("rejects when the pepper does not match the one used at hash-time", async () => {
    const passphrase = "abc";
    const hash = makeScryptHash(passphrase, "right-pepper");
    setEnv({ TALASIN_PASSPHRASE_HASH: hash, TALASIN_PASSPHRASE_PEPPER: "wrong-pepper" });

    const { verifyPassphrase } = await import("@/lib/session");
    expect(verifyPassphrase(passphrase)).toBe(false);
  });

  it("rejects a malformed / non-scrypt stored hash (e.g. a legacy sha256 hex value)", async () => {
    // A bare 64-char hex string is not the scrypt$... format → generic false,
    // never a crash and never a match.
    setEnv({
      TALASIN_PASSPHRASE_HASH: "a".repeat(64),
      TALASIN_PASSPHRASE_PEPPER: "p",
    });
    const { verifyPassphrase } = await import("@/lib/session");
    expect(verifyPassphrase("anything")).toBe(false);
  });

  it("throws if TALASIN_PASSPHRASE_HASH is not configured (maps to 500 config error at the route)", async () => {
    setEnv({ TALASIN_PASSPHRASE_HASH: undefined, TALASIN_PASSPHRASE_PEPPER: "p" });
    const { verifyPassphrase } = await import("@/lib/session");
    expect(() => verifyPassphrase("anything")).toThrow(/Missing required environment variable/);
  });

  it("empty-string passphrase is rejected, not treated as a wildcard match", async () => {
    const pepper = "p";
    const hash = makeScryptHash("real-pass", pepper);
    setEnv({ TALASIN_PASSPHRASE_HASH: hash, TALASIN_PASSPHRASE_PEPPER: pepper });

    const { verifyPassphrase } = await import("@/lib/session");
    expect(verifyPassphrase("")).toBe(false);
  });

  it("missing pepper env still works if pepper was empty at hash-time (optional pepper)", async () => {
    const passphrase = "no-pepper-pass";
    const hash = makeScryptHash(passphrase, "");
    setEnv({ TALASIN_PASSPHRASE_HASH: hash, TALASIN_PASSPHRASE_PEPPER: undefined });

    const { verifyPassphrase } = await import("@/lib/session");
    expect(verifyPassphrase(passphrase)).toBe(true);
  });
});

describe("issueSessionToken / verifySessionToken", () => {
  it("a freshly issued token verifies successfully", async () => {
    setEnv({ TALASIN_SESSION_SECRET: "secret-key" });
    const { issueSessionToken, verifySessionToken } = await import("@/lib/session");
    const token = issueSessionToken();
    const payload = verifySessionToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.exp).toBeGreaterThan(payload!.iat);
  });

  it("rejects an expired token", async () => {
    setEnv({ TALASIN_SESSION_SECRET: "secret-key" });
    const { issueSessionToken, verifySessionToken } = await import("@/lib/session");
    const past = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 20; // 20 days ago (> 14-day max age)
    const token = issueSessionToken(past);
    expect(verifySessionToken(token)).toBeNull();
  });

  it("rejects a token signed with a different secret (tampered/rotated secret)", async () => {
    setEnv({ TALASIN_SESSION_SECRET: "secret-a" });
    const { issueSessionToken } = await import("@/lib/session");
    const token = issueSessionToken();

    setEnv({ TALASIN_SESSION_SECRET: "secret-b" });
    const { verifySessionToken } = await import("@/lib/session");
    expect(verifySessionToken(token)).toBeNull();
  });

  it("rejects a token with a tampered payload (signature mismatch)", async () => {
    setEnv({ TALASIN_SESSION_SECRET: "secret-key" });
    const { issueSessionToken, verifySessionToken } = await import("@/lib/session");
    const token = issueSessionToken();
    const [payloadB64, sig] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ iat: 0, exp: 99999999999 }),
    ).toString("base64url");
    const tampered = `${tamperedPayload}.${sig}`;
    expect(verifySessionToken(tampered)).toBeNull();
    expect(payloadB64).not.toBe(tamperedPayload); // sanity: tampering actually changed it
  });

  it("rejects null/undefined/empty token", async () => {
    setEnv({ TALASIN_SESSION_SECRET: "secret-key" });
    const { verifySessionToken } = await import("@/lib/session");
    expect(verifySessionToken(null)).toBeNull();
    expect(verifySessionToken(undefined)).toBeNull();
    expect(verifySessionToken("")).toBeNull();
  });

  it("rejects a malformed token with no '.' separator", async () => {
    setEnv({ TALASIN_SESSION_SECRET: "secret-key" });
    const { verifySessionToken } = await import("@/lib/session");
    expect(verifySessionToken("not-a-valid-token")).toBeNull();
  });

  it("rejects a token with an empty signature part (trailing dot)", async () => {
    setEnv({ TALASIN_SESSION_SECRET: "secret-key" });
    const { verifySessionToken } = await import("@/lib/session");
    expect(verifySessionToken("payload.")).toBeNull();
  });

  it("rejects a token whose payload is not valid base64url JSON", async () => {
    setEnv({ TALASIN_SESSION_SECRET: "secret-key" });
    const { verifySessionToken, issueSessionToken } = await import("@/lib/session");
    const token = issueSessionToken();
    const [, sig] = token.split(".");
    expect(verifySessionToken(`not-valid-base64json.${sig}`)).toBeNull();
  });

  it("returns null (not throw) if TALASIN_SESSION_SECRET is unset when verifying", async () => {
    setEnv({ TALASIN_SESSION_SECRET: undefined });
    const { verifySessionToken } = await import("@/lib/session");
    expect(verifySessionToken("anything.here")).toBeNull();
  });

  it("token expiring exactly 'now' is treated as expired (exp <= now)", async () => {
    setEnv({ TALASIN_SESSION_SECRET: "secret-key" });
    const { issueSessionToken, verifySessionToken } = await import("@/lib/session");
    const now = Math.floor(Date.now() / 1000);
    // Issue with iat = now - MAX_AGE so exp == now exactly.
    const MAX_AGE = 60 * 60 * 24 * 14;
    const token = issueSessionToken(now - MAX_AGE);
    expect(verifySessionToken(token, now)).toBeNull();
  });
});
