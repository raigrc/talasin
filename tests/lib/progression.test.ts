import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * afterActivity() composition tests (lib/progression.ts, DESIGN_V1.md §5.4):
 * streak + XP totals + achievement evaluation compose in one place; a failing
 * achievements evaluation degrades to [] instead of failing an already
 * recorded attempt. Plus getDailyGoal() threshold behavior (§5.3).
 */

const mock = createSupabaseMock();

const { recordActivityMock, evaluateAchievementsMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn(),
  evaluateAchievementsMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));
vi.mock("@/lib/streak", () => ({
  recordActivityAndGetStreak: recordActivityMock,
}));
vi.mock("@/lib/achievements", () => ({
  evaluateAchievements: evaluateAchievementsMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  Object.assign(mock, createSupabaseMock());
  recordActivityMock.mockResolvedValue(4);
  evaluateAchievementsMock.mockResolvedValue([]);
});

describe("afterActivity", () => {
  it("composes streak + XP totals + level and passes streak/level to the achievement evaluation", async () => {
    const { afterActivity } = await import("@/lib/progression");
    mock.queueResponse("game_attempts", { data: [{ xp: 100 }, { xp: 250 }], error: null });
    mock.queueResponse("interview_attempts", { data: [{ xp: 50 }], error: null });
    evaluateAchievementsMock.mockResolvedValueOnce([{ key: "streak_7", name: "One week sharp" }]);

    const result = await afterActivity({
      pillar: "game",
      gameType: "fallacy",
      xpAwarded: 15,
      attemptFacts: { is_correct: true },
    });

    // 400 XP total → level 3 (threshold(3)=400).
    expect(result).toEqual({
      streak: 4,
      xpAwarded: 15,
      xpTotal: 400,
      level: 3,
      newAchievements: [{ key: "streak_7", name: "One week sharp" }],
    });
    expect(recordActivityMock).toHaveBeenCalledWith("game");
    expect(evaluateAchievementsMock).toHaveBeenCalledWith({
      pillar: "game",
      gameType: "fallacy",
      attemptFacts: { is_correct: true },
      streak: 4,
      level: 3,
    });
  });

  it("null xp rows count as zero", async () => {
    const { afterActivity } = await import("@/lib/progression");
    mock.queueResponse("game_attempts", { data: [{ xp: null }, { xp: 30 }], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });

    const result = await afterActivity({
      pillar: "interview",
      xpAwarded: 50,
      attemptFacts: {},
    });
    expect(result.xpTotal).toBe(30);
  });

  it("achievements evaluation failure degrades to [] — never a thrown 500 after the attempt is recorded", async () => {
    const { afterActivity } = await import("@/lib/progression");
    mock.queueResponse("game_attempts", { data: [], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });
    evaluateAchievementsMock.mockRejectedValueOnce(new Error("achievements table missing"));

    const result = await afterActivity({
      pillar: "interview",
      xpAwarded: 50,
      attemptFacts: {},
    });
    expect(result.newAchievements).toEqual([]);
    expect(result.streak).toBe(4);
  });

  it("propagates an XP read failure (attempt-recording invariant is the caller's concern)", async () => {
    const { afterActivity } = await import("@/lib/progression");
    mock.queueResponse("game_attempts", { data: null, error: { message: "boom" } });
    mock.queueResponse("interview_attempts", { data: [], error: null });

    await expect(
      afterActivity({ pillar: "game", gameType: "nback", xpAwarded: 25, attemptFacts: {} }),
    ).rejects.toThrow(/game xp read failed/);
  });
});

describe("getDailyGoal", () => {
  it("one activity per pillar satisfies the goal", async () => {
    const { getDailyGoal } = await import("@/lib/progression");
    mock.queueResponse("daily_activity", {
      data: { game_count: 1, interview_count: 0 },
      error: null,
    });
    await expect(getDailyGoal("2026-07-03")).resolves.toEqual({
      game_done: true,
      interview_done: false,
    });
  });

  it("a missing daily_activity row means nothing done yet", async () => {
    const { getDailyGoal } = await import("@/lib/progression");
    mock.queueResponse("daily_activity", { data: null, error: null });
    await expect(getDailyGoal("2026-07-03")).resolves.toEqual({
      game_done: false,
      interview_done: false,
    });
  });
});
