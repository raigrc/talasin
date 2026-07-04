import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * DB-integration-level tests for lib/streak.ts's getStreaks() and
 * recordActivityAndGetStreak() — the read-modify-write upsert path that
 * guards against double-counting same-day activity (DESIGN.md §6, §2.6).
 * Supabase is mocked; lib/day's todayLocal is mocked to a fixed day so these
 * are deterministic regardless of when the suite runs.
 */

const mock = createSupabaseMock();

vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));

const FIXED_TODAY = "2026-07-01";
vi.mock("@/lib/day", async () => {
  const actual = await vi.importActual<typeof import("@/lib/day")>("@/lib/day");
  return {
    ...actual,
    todayLocal: () => FIXED_TODAY,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  Object.assign(mock, createSupabaseMock());
});

describe("getStreaks", () => {
  it("computes streak=0/best=0 for a brand-new user (no daily_activity rows)", async () => {
    const { getStreaks } = await import("@/lib/streak");
    mock.queueResponse("daily_activity", { data: [], error: null });
    const result = await getStreaks();
    expect(result).toEqual({ streak: 0, bestStreak: 0 });
  });

  it("computes streak=1 for a single day of activity today", async () => {
    const { getStreaks } = await import("@/lib/streak");
    mock.queueResponse("daily_activity", { data: [{ local_day: FIXED_TODAY }], error: null });
    const result = await getStreaks();
    expect(result).toEqual({ streak: 1, bestStreak: 1 });
  });

  it("propagates a read error", async () => {
    const { getStreaks } = await import("@/lib/streak");
    mock.queueResponse("daily_activity", { data: null, error: { message: "conn refused" } });
    await expect(getStreaks()).rejects.toThrow(/daily_activity read failed/);
  });
});

describe("recordActivityAndGetStreak — same-day double activity does not double count", () => {
  it("first activity of the day: upserts game_count=1, interview_count=0", async () => {
    const { recordActivityAndGetStreak } = await import("@/lib/streak");
    mock.queueResponse("daily_activity", { data: null, error: null }); // no existing row (maybeSingle)
    mock.queueResponse("daily_activity", { data: null, error: null }); // upsert response
    mock.queueResponse("daily_activity", { data: [{ local_day: FIXED_TODAY }], error: null }); // getStreaks read

    const streak = await recordActivityAndGetStreak("game", FIXED_TODAY);
    expect(streak).toBe(1);

    const upsertCall = mock.calls.find((c) => c.method === "upsert");
    expect(upsertCall!.args[0]).toMatchObject({
      local_day: FIXED_TODAY,
      game_count: 1,
      interview_count: 0,
    });
  });

  it("second activity SAME DAY increments the pillar counter but streak day-count stays the same", async () => {
    const { recordActivityAndGetStreak } = await import("@/lib/streak");
    // Existing row already has game_count: 1 from an earlier answer today.
    mock.queueResponse("daily_activity", {
      data: { local_day: FIXED_TODAY, game_count: 1, interview_count: 0 },
      error: null,
    });
    mock.queueResponse("daily_activity", { data: null, error: null }); // upsert
    mock.queueResponse("daily_activity", { data: [{ local_day: FIXED_TODAY }], error: null }); // getStreaks

    const streak = await recordActivityAndGetStreak("game", FIXED_TODAY);
    expect(streak).toBe(1); // still just 1 active day, not 2

    const upsertCall = mock.calls.find((c) => c.method === "upsert");
    expect(upsertCall!.args[0]).toMatchObject({ game_count: 2, interview_count: 0 });
  });

  it("activity from the OTHER pillar the same day increments that pillar's counter independently", async () => {
    const { recordActivityAndGetStreak } = await import("@/lib/streak");
    mock.queueResponse("daily_activity", {
      data: { local_day: FIXED_TODAY, game_count: 3, interview_count: 0 },
      error: null,
    });
    mock.queueResponse("daily_activity", { data: null, error: null });
    mock.queueResponse("daily_activity", { data: [{ local_day: FIXED_TODAY }], error: null });

    await recordActivityAndGetStreak("interview", FIXED_TODAY);

    const upsertCall = mock.calls.find((c) => c.method === "upsert");
    // Game count is preserved as-is; interview_count increments from 0 to 1.
    expect(upsertCall!.args[0]).toMatchObject({ game_count: 3, interview_count: 1 });
  });

  it("activity of EITHER pillar counts toward the streak (interview-only day still yields streak 1)", async () => {
    const { recordActivityAndGetStreak } = await import("@/lib/streak");
    mock.queueResponse("daily_activity", { data: null, error: null });
    mock.queueResponse("daily_activity", { data: null, error: null });
    mock.queueResponse("daily_activity", { data: [{ local_day: FIXED_TODAY }], error: null });

    const streak = await recordActivityAndGetStreak("interview", FIXED_TODAY);
    expect(streak).toBe(1);
  });

  it("propagates a read error during the read-modify-write", async () => {
    const { recordActivityAndGetStreak } = await import("@/lib/streak");
    mock.queueResponse("daily_activity", { data: null, error: { message: "read timeout" } });
    await expect(recordActivityAndGetStreak("game", FIXED_TODAY)).rejects.toThrow(
      /daily_activity read failed/,
    );
  });

  it("propagates an upsert error", async () => {
    const { recordActivityAndGetStreak } = await import("@/lib/streak");
    mock.queueResponse("daily_activity", { data: null, error: null });
    mock.queueResponse("daily_activity", { data: null, error: { message: "constraint violation" } });
    await expect(recordActivityAndGetStreak("game", FIXED_TODAY)).rejects.toThrow(
      /daily_activity upsert failed/,
    );
  });
});
