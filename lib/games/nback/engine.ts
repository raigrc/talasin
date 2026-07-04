import { createHash } from "node:crypto";

/**
 * Dual N-back engine (DESIGN_V1.md §3.4) — all pure and deterministic so the
 * server can re-derive the exact trial sequence from the round token's uid at
 * answer time and score raw per-trial responses server-side (anti-cheat).
 *
 * A round = `n` lead-in trials + SCOREABLE_TRIALS scoreable trials. The
 * generator plants exactly PLANTED_MATCHES position matches and PLANTED_MATCHES
 * letter matches (DUAL_MATCHES of them on the same trial) among the scoreable
 * trials; everything else is forced to NOT match — no division-by-zero, and
 * comparable difficulty across sessions.
 */

export const LETTERS = ["C", "H", "K", "L", "Q", "R", "S", "T"] as const;
export const GRID_CELLS = 9; // 3×3 grid positions, 0–8
export const SCOREABLE_TRIALS = 20;
export const PLANTED_MATCHES = 6; // per modality
export const DUAL_MATCHES = 2; // trials that match on BOTH modalities
export const TRIAL_MS = 2500; // pacing, included in the round payload
export const N_MIN = 2;
export const N_MAX = 5;

export interface NBackTrial {
  pos: number; // 0..8
  letter: string; // one of LETTERS
}

export interface ModalityBreakdown {
  hits: number;
  misses: number;
  false_alarms: number;
}

export interface NBackScore {
  score: number; // 0..100
  position: ModalityBreakdown;
  letter: ModalityBreakdown;
}

/** mulberry32 — tiny deterministic PRNG; same seed ⇒ same sequence everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed = first 4 bytes of sha256(uid) as a uint32 — derived identically at answer time. */
export function seedFromUid(uid: string): number {
  const digest = createHash("sha256").update(uid, "utf8").digest();
  return digest.readUInt32BE(0);
}

/** Random int in [0, bound) from the PRNG. */
function randInt(rand: () => number, bound: number): number {
  return Math.floor(rand() * bound);
}

/** Fisher–Yates shuffle (in place) driven by the PRNG. */
function shuffle<T>(arr: T[], rand: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rand, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Generate the full trial list (n lead-in + SCOREABLE_TRIALS scoreable) for a
 * seed + N level. Deterministic: the same (seed, n) always yields the same list.
 */
export function generateSequence(seed: number, n: number): NBackTrial[] {
  const rand = mulberry32(seed);

  // Choose which scoreable slots (0..19) are planted matches per modality,
  // with exactly DUAL_MATCHES overlapping.
  const slots = shuffle(
    Array.from({ length: SCOREABLE_TRIALS }, (_, i) => i),
    rand,
  );
  const posSlots = new Set(slots.slice(0, PLANTED_MATCHES));
  const dual = slots.slice(0, DUAL_MATCHES);
  const rest = slots.slice(PLANTED_MATCHES); // 14 non-position-match slots
  const letterSlots = new Set([...dual, ...rest.slice(0, PLANTED_MATCHES - DUAL_MATCHES)]);

  const total = n + SCOREABLE_TRIALS;
  const trials: NBackTrial[] = [];

  for (let i = 0; i < total; i++) {
    if (i < n) {
      // Lead-in: unconstrained random stimuli.
      trials.push({
        pos: randInt(rand, GRID_CELLS),
        letter: LETTERS[randInt(rand, LETTERS.length)],
      });
      continue;
    }

    const k = i - n; // scoreable slot index
    const back = trials[i - n];

    let pos: number;
    if (posSlots.has(k)) {
      pos = back.pos;
    } else {
      // Force a NON-match: draw from the 8 cells that differ from `back.pos`.
      const r = randInt(rand, GRID_CELLS - 1);
      pos = r >= back.pos ? r + 1 : r;
    }

    let letter: string;
    if (letterSlots.has(k)) {
      letter = back.letter;
    } else {
      const backIdx = LETTERS.indexOf(back.letter as (typeof LETTERS)[number]);
      const r = randInt(rand, LETTERS.length - 1);
      letter = LETTERS[r >= backIdx ? r + 1 : r];
    }

    trials.push({ pos, letter });
  }

  return trials;
}

/**
 * Re-derive per-scoreable-trial ground truth from a trial list: index k in the
 * returned arrays corresponds to overall trial k + n.
 */
export function groundTruth(
  trials: NBackTrial[],
  n: number,
): { posMatch: boolean[]; letterMatch: boolean[] } {
  const posMatch: boolean[] = [];
  const letterMatch: boolean[] = [];
  for (let i = n; i < trials.length; i++) {
    posMatch.push(trials[i].pos === trials[i - n].pos);
    letterMatch.push(trials[i].letter === trials[i - n].letter);
  }
  return { posMatch, letterMatch };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function scoreModality(truth: boolean[], responses: boolean[]): {
  breakdown: ModalityBreakdown;
  acc: number;
} {
  let hits = 0;
  let falseAlarms = 0;
  let matches = 0;
  for (let k = 0; k < truth.length; k++) {
    if (truth[k]) {
      matches += 1;
      if (responses[k]) hits += 1;
    } else if (responses[k]) {
      falseAlarms += 1;
    }
  }
  // Generator plants PLANTED_MATCHES per modality, so matches > 0 always; the
  // guard keeps the math safe if the constant ever changes.
  const acc = matches > 0 ? clamp01((hits - falseAlarms) / matches) : 0;
  return {
    breakdown: { hits, misses: matches - hits, false_alarms: falseAlarms },
    acc,
  };
}

/**
 * Normalized 0–100 session score (DESIGN_V1.md §3.4): per modality
 * acc = clamp((hits − false_alarms) / planted_matches, 0, 1);
 * score = round(100 × (acc_position + acc_letter) / 2).
 * "Press every trial" scores 0 — false alarms cancel hits.
 */
export function scoreSession(
  truth: { posMatch: boolean[]; letterMatch: boolean[] },
  responses: { position: boolean[]; letter: boolean[] },
): NBackScore {
  const pos = scoreModality(truth.posMatch, responses.position);
  const letter = scoreModality(truth.letterMatch, responses.letter);
  return {
    score: Math.round(100 * ((pos.acc + letter.acc) / 2)),
    position: pos.breakdown,
    letter: letter.breakdown,
  };
}

/** N-level progression: ≥80 → n+1 (cap N_MAX), <50 → n−1 (floor N_MIN), else same. */
export function nextLevel(lastN: number, lastScore: number): number {
  let n = Math.min(N_MAX, Math.max(N_MIN, Math.round(lastN)));
  if (lastScore >= 80) n = Math.min(N_MAX, n + 1);
  else if (lastScore < 50) n = Math.max(N_MIN, n - 1);
  return n;
}
