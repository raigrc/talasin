/**
 * Number Sequence family bank (DESIGN_V2_GAMES.md §4.1). Pure data + per-family
 * logic, zero Gemini: 13 families × integer parameter ranges = 11,078 distinct
 * rounds (D1 = 910, D2 = 9,568, D3 = 600) with DETERMINISTIC answers and
 * hand-written explanations.
 *
 * Each family declares its canonical param order + ranges (the sanity bounds
 * answer() validates token params against), a `sample` that always returns a
 * constraint-valid param set, `terms` (shown terms + the correct next term),
 * priority-ordered rule-based `distractors` (each encodes a REAL induction
 * mistake — never noise), and a deterministic `explain` teach-back.
 *
 * Every shown term, answer, and distractor stays within |v| ≤ 20,000 by
 * construction — asserted by the full-pool sweep in tests/lib/sequence.test.ts.
 */

export interface ParamRange {
  lo: number;
  hi: number;
}

export interface SequenceFamily {
  id: string;
  difficulty: 1 | 2 | 3;
  shown: 4 | 5; // terms displayed before the "?"
  params: ParamRange[]; // canonical order; doubles as answer-time sanity bounds
  /** Extra validity rule beyond the ranges (e.g. geom's value cap). */
  constraint?: (p: number[]) => boolean;
  /** Draw a constraint-valid param set from the PRNG (no rejection needed). */
  sample: (rand: () => number) => number[];
  terms: (p: number[]) => { shown: number[]; correct: number };
  /** Priority-ordered candidates; the engine filters + fills to exactly 3. */
  distractors: (shown: number[], correct: number, p: number[]) => number[];
  explain: (p: number[], shown: number[], correct: number) => string;
}

/** Random int in [lo, hi] (inclusive) from the PRNG. */
function intIn(rand: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rand() * (hi - lo + 1));
}

/** First 30 primes — index 30 (113) is the deepest `primes` round reaches. */
export const PRIMES: readonly number[] = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71,
  73, 79, 83, 89, 97, 101, 103, 107, 109, 113,
];

/** Triangular number T(n) = n(n+1)/2. */
function tri(n: number): number {
  return (n * (n + 1)) / 2;
}

/** "plus 3" / "minus 3" suffix for the offset families (empty when c = 0). */
function offsetText(c: number): string {
  if (c === 0) return "";
  return c > 0 ? ` plus ${c}` : ` minus ${-c}`;
}

export const FAMILIES: SequenceFamily[] = [
  // --- difficulty 1 ----------------------------------------------------------
  {
    id: "arith_up",
    difficulty: 1,
    shown: 4,
    params: [
      { lo: 2, hi: 30 }, // a
      { lo: 2, hi: 9 }, // s
    ],
    sample: (rand) => [intIn(rand, 2, 30), intIn(rand, 2, 9)],
    terms: ([a, s]) => ({
      shown: [a, a + s, a + 2 * s, a + 3 * s],
      correct: a + 4 * s,
    }),
    distractors: (shown, correct, [, s]) => {
      const prev = shown[shown.length - 1];
      // Off-by-one on the difference (both signs), step applied twice, sign slip.
      return [prev + (s - 1), prev + (s + 1), prev + 2 * s, prev - s];
    },
    explain: ([, s], shown, correct) =>
      `Add ${s} each step: ${shown[shown.length - 1]} + ${s} = ${correct}.`,
  },
  {
    id: "arith_down",
    difficulty: 1,
    shown: 4,
    params: [
      { lo: 40, hi: 120 }, // a
      { lo: 2, hi: 9 }, // s
    ],
    sample: (rand) => [intIn(rand, 40, 120), intIn(rand, 2, 9)],
    terms: ([a, s]) => ({
      shown: [a, a - s, a - 2 * s, a - 3 * s],
      correct: a - 4 * s,
    }),
    distractors: (shown, correct, [, s]) => {
      const prev = shown[shown.length - 1];
      return [prev - (s - 1), prev - (s + 1), prev - 2 * s, prev + s];
    },
    explain: ([, s], shown, correct) =>
      `Subtract ${s} each step: ${shown[shown.length - 1]} - ${s} = ${correct}.`,
  },
  {
    id: "geom",
    difficulty: 1,
    shown: 4,
    params: [
      { lo: 1, hi: 12 }, // a
      { lo: 2, hi: 4 }, // r
    ],
    constraint: ([a, r]) => a * r ** 4 <= 1600,
    sample: (rand) => {
      // r first, then a within r's cap — always constraint-valid, no rejection.
      const r = intIn(rand, 2, 4);
      const a = intIn(rand, 1, r === 4 ? 6 : 12);
      return [a, r];
    },
    terms: ([a, r]) => ({
      shown: [a, a * r, a * r * r, a * r * r * r],
      correct: a * r ** 4,
    }),
    distractors: (shown, correct, [, r]) => {
      const prev = shown[shown.length - 1];
      // Mis-read ratio (r=2 gives prev itself → filtered as a shown term),
      // ratio off by ±r, ratio treated as a difference.
      return [prev * (r + 1), prev * (r - 1), prev * r + r, prev * r - r, prev + r];
    },
    explain: ([, r], shown, correct) =>
      `Multiply by ${r} each step: ${shown[shown.length - 1]} × ${r} = ${correct}.`,
  },

  // --- difficulty 2 ----------------------------------------------------------
  {
    id: "quadratic",
    difficulty: 2,
    shown: 5,
    params: [
      { lo: 1, hi: 20 }, // a
      { lo: 2, hi: 7 }, // d
      { lo: 1, hi: 4 }, // k
    ],
    sample: (rand) => [intIn(rand, 1, 20), intIn(rand, 2, 7), intIn(rand, 1, 4)],
    terms: ([a, d, k]) => {
      // Δᵢ = d + k·(i−1): gaps grow by k each step.
      const shown = [a];
      for (let i = 0; i < 4; i++) shown.push(shown[i] + d + k * i);
      return { shown, correct: shown[4] + d + 4 * k };
    },
    distractors: (shown, correct) => {
      const prev = shown[shown.length - 1];
      const dLast = prev - shown[shown.length - 2];
      const dPrev = shown[shown.length - 2] - shown[shown.length - 3];
      const u = Math.max(1, dLast - dPrev); // second-order increment
      // "Applied the previous delta again" — THE canonical mistake — then ±u.
      return [prev + dLast, prev + dLast + u, correct + u, correct - u];
    },
    explain: ([, d, k], shown, correct) =>
      `The gaps grow by ${k} each step (+${d}, +${d + k}, +${d + 2 * k}, …): ` +
      `${shown[shown.length - 1]} + ${d + 4 * k} = ${correct}.`,
  },
  {
    id: "alt_add_sub",
    difficulty: 2,
    shown: 5,
    params: [
      { lo: 10, hi: 40 }, // a
      { lo: 5, hi: 12 }, // p (add step; p > q always by range)
      { lo: 1, hi: 4 }, // q (subtract step)
    ],
    sample: (rand) => [intIn(rand, 10, 40), intIn(rand, 5, 12), intIn(rand, 1, 4)],
    terms: ([a, p, q]) => {
      const shown = [a, a + p, a + p - q, a + 2 * p - q, a + 2 * p - 2 * q];
      // After 5 shown terms the next alternating op is +p.
      return { shown, correct: shown[4] + p };
    },
    distractors: (shown, correct, [, p, q]) => {
      const prev = shown[shown.length - 1];
      // Wrong alternating op, both ops collapsed, sign slip on the wrong op.
      return [prev - q, prev + p - q, prev + q];
    },
    explain: ([, p, q], shown, correct) =>
      `Alternate +${p} and -${q}: after a -${q} step comes +${p}, so ` +
      `${shown[shown.length - 1]} + ${p} = ${correct}.`,
  },
  {
    id: "interleave",
    difficulty: 2,
    shown: 5,
    params: [
      { lo: 1, hi: 20 }, // a1
      { lo: 2, hi: 6 }, // d1
      { lo: 1, hi: 20 }, // a2
      { lo: 2, hi: 6 }, // d2
    ],
    constraint: ([, d1, , d2]) => d1 !== d2,
    sample: (rand) => {
      const a1 = intIn(rand, 1, 20);
      const d1 = intIn(rand, 2, 6);
      const a2 = intIn(rand, 1, 20);
      // Draw d2 from the 4 values ≠ d1 (skip trick — no rejection loop).
      let d2 = 2 + Math.floor(rand() * 4);
      if (d2 >= d1) d2 += 1;
      return [a1, d1, a2, d2];
    },
    terms: ([a1, d1, a2, d2]) => ({
      // Threads interleave: a1, a2, a1+d1, a2+d2, a1+2d1 — next is thread 2.
      shown: [a1, a2, a1 + d1, a2 + d2, a1 + 2 * d1],
      correct: a2 + 2 * d2,
    }),
    distractors: (shown, correct, [, d1, , d2]) => {
      const lastShown = shown[shown.length - 1];
      // Continued the WRONG thread, used the other thread's step, ±1.
      return [lastShown + d1, correct + (d1 - d2), correct + 1, correct - 1];
    },
    explain: ([, d1, a2, d2], _shown, correct) =>
      `Two threads interleave: odd positions step +${d1}, even positions step +${d2}. ` +
      `The next term continues the even thread: ${a2 + d2} + ${d2} = ${correct}.`,
  },
  {
    id: "affine",
    difficulty: 2,
    shown: 4,
    params: [
      { lo: 1, hi: 8 }, // a
      { lo: 2, hi: 3 }, // m
      { lo: 1, hi: 6 }, // c
    ],
    sample: (rand) => [intIn(rand, 1, 8), intIn(rand, 2, 3), intIn(rand, 1, 6)],
    terms: ([a, m, c]) => {
      const shown = [a];
      for (let i = 0; i < 3; i++) shown.push(m * shown[i] + c);
      return { shown, correct: m * shown[3] + c };
    },
    distractors: (shown, correct, [, m, c]) => {
      const prev = shown[shown.length - 1];
      // Forgot +c, doubled the constant, off-by-one on the multiplier.
      return [m * prev, m * prev + 2 * c, (m + 1) * prev + c];
    },
    explain: ([, m, c], shown, correct) =>
      `Each term is ${m} × previous + ${c}: ` +
      `${m} × ${shown[shown.length - 1]} + ${c} = ${correct}.`,
  },

  // --- difficulty 3 ----------------------------------------------------------
  {
    id: "squares",
    difficulty: 3,
    shown: 5,
    params: [
      { lo: 1, hi: 10 }, // n0
      { lo: -5, hi: 5 }, // c
    ],
    sample: (rand) => [intIn(rand, 1, 10), intIn(rand, -5, 5)],
    terms: ([n0, c]) => ({
      shown: [0, 1, 2, 3, 4].map((i) => (n0 + i) ** 2 + c),
      correct: (n0 + 5) ** 2 + c,
    }),
    distractors: (shown, correct) => {
      const prev = shown[shown.length - 1];
      const dLast = prev - shown[shown.length - 2];
      const dPrev = shown[shown.length - 2] - shown[shown.length - 3];
      const u = Math.max(1, dLast - dPrev);
      return [prev + dLast, prev + dLast + u, correct + u, correct - u];
    },
    explain: ([n0, c], _shown, correct) => {
      const n = n0 + 5;
      return c === 0
        ? `Consecutive squares: ${n}² = ${correct}.`
        : `Consecutive squares${offsetText(c)}: ${n}² ${c > 0 ? "+" : "-"} ${Math.abs(c)} = ${correct}.`;
    },
  },
  {
    id: "cubes",
    difficulty: 3,
    shown: 4,
    params: [
      { lo: 1, hi: 7 }, // n0
      { lo: -3, hi: 3 }, // c
    ],
    sample: (rand) => [intIn(rand, 1, 7), intIn(rand, -3, 3)],
    terms: ([n0, c]) => ({
      shown: [0, 1, 2, 3].map((i) => (n0 + i) ** 3 + c),
      correct: (n0 + 4) ** 3 + c,
    }),
    distractors: (shown, correct) => {
      const prev = shown[shown.length - 1];
      const dLast = prev - shown[shown.length - 2];
      const dPrev = shown[shown.length - 2] - shown[shown.length - 3];
      const u = Math.max(1, dLast - dPrev);
      return [prev + dLast, prev + dLast + u, correct + u, correct - u];
    },
    explain: ([n0, c], _shown, correct) => {
      const n = n0 + 4;
      return c === 0
        ? `Consecutive cubes: ${n}³ = ${correct}.`
        : `Consecutive cubes${offsetText(c)}: ${n}³ ${c > 0 ? "+" : "-"} ${Math.abs(c)} = ${correct}.`;
    },
  },
  {
    id: "primes",
    difficulty: 3,
    shown: 5,
    params: [
      { lo: 1, hi: 25 }, // s (1-based start index into PRIMES)
      { lo: -1, hi: 1 }, // c
    ],
    sample: (rand) => [intIn(rand, 1, 25), intIn(rand, -1, 1)],
    terms: ([s, c]) => ({
      shown: [0, 1, 2, 3, 4].map((i) => PRIMES[s - 1 + i] + c),
      correct: PRIMES[s + 4] + c,
    }),
    distractors: (shown, correct) => {
      const prev = shown[shown.length - 1];
      const dLast = prev - shown[shown.length - 2];
      // Assumed the gap repeats; composite neighbors that "look prime-ish".
      return [prev + dLast, correct + 2, correct - 2];
    },
    explain: ([s, c], _shown, correct) => {
      const prevPrime = PRIMES[s + 3];
      const nextPrime = PRIMES[s + 4];
      return c === 0
        ? `Consecutive primes: the next prime after ${prevPrime} is ${correct}.`
        : `Consecutive primes${offsetText(c)}: the next prime after ${prevPrime} is ` +
            `${nextPrime}, ${c > 0 ? "+" : "-"} ${Math.abs(c)} = ${correct}.`;
    },
  },
  {
    id: "fib_like",
    difficulty: 3,
    shown: 5,
    params: [
      { lo: 1, hi: 12 }, // a
      { lo: 1, hi: 12 }, // b
    ],
    sample: (rand) => [intIn(rand, 1, 12), intIn(rand, 1, 12)],
    terms: ([a, b]) => {
      const shown = [a, b, a + b, a + 2 * b, 2 * a + 3 * b];
      return { shown, correct: shown[3] + shown[4] };
    },
    distractors: (shown, correct) => {
      const t4 = shown[3];
      const t5 = shown[4];
      // Arithmetic continuation of the last gap, doubled instead of summed, ±1.
      return [2 * t5 - t4, 2 * t5, correct + 1, correct - 1];
    },
    explain: (_p, shown, correct) =>
      `Each term is the sum of the previous two: ${shown[3]} + ${shown[4]} = ${correct}.`,
  },
  {
    id: "triangular",
    difficulty: 3,
    shown: 5,
    params: [
      { lo: 1, hi: 10 }, // n0
      { lo: -5, hi: 5 }, // c
    ],
    sample: (rand) => [intIn(rand, 1, 10), intIn(rand, -5, 5)],
    terms: ([n0, c]) => ({
      shown: [0, 1, 2, 3, 4].map((i) => tri(n0 + i) + c),
      correct: tri(n0 + 5) + c,
    }),
    distractors: (shown, correct) => {
      const prev = shown[shown.length - 1];
      const dLast = prev - shown[shown.length - 2];
      const dPrev = shown[shown.length - 2] - shown[shown.length - 3];
      const u = Math.max(1, dLast - dPrev);
      return [prev + dLast, prev + dLast + u, correct + u, correct - u];
    },
    explain: ([n0, c], _shown, correct) => {
      const n = n0 + 5;
      return c === 0
        ? `Triangular numbers (1, 3, 6, 10, …): T(${n}) = ${correct}.`
        : `Triangular numbers (1, 3, 6, 10, …)${offsetText(c)}: T(${n}) = ${tri(n)}, ` +
            `${c > 0 ? "+" : "-"} ${Math.abs(c)} = ${correct}.`;
    },
  },
  {
    id: "double_add",
    difficulty: 3,
    shown: 5,
    params: [
      { lo: 2, hi: 15 }, // a
      { lo: 1, hi: 8 }, // k
    ],
    sample: (rand) => [intIn(rand, 2, 15), intIn(rand, 1, 8)],
    terms: ([a, k]) => {
      const shown = [a];
      for (let i = 0; i < 4; i++) shown.push(2 * shown[i] + k);
      return { shown, correct: 2 * shown[4] + k };
    },
    distractors: (shown, correct, [, k]) => {
      const prev = shown[shown.length - 1];
      return [2 * prev, 2 * prev + 2 * k, 3 * prev + k];
    },
    explain: ([, k], shown, correct) =>
      `Each term is double the previous plus ${k}: ` +
      `2 × ${shown[shown.length - 1]} + ${k} = ${correct}.`,
  },
];
