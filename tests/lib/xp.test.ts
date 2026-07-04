import { describe, it, expect } from "vitest";
import {
  INTERVIEW_XP,
  fallacyXp,
  syllogismXp,
  nbackXp,
  levelThreshold,
  levelFromXp,
} from "@/lib/xp";

/**
 * XP amounts + level curve (lib/xp.ts, DESIGN_V1.md §5.1). Pure math — these
 * constants are the single source of truth for every attempt row's xp column.
 */

describe("per-activity XP amounts", () => {
  // NOTE: DESIGN_V1.md §5.1 annotates the range as "10–30" but its own formula
  // (also used by the schema.sql backfill) maxes at 10 + 5 + 5×(3−1) = 25.
  // The FORMULA is normative — DB backfill and app must agree.
  it("fallacy: 10 base + 5 correct + 5 per difficulty step → 10..25", () => {
    expect(fallacyXp(false, 1)).toBe(10);
    expect(fallacyXp(true, 1)).toBe(15);
    expect(fallacyXp(false, 2)).toBe(15);
    expect(fallacyXp(true, 2)).toBe(20);
    expect(fallacyXp(true, 3)).toBe(25);
  });

  it("fallacy: clamps out-of-range/garbage difficulty into 1..3", () => {
    expect(fallacyXp(true, 0)).toBe(15); // clamped up to 1
    expect(fallacyXp(true, 99)).toBe(25); // clamped down to 3
    expect(fallacyXp(true, Number.NaN)).toBe(15); // non-finite → 1
  });

  it("syllogism: 5 base + 5 correct", () => {
    expect(syllogismXp(false)).toBe(5);
    expect(syllogismXp(true)).toBe(10);
  });

  it("n-back: 25 base + 10 per N above 2 + tiered score bonus → 25..70", () => {
    expect(nbackXp(2, 0)).toBe(25);
    expect(nbackXp(2, 39)).toBe(25);
    expect(nbackXp(2, 40)).toBe(30); // +5
    expect(nbackXp(2, 60)).toBe(35); // +10
    expect(nbackXp(2, 80)).toBe(40); // +15
    expect(nbackXp(3, 100)).toBe(50); // +10 for N=3, +15 bonus
    expect(nbackXp(5, 100)).toBe(70); // design max
  });

  it("interview XP constant is the flat 50 per attempt", () => {
    expect(INTERVIEW_XP).toBe(50);
  });
});

describe("levelFromXp — quadratic curve (threshold(L) = 100 × (L−1)²)", () => {
  it("thresholds match the design table (L2=100, L3=400, L5=1600, L10=8100)", () => {
    expect(levelThreshold(2)).toBe(100);
    expect(levelThreshold(3)).toBe(400);
    expect(levelThreshold(5)).toBe(1600);
    expect(levelThreshold(10)).toBe(8100);
  });

  it("maps total XP to the right level at the boundaries", () => {
    expect(levelFromXp(0).level).toBe(1);
    expect(levelFromXp(99).level).toBe(1);
    expect(levelFromXp(100).level).toBe(2);
    expect(levelFromXp(399).level).toBe(2);
    expect(levelFromXp(400).level).toBe(3);
    expect(levelFromXp(1600).level).toBe(5);
  });

  it("reports into_level / for_next for the progress bar", () => {
    // 250 XP: level 2 (threshold 100), 150 into it, span 100→400 = 300.
    expect(levelFromXp(250)).toEqual({ level: 2, into_level: 150, for_next: 300 });
    // Exactly at a threshold: 400 → level 3, 0 into it, span 400→900 = 500.
    expect(levelFromXp(400)).toEqual({ level: 3, into_level: 0, for_next: 500 });
  });

  it("guards against negative/fractional totals", () => {
    expect(levelFromXp(-50)).toEqual({ level: 1, into_level: 0, for_next: 100 });
    expect(levelFromXp(100.9).level).toBe(2); // floored, not rounded up
  });
});
