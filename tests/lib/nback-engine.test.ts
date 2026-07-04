import { describe, it, expect } from "vitest";
import {
  LETTERS,
  GRID_CELLS,
  SCOREABLE_TRIALS,
  PLANTED_MATCHES,
  DUAL_MATCHES,
  N_MIN,
  N_MAX,
  mulberry32,
  seedFromUid,
  generateSequence,
  groundTruth,
  scoreSession,
  nextLevel,
} from "@/lib/games/nback/engine";

/**
 * Dual n-back engine tests (lib/games/nback/engine.ts, DESIGN_V1.md §3.4).
 * The engine must be deterministic — the server re-derives the exact trial
 * list from the token's seed at answer time — and the score must come from
 * raw per-trial booleans, never a client-computed number.
 */

const SEEDS = [1, 42, 123456789, seedFromUid("some-uid")];

describe("determinism", () => {
  it("same (seed, n) always yields the identical sequence", () => {
    for (const seed of SEEDS) {
      for (let n = N_MIN; n <= N_MAX; n++) {
        expect(generateSequence(seed, n)).toEqual(generateSequence(seed, n));
      }
    }
  });

  it("different seeds yield different sequences", () => {
    const a = generateSequence(1, 2);
    const b = generateSequence(2, 2);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("seedFromUid is a deterministic uint32 of the uid", () => {
    const s1 = seedFromUid("round-uid-1");
    expect(seedFromUid("round-uid-1")).toBe(s1);
    expect(Number.isInteger(s1)).toBe(true);
    expect(s1).toBeGreaterThanOrEqual(0);
    expect(s1).toBeLessThanOrEqual(0xffffffff);
    expect(seedFromUid("round-uid-2")).not.toBe(s1);
  });

  it("mulberry32 emits reproducible values in [0, 1)", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("sequence structure", () => {
  it("has n lead-in + 20 scoreable trials with in-range stimuli", () => {
    for (const seed of SEEDS) {
      for (let n = N_MIN; n <= N_MAX; n++) {
        const trials = generateSequence(seed, n);
        expect(trials).toHaveLength(n + SCOREABLE_TRIALS);
        for (const t of trials) {
          expect(t.pos).toBeGreaterThanOrEqual(0);
          expect(t.pos).toBeLessThan(GRID_CELLS);
          expect(LETTERS).toContain(t.letter);
        }
      }
    }
  });

  it("plants exactly 6 position matches, 6 letter matches, 2 dual (no accidental matches)", () => {
    for (const seed of SEEDS) {
      for (let n = N_MIN; n <= N_MAX; n++) {
        const trials = generateSequence(seed, n);
        const { posMatch, letterMatch } = groundTruth(trials, n);
        expect(posMatch).toHaveLength(SCOREABLE_TRIALS);
        expect(letterMatch).toHaveLength(SCOREABLE_TRIALS);
        const posCount = posMatch.filter(Boolean).length;
        const letterCount = letterMatch.filter(Boolean).length;
        const dualCount = posMatch.filter((p, i) => p && letterMatch[i]).length;
        expect(posCount).toBe(PLANTED_MATCHES);
        expect(letterCount).toBe(PLANTED_MATCHES);
        expect(dualCount).toBe(DUAL_MATCHES);
      }
    }
  });
});

describe("scoreSession — normalized 0-100 from raw per-trial booleans", () => {
  const trials = generateSequence(seedFromUid("score-test"), 2);
  const truth = groundTruth(trials, 2);
  const allFalse = () => Array.from({ length: SCOREABLE_TRIALS }, () => false);
  const allTrue = () => Array.from({ length: SCOREABLE_TRIALS }, () => true);

  it("perfect play scores 100 with clean breakdowns", () => {
    const result = scoreSession(truth, {
      position: [...truth.posMatch],
      letter: [...truth.letterMatch],
    });
    expect(result.score).toBe(100);
    expect(result.position).toEqual({ hits: 6, misses: 0, false_alarms: 0 });
    expect(result.letter).toEqual({ hits: 6, misses: 0, false_alarms: 0 });
  });

  it("no responses at all scores 0 (all planted matches missed)", () => {
    const result = scoreSession(truth, { position: allFalse(), letter: allFalse() });
    expect(result.score).toBe(0);
    expect(result.position).toEqual({ hits: 0, misses: 6, false_alarms: 0 });
    expect(result.letter).toEqual({ hits: 0, misses: 6, false_alarms: 0 });
  });

  it("'press every trial' scores 0 — false alarms cancel hits (cheat resistance)", () => {
    const result = scoreSession(truth, { position: allTrue(), letter: allTrue() });
    expect(result.score).toBe(0);
    expect(result.position).toEqual({ hits: 6, misses: 0, false_alarms: 14 });
    expect(result.letter).toEqual({ hits: 6, misses: 0, false_alarms: 14 });
  });

  it("partial credit follows acc = clamp((hits − false_alarms) / 6, 0, 1)", () => {
    // Position: hit only the first 3 planted matches → acc 3/6 = 0.5.
    const position = truth.posMatch.map((isMatch, i, arr) => {
      if (!isMatch) return false;
      const nthMatch = arr.slice(0, i + 1).filter(Boolean).length;
      return nthMatch <= 3;
    });
    // Letter: perfect → acc 1. Score = round(100 × (0.5 + 1) / 2) = 75.
    const result = scoreSession(truth, { position, letter: [...truth.letterMatch] });
    expect(result.score).toBe(75);
    expect(result.position).toEqual({ hits: 3, misses: 3, false_alarms: 0 });
  });
});

describe("nextLevel — N progression", () => {
  it("levels up at score ≥ 80, capped at N_MAX", () => {
    expect(nextLevel(2, 80)).toBe(3);
    expect(nextLevel(4, 95)).toBe(5);
    expect(nextLevel(5, 100)).toBe(5); // cap
  });

  it("levels down below 50, floored at N_MIN", () => {
    expect(nextLevel(3, 49)).toBe(2);
    expect(nextLevel(2, 0)).toBe(2); // floor
  });

  it("holds steady in the 50..79 band", () => {
    expect(nextLevel(3, 50)).toBe(3);
    expect(nextLevel(3, 79)).toBe(3);
  });

  it("sanitizes an out-of-range lastN before applying the rule", () => {
    expect(nextLevel(99, 60)).toBe(5);
    expect(nextLevel(0, 60)).toBe(2);
  });
});
