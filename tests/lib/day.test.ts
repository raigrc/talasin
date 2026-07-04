import { describe, it, expect } from "vitest";
import { formatLocalDay, addDays, todayLocal } from "@/lib/day";

/**
 * Local-day math (DESIGN.md §6). Asia/Manila is UTC+8 with no DST, so the
 * midnight boundary is a fixed 8-hour shift from UTC — easy to test precisely.
 */

describe("formatLocalDay", () => {
  it("formats a UTC instant into Asia/Manila calendar day (UTC+8)", () => {
    // 2026-06-30T16:01:00Z = 2026-07-01T00:01:00+08:00 -> next day in Manila
    const instant = new Date("2026-06-30T16:01:00.000Z");
    expect(formatLocalDay(instant, "Asia/Manila")).toBe("2026-07-01");
  });

  it("one minute before Manila midnight is still the previous day", () => {
    // 2026-06-30T15:59:00Z = 2026-06-30T23:59:00+08:00 -> still June 30 in Manila
    const instant = new Date("2026-06-30T15:59:00.000Z");
    expect(formatLocalDay(instant, "Asia/Manila")).toBe("2026-06-30");
  });

  it("exact midnight boundary in Manila", () => {
    // 2026-06-30T16:00:00Z = 2026-07-01T00:00:00+08:00 exactly
    const instant = new Date("2026-06-30T16:00:00.000Z");
    expect(formatLocalDay(instant, "Asia/Manila")).toBe("2026-07-01");
  });

  it("UTC day differs from Manila day around the UTC afternoon (demonstrates why fixed-tz matters)", () => {
    // At 2026-06-30T20:00:00Z, UTC calendar day is still June 30, but Manila
    // (UTC+8) has already rolled to July 1 at 04:00 local.
    const instant = new Date("2026-06-30T20:00:00.000Z");
    expect(formatLocalDay(instant, "UTC")).toBe("2026-06-30");
    expect(formatLocalDay(instant, "Asia/Manila")).toBe("2026-07-01");
  });

  it("defaults to APP_TZ (Asia/Manila) when no timeZone is passed", () => {
    const instant = new Date("2026-06-30T16:00:00.000Z");
    expect(formatLocalDay(instant)).toBe(formatLocalDay(instant, "Asia/Manila"));
  });

  it("todayLocal() with an explicit now uses the same formatting as formatLocalDay", () => {
    const now = new Date("2026-06-30T16:00:00.000Z");
    expect(todayLocal(now)).toBe(formatLocalDay(now, "Asia/Manila"));
  });
});

describe("addDays", () => {
  it("subtracts one day across a normal boundary", () => {
    expect(addDays("2026-07-01", -1)).toBe("2026-06-30");
  });

  it("adds one day across a normal boundary", () => {
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
  });

  it("handles month-end rollover (Jan 31 -> Feb 1)", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("handles year rollover (Dec 31 -> Jan 1)", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("handles leap-year Feb 29 correctly (2028 is a leap year)", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("handles non-leap-year Feb correctly (2026 is not a leap year)", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("delta of 0 returns the same day", () => {
    expect(addDays("2026-07-01", 0)).toBe("2026-07-01");
  });

  it("is stable under the host machine's local timezone (parses as UTC midnight)", () => {
    // Regression guard: addDays must not silently shift by a day depending on
    // where the test runner's OS timezone is set. This assertion is
    // deterministic regardless of TZ env because addDays always uses Date.UTC.
    const result = addDays("2026-03-01", -1);
    expect(result).toBe("2026-02-28");
  });

  it("round-trips: addDays(addDays(d, -1), 1) === d", () => {
    const d = "2026-07-01";
    expect(addDays(addDays(d, -1), 1)).toBe(d);
  });
});
