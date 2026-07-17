import { createHash } from "node:crypto";
import { mulberry32, seedFromUid } from "../nback/engine";
import { FAMILIES, type SequenceFamily } from "./families";

/**
 * Number Sequence round composition (DESIGN_V2_GAMES.md §4.2–§4.4). Pure and
 * deterministic: the same (family, params, uid) always yields the same terms
 * AND the same option order, so answer() re-derives the exact round from the
 * signed token — the client never sees the correct value/index pre-answer.
 */

export interface ComposedSequenceRound {
  family: string;
  difficulty: number;
  shown: number[];
  correct: number;
  options: number[]; // 4 shuffled choices, exactly one correct
  correctIndex: number;
  explanation: string;
  params_hash: string;
}

/** Look a family up by id; null for unknown ids (e.g. a token minted pre-rename). */
export function getFamily(id: string): SequenceFamily | null {
  return FAMILIES.find((f) => f.id === id) ?? null;
}

/** Stable hash of the exact (family, params) combo — stored in detail.params_hash. */
export function paramsHash(familyId: string, p: number[]): string {
  return createHash("sha256")
    .update(`${familyId}|${p.join(",")}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

/**
 * Token params are only trusted if every value is an integer inside the
 * family's declared range and the family constraint holds (fails closed —
 * a violating token 410s upstream).
 */
export function validParams(family: SequenceFamily, p: unknown): p is number[] {
  if (!Array.isArray(p) || p.length !== family.params.length) return false;
  for (let i = 0; i < p.length; i++) {
    const v = p[i];
    if (!Number.isInteger(v)) return false;
    if (v < family.params[i].lo || v > family.params[i].hi) return false;
  }
  return !family.constraint || family.constraint(p as number[]);
}

/**
 * Exactly 3 distinct wrong options: the family's priority-ordered mistake
 * rules first (filtered: ≠ correct, ∉ shown, pairwise distinct, integer),
 * then a deterministic fallback ladder correct ± j·u (u = max(1, |Δlast|))
 * that skips used/shown values — always terminates (§4.3).
 */
export function buildDistractors(
  family: SequenceFamily,
  p: number[],
  shown: number[],
  correct: number,
): number[] {
  const used = new Set<number>([correct, ...shown]);
  const out: number[] = [];
  for (const c of family.distractors(shown, correct, p)) {
    if (out.length === 3) break;
    if (!Number.isInteger(c) || used.has(c)) continue;
    used.add(c);
    out.push(c);
  }
  const dLast = Math.abs(shown[shown.length - 1] - shown[shown.length - 2]);
  const u = Math.max(1, dLast);
  for (let j = 1; out.length < 3; j++) {
    for (const cand of [correct + j * u, correct - j * u]) {
      if (out.length === 3) break;
      if (used.has(cand)) continue;
      used.add(cand);
      out.push(cand);
    }
  }
  return out;
}

/**
 * Compose the concrete round for a (family, params, uid) pick. The option
 * shuffle is seeded from the uid (n-back's mulberry32 + seedFromUid), so
 * answer() reproduces the identical order from the token alone.
 */
export function composeRound(
  familyId: string,
  p: number[],
  uid: string,
): ComposedSequenceRound {
  const family = getFamily(familyId);
  if (!family) throw new Error(`unknown sequence family: ${familyId}`);

  const { shown, correct } = family.terms(p);
  const options = [correct, ...buildDistractors(family, p, shown, correct)];
  const rand = mulberry32(seedFromUid(uid));
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  return {
    family: family.id,
    difficulty: family.difficulty,
    shown,
    correct,
    options,
    correctIndex: options.indexOf(correct),
    explanation: family.explain(p, shown, correct),
    params_hash: paramsHash(family.id, p),
  };
}

export const MAX_PICK_TRIES = 80;

/**
 * Random (family, params) pick at a difficulty, excluding recently-seen combos
 * (by params_hash). With pools of 910/9,568/600 and a ≤300-hash exclusion
 * window, rejection sampling almost always lands on the first try; after
 * MAX_PICK_TRIES we accept a repeat rather than loop forever (the pool can
 * never be exhausted, only briefly unlucky — syllogism's exact stance).
 */
export function pickRound(
  difficulty: number,
  recentHashes: ReadonlySet<string>,
  rand: () => number = Math.random,
): { family: string; p: number[]; params_hash: string } {
  const pool = FAMILIES.filter((f) => f.difficulty === difficulty);
  if (pool.length === 0) throw new Error(`no sequence families at difficulty ${difficulty}`);

  let candidate: { family: string; p: number[]; params_hash: string } | null = null;
  for (let i = 0; i < MAX_PICK_TRIES; i++) {
    const family = pool[Math.floor(rand() * pool.length)];
    const p = family.sample(rand);
    candidate = { family: family.id, p, params_hash: paramsHash(family.id, p) };
    if (!recentHashes.has(candidate.params_hash)) return candidate;
  }
  return candidate as { family: string; p: number[]; params_hash: string };
}
