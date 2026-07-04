import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSupabaseMock } from "../helpers/supabaseMock";

/**
 * Interview data-layer tests (lib/interview.ts, DESIGN_V1.md §4.5, §2.3):
 * v1 insert payload (STAR columns + xp), paged history with category filter,
 * personal bests (min/max + duration floor + NULL-is-not-assessed), and the
 * previous-comparable-attempt fallback chain (same prompt → same category →
 * null) that feeds the delta strip.
 */

const mock = createSupabaseMock();

vi.mock("@/lib/supabase/server", () => ({
  getServiceClient: () => mock.client,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  Object.assign(mock, createSupabaseMock());
});

function feedbackFixture(overrides: Record<string, unknown> = {}) {
  return {
    transcript: "hello world",
    word_count: 2,
    filler_count: 1,
    filler_items: [{ word: "um", occurrences: 1 }],
    filler_per_min: 2,
    words_per_minute: 120,
    clarity_score: 80,
    structure: { has_beginning: true, has_middle: true, has_end: false, note: "n" },
    structure_note: "n",
    star: null,
    structure_score: null,
    coaching: ["tip1", "tip2"],
    overall_delivery_score: 75,
    confidence: "high" as const,
    model: "gemini-test",
    ...overrides,
  };
}

describe("insertInterviewAttempt — v1 columns", () => {
  it("writes the STAR flags + structure_score + flat xp on a behavioral attempt", async () => {
    const { insertInterviewAttempt } = await import("@/lib/interview");
    const { INTERVIEW_XP } = await import("@/lib/xp");
    mock.queueResponse("interview_attempts", { data: { id: "a1" }, error: null });

    const id = await insertInterviewAttempt(
      feedbackFixture({
        star: { situation: true, task: false, action: true, result: false },
        structure_score: 62,
      }) as never,
      "prompt-1",
      45.27,
    );
    expect(id).toBe("a1");

    const insert = mock.calls.find(
      (c) => c.table === "interview_attempts" && c.method === "insert",
    );
    expect(insert!.args[0]).toMatchObject({
      prompt_id: "prompt-1",
      star_situation: true,
      star_task: false,
      star_action: true,
      star_result: false,
      structure_score: 62,
      xp: INTERVIEW_XP,
      duration_sec: 45.3,
    });
  });

  it("writes NULL STAR columns for non-behavioral attempts (never false-zeroes)", async () => {
    const { insertInterviewAttempt } = await import("@/lib/interview");
    mock.queueResponse("interview_attempts", { data: { id: "a2" }, error: null });

    await insertInterviewAttempt(feedbackFixture() as never, null, 30);
    const insert = mock.calls.find(
      (c) => c.table === "interview_attempts" && c.method === "insert",
    );
    expect(insert!.args[0]).toMatchObject({
      star_situation: null,
      star_task: null,
      star_action: null,
      star_result: null,
      structure_score: null,
    });
  });
});

describe("listAttempts", () => {
  const promptRows = [
    { id: "p1", prompt_text: "Behavioral Q", category: "behavioral" },
    { id: "p2", prompt_text: "Pitch Q", category: "pitch" },
  ];

  function attemptRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "a1",
      created_at: "2026-07-02T10:00:00Z",
      local_day: "2026-07-02",
      prompt_id: "p1",
      transcript: "t",
      filler_count: 4,
      duration_sec: 120,
      words_per_minute: 140,
      clarity_score: 80,
      overall_delivery_score: 75,
      structure_score: 70,
      star_situation: true,
      star_task: true,
      star_action: true,
      star_result: false,
      ...overrides,
    };
  }

  it("joins prompt text/category in TS and shapes STAR flags", async () => {
    const { listAttempts } = await import("@/lib/interview");
    mock.queueResponse("interview_prompts", { data: promptRows, error: null });
    mock.queueResponse("interview_attempts", {
      data: [attemptRow()],
      error: null,
      count: 1,
    });

    const { items, total } = await listAttempts({ page: 1 });
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      id: "a1",
      prompt_id: "p1",
      prompt_text: "Behavioral Q",
      category: "behavioral",
      star: { situation: true, task: true, action: true, result: false },
    });
  });

  it("all-NULL STAR columns (pre-v1 / non-behavioral) shape as star: null, not all-false", async () => {
    const { listAttempts } = await import("@/lib/interview");
    mock.queueResponse("interview_prompts", { data: promptRows, error: null });
    mock.queueResponse("interview_attempts", {
      data: [
        attemptRow({
          prompt_id: null,
          star_situation: null,
          star_task: null,
          star_action: null,
          star_result: null,
          structure_score: null,
        }),
      ],
      error: null,
      count: 1,
    });

    const { items } = await listAttempts({ page: 1 });
    expect(items[0].star).toBeNull();
    expect(items[0].prompt_text).toBeNull(); // ad-hoc attempt
  });

  it("paginates DB-side via range() (page 2 of size 10 → rows 10..19)", async () => {
    const { listAttempts } = await import("@/lib/interview");
    mock.queueResponse("interview_prompts", { data: promptRows, error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null, count: 25 });

    const { total } = await listAttempts({ page: 2 });
    expect(total).toBe(25);
    const range = mock.calls.find(
      (c) => c.table === "interview_attempts" && c.method === "range",
    );
    expect(range!.args).toEqual([10, 19]);
  });

  it("category filter narrows to that category's prompt ids via in()", async () => {
    const { listAttempts } = await import("@/lib/interview");
    mock.queueResponse("interview_prompts", { data: promptRows, error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null, count: 0 });

    await listAttempts({ page: 1, category: "pitch" });
    const inCall = mock.calls.find(
      (c) => c.table === "interview_attempts" && c.method === "in",
    );
    expect(inCall!.args).toEqual(["prompt_id", ["p2"]]);
  });

  it("a category with no prompts short-circuits to empty without an attempts query", async () => {
    const { listAttempts } = await import("@/lib/interview");
    mock.queueResponse("interview_prompts", { data: promptRows, error: null });

    const result = await listAttempts({ page: 1, category: "negotiation" });
    expect(result).toEqual({ items: [], total: 0 });
    expect(
      mock.calls.some((c) => c.table === "interview_attempts" && c.method === "select"),
    ).toBe(false);
  });
});

describe("getPersonalBests", () => {
  it("computes max delivery/clarity/structure and MIN filler/min with the 30s duration floor", async () => {
    const { getPersonalBests } = await import("@/lib/interview");
    mock.queueResponse("interview_attempts", {
      data: [
        // 20s clip with 0 fillers — would be the filler best, but under the floor.
        { id: "a1", local_day: "2026-07-01", overall_delivery_score: 70, clarity_score: 90, filler_count: 0, duration_sec: 20, structure_score: null },
        // 60s clip, 2 fillers → 2.0/min. Best delivery.
        { id: "a2", local_day: "2026-07-02", overall_delivery_score: 88, clarity_score: 85, filler_count: 2, duration_sec: 60, structure_score: 70 },
        // 120s clip, 3 fillers → 1.5/min → filler best. Best structure.
        { id: "a3", local_day: "2026-07-03", overall_delivery_score: 80, clarity_score: 80, filler_count: 3, duration_sec: 120, structure_score: 91 },
      ],
      error: null,
    });

    const bests = await getPersonalBests();
    expect(bests.best_delivery).toEqual({ value: 88, attempt_id: "a2", local_day: "2026-07-02" });
    expect(bests.best_clarity).toEqual({ value: 90, attempt_id: "a1", local_day: "2026-07-01" });
    expect(bests.best_filler_per_min).toEqual({ value: 1.5, attempt_id: "a3", local_day: "2026-07-03" });
    expect(bests.best_structure_score).toEqual({ value: 91, attempt_id: "a3", local_day: "2026-07-03" });
  });

  it("returns all-null bests when there are no attempts (NULL = not assessed)", async () => {
    const { getPersonalBests } = await import("@/lib/interview");
    mock.queueResponse("interview_attempts", { data: [], error: null });

    const bests = await getPersonalBests();
    expect(bests).toEqual({
      best_delivery: null,
      best_clarity: null,
      best_filler_per_min: null,
      best_structure_score: null,
    });
  });
});

describe("getPreviousComparableAttempt", () => {
  const prevRow = {
    id: "prev1",
    created_at: "2026-07-01T10:00:00Z",
    overall_delivery_score: 71,
    clarity_score: 74,
    filler_count: 8,
    duration_sec: 150,
    words_per_minute: 141,
  };

  it("prefers the most recent attempt on the SAME prompt", async () => {
    const { getPreviousComparableAttempt } = await import("@/lib/interview");
    mock.queueResponse("interview_attempts", { data: [prevRow], error: null });

    const prev = await getPreviousComparableAttempt("p1", "behavioral");
    expect(prev).toEqual({
      attempt_id: "prev1",
      created_at: "2026-07-01T10:00:00Z",
      overall_delivery_score: 71,
      clarity_score: 74,
      filler_per_min: 3.2, // 8 fillers / 2.5 min
      words_per_minute: 141,
    });
    // Same-prompt hit → no category fallback queries.
    expect(mock.calls.some((c) => c.table === "interview_prompts")).toBe(false);
  });

  it("falls back to the most recent attempt in the same CATEGORY", async () => {
    const { getPreviousComparableAttempt } = await import("@/lib/interview");
    mock.queueResponse("interview_attempts", { data: [], error: null }); // same prompt: none
    mock.queueResponse("interview_prompts", { data: [{ id: "p1" }, { id: "p9" }], error: null });
    mock.queueResponse("interview_attempts", { data: [prevRow], error: null });

    const prev = await getPreviousComparableAttempt("p1", "behavioral");
    expect(prev?.attempt_id).toBe("prev1");

    const inCall = mock.calls.find(
      (c) => c.table === "interview_attempts" && c.method === "in",
    );
    expect(inCall!.args).toEqual(["prompt_id", ["p1", "p9"]]);
  });

  it("returns null on the first-ever comparable attempt", async () => {
    const { getPreviousComparableAttempt } = await import("@/lib/interview");
    mock.queueResponse("interview_attempts", { data: [], error: null });
    mock.queueResponse("interview_prompts", { data: [{ id: "p1" }], error: null });
    mock.queueResponse("interview_attempts", { data: [], error: null });

    await expect(getPreviousComparableAttempt("p1", "behavioral")).resolves.toBeNull();
  });

  it("returns null for an ad-hoc attempt (no prompt, no category)", async () => {
    const { getPreviousComparableAttempt } = await import("@/lib/interview");
    await expect(getPreviousComparableAttempt(null, null)).resolves.toBeNull();
    expect(mock.calls.length).toBe(0);
  });

  it("zero-duration previous rows yield filler_per_min: null (no div-by-zero)", async () => {
    const { getPreviousComparableAttempt } = await import("@/lib/interview");
    mock.queueResponse("interview_attempts", {
      data: [{ ...prevRow, duration_sec: 0 }],
      error: null,
    });
    const prev = await getPreviousComparableAttempt("p1", null);
    expect(prev?.filler_per_min).toBeNull();
  });
});
