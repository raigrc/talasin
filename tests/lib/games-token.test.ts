import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signRoundToken, verifyRoundToken } from "@/lib/games/token";
import { issueSessionToken, verifySessionToken } from "@/lib/session";

/**
 * HMAC round-token tests (lib/games/token.ts, DESIGN_V1.md §3.3). Security
 * relevant: tokens carry the ground-truth seed/form for stateless rounds, so
 * verification must fail closed on tamper/expiry/cross-game/cross-domain use.
 */

const ORIGINAL_ENV = { ...process.env };
const SECRET = "token-test-secret";

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, TALASIN_SESSION_SECRET: SECRET };
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("sign → verify round-trip", () => {
  it("returns the uid and data for a fresh valid token", () => {
    const token = signRoundToken("nback", { n: 3 }, 60, "uid-123");
    const verified = verifyRoundToken<{ n: number }>(token, "nback");
    expect(verified).toEqual({ uid: "uid-123", data: { n: 3 } });
  });

  it("generates a fresh UUID uid when none is supplied", () => {
    const t1 = signRoundToken("syllogism", {}, 60);
    const t2 = signRoundToken("syllogism", {}, 60);
    const v1 = verifyRoundToken(t1, "syllogism");
    const v2 = verifyRoundToken(t2, "syllogism");
    expect(v1?.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(v1?.uid).not.toBe(v2?.uid);
  });
});

describe("expiry", () => {
  it("verifies until the TTL elapses, then fails", () => {
    const now = 1_700_000_000;
    const token = signRoundToken("nback", { n: 2 }, 60, "u", now);
    expect(verifyRoundToken(token, "nback", now + 59)).not.toBeNull();
    expect(verifyRoundToken(token, "nback", now + 60)).toBeNull(); // exp <= now fails
    expect(verifyRoundToken(token, "nback", now + 61)).toBeNull();
  });
});

describe("fails closed", () => {
  it("rejects a tampered payload (signature mismatch)", () => {
    const token = signRoundToken("nback", { n: 2 }, 60);
    const [payload, sig] = token.split(".");
    // Re-encode the payload with n bumped to 5 — signature no longer matches.
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    decoded.data.n = 5;
    const forged =
      Buffer.from(JSON.stringify(decoded)).toString("base64url") + "." + sig;
    expect(verifyRoundToken(forged, "nback")).toBeNull();
  });

  it("rejects a tampered signature", () => {
    const token = signRoundToken("nback", { n: 2 }, 60);
    const flipped = token.slice(0, -2) + (token.endsWith("AA") ? "BB" : "AA");
    expect(verifyRoundToken(flipped, "nback")).toBeNull();
  });

  it("rejects a token for a different game type (cross-game replay)", () => {
    const token = signRoundToken("nback", { n: 2 }, 60);
    expect(verifyRoundToken(token, "syllogism")).toBeNull();
  });

  it("rejects malformed inputs (empty, no dot, dot at the edges)", () => {
    expect(verifyRoundToken(null, "nback")).toBeNull();
    expect(verifyRoundToken(undefined, "nback")).toBeNull();
    expect(verifyRoundToken("", "nback")).toBeNull();
    expect(verifyRoundToken("nodothere", "nback")).toBeNull();
    expect(verifyRoundToken(".sigonly", "nback")).toBeNull();
    expect(verifyRoundToken("payloadonly.", "nback")).toBeNull();
    expect(verifyRoundToken("not-base64!!.not-a-sig", "nback")).toBeNull();
  });

  it("verification returns null (does not throw) when the secret is missing", () => {
    const token = signRoundToken("nback", { n: 2 }, 60);
    delete process.env.TALASIN_SESSION_SECRET;
    expect(verifyRoundToken(token, "nback")).toBeNull();
  });

  it("signing throws when the secret is missing", () => {
    delete process.env.TALASIN_SESSION_SECRET;
    expect(() => signRoundToken("nback", { n: 2 }, 60)).toThrow(/TALASIN_SESSION_SECRET/);
  });
});

describe("domain separation from session tokens (same secret, 'round.' prefix)", () => {
  it("a session token never verifies as a round token", () => {
    const sessionToken = issueSessionToken();
    expect(verifyRoundToken(sessionToken, "nback")).toBeNull();
    expect(verifyRoundToken(sessionToken, "syllogism")).toBeNull();
  });

  it("a round token never verifies as a session token", () => {
    const roundToken = signRoundToken("nback", { n: 2 }, 60);
    expect(verifySessionToken(roundToken)).toBeNull();
  });
});
