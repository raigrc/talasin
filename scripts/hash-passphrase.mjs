#!/usr/bin/env node
// Generate TALASIN_PASSPHRASE_HASH from a plaintext passphrase + pepper.
//   node scripts/hash-passphrase.mjs "your-passphrase" "your-pepper"
// The FIRST argument is what you will TYPE at /gate. The SECOND must match
// TALASIN_PASSPHRASE_PEPPER in .env.local exactly.
//
// Output format (self-describing so params can evolve without a code change):
//   scrypt:N:r:p:saltB64url:hashB64url
// Colon-delimited ON PURPOSE: the older `$`-delimited variant gets silently
// mangled by Next's .env variable expansion ($VAR) unless every `$` is escaped
// as `\$`. lib/session.ts#verifyPassphrase accepts both delimiters.
// scrypt is a memory-hard KDF; each hash carries its own random salt and cost
// params.
import { randomBytes, scryptSync } from "node:crypto";

const [, , passphrase, pepper = ""] = process.argv;
if (!passphrase) {
  console.error('Usage: node scripts/hash-passphrase.mjs "passphrase" "pepper"');
  process.exit(1);
}

// scrypt cost params — keep in sync with lib/session.ts. N is the CPU/memory
// work factor (power of 2), r the block size, p the parallelization factor.
const N = 16384;
const r = 8;
const p = 1;
const KEYLEN = 32; // 256-bit derived key

const salt = randomBytes(16);
const derived = scryptSync(passphrase + pepper, salt, KEYLEN, {
  N,
  r,
  p,
  maxmem: 64 * 1024 * 1024,
});

const out = [
  "scrypt",
  N,
  r,
  p,
  salt.toString("base64url"),
  derived.toString("base64url"),
].join(":");

console.log("Ready to paste into .env.local (and the Vercel env dashboard):\n");
console.log(`TALASIN_PASSPHRASE_HASH=${out}`);
console.log(`TALASIN_PASSPHRASE_PEPPER=${pepper}`);
console.log(`\nAt /gate you type: ${passphrase}`);
