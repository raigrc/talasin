import { describe, it, expect } from "vitest";
import { computeCurrentStreak, computeBestStreak } from "@/lib/streak";

/**
 * Pure-logic tests for streak computation (DESIGN.md §6).
 *
 * `computeCurrentStreak` / `computeBestStreak` take a Set of `local_day`
 * (YYYY-MM-DD) strings and a "today" reference — no DB/network involved, so
 * these are fully deterministic.
 */

const TODAY = "2026-07-01";
const YDAY = "2026-06-30";
const D2 = "2026-06-29";
const D3 = "2026-06-28";
const D4 = "2026-06-27";

describe("computeCurrentStreak", () => {
  it("first-ever session: single activity today => streak 1", () => {
    const days = new Set([TODAY]);
    expect(computeCurrentStreak(days, TODAY)).toBe(1);
  });

  it("no activity ever => streak 0", () => {
    const days = new Set<string>();
    expect(computeCurrentStreak(days, TODAY)).toBe(0);
  });

  it("consecutive days ending today count fully", () => {
    const days = new Set([TODAY, YDAY, D2, D3]);
    expect(computeCurrentStreak(days, TODAY)).toBe(4);
  });

  it("nothing today yet, but yesterday active => streak still alive (counted through yesterday)", () => {
    const days = new Set([YDAY, D2, D3]);
    expect(computeCurrentStreak(days, TODAY)).toBe(3);
  });

  it("missed day (gap) breaks the streak at the gap", () => {
    // Active: today, yesterday, then a gap at D2, then D3 D4 active.
    // Walking back from today: today(1) -> yesterday(2) -> D2 missing -> stop at 2.
    const days = new Set([TODAY, YDAY, D3, D4]);
    expect(computeCurrentStreak(days, TODAY)).toBe(2);
  });

  it("nothing today and nothing yesterday => streak resets to 0 even if older days are active", () => {
    const days = new Set([D2, D3, D4]);
    expect(computeCurrentStreak(days, TODAY)).toBe(0);
  });

  it("same-day double activity does not double count (Set dedupes by day)", () => {
    // Represented as a Set of days — the streak function has no concept of
    // "activity count" per day, so two attempts on the same day still yield
    // exactly one entry in the set, i.e. exactly one streak day.
    const days = new Set([TODAY, TODAY, YDAY]); // duplicate literal is a no-op on a Set
    expect(days.size).toBe(2);
    expect(computeCurrentStreak(days, TODAY)).toBe(2);
  });

  it("long gap then return: streak resets to 1 on the return day", () => {
    const farPast = "2026-05-01";
    const days = new Set([TODAY, farPast]);
    expect(computeCurrentStreak(days, TODAY)).toBe(1);
  });

  it("activity of either pillar counts as one day (game_count/interview_count irrelevant to this pure fn)", () => {
    // computeCurrentStreak only cares about presence in the day-set; the
    // pillar mix is handled upstream in recordActivityAndGetStreak's upsert.
    const days = new Set([TODAY]);
    expect(computeCurrentStreak(days, TODAY)).toBe(1);
  });

  it("year boundary: streak spans across Dec 31 -> Jan 1 correctly", () => {
    const jan1 = "2027-01-01";
    const dec31 = "2026-12-31";
    const dec30 = "2026-12-30";
    const days = new Set([jan1, dec31, dec30]);
    expect(computeCurrentStreak(days, jan1)).toBe(3);
  });

  it("leap-day boundary: Feb 29 2028 counted correctly in a run", () => {
    const mar1 = "2028-03-01";
    const feb29 = "2028-02-29";
    const feb28 = "2028-02-28";
    const days = new Set([mar1, feb29, feb28]);
    expect(computeCurrentStreak(days, mar1)).toBe(3);
  });
});

describe("computeBestStreak", () => {
  it("empty set => 0", () => {
    expect(computeBestStreak(new Set())).toBe(0);
  });

  it("single day => 1", () => {
    expect(computeBestStreak(new Set([TODAY]))).toBe(1);
  });

  it("finds the longest run even if it is not the most recent run", () => {
    // Two separate runs: an old 5-day run and a recent 2-day run. Best should
    // be 5, not the current (recent) run.
    const oldRun = ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"];
    const recentRun = [YDAY, TODAY];
    const days = new Set([...oldRun, ...recentRun]);
    expect(computeBestStreak(days)).toBe(5);
  });

  it("multiple disjoint single-day runs => best is 1", () => {
    const days = new Set(["2026-01-01", "2026-01-05", "2026-01-10"]);
    expect(computeBestStreak(days)).toBe(1);
  });

  it("one long unbroken run equals the full set size", () => {
    const days = new Set([D4, D3, D2, YDAY, TODAY]);
    expect(computeBestStreak(days)).toBe(5);
  });

  it("is insensitive to Set insertion order", () => {
    const inOrder = new Set([D4, D3, D2, YDAY, TODAY]);
    const reversed = new Set([TODAY, YDAY, D2, D3, D4]);
    const shuffled = new Set([D2, TODAY, D4, YDAY, D3]);
    expect(computeBestStreak(inOrder)).toBe(computeBestStreak(reversed));
    expect(computeBestStreak(reversed)).toBe(computeBestStreak(shuffled));
  });
});
