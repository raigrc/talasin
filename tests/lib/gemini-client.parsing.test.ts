import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Structured-output parsing / validation / retry-classification tests.
 *
 * Feeds lib/gemini/client.ts good AND malformed model JSON (via a mocked
 * @google/genai SDK) and asserts it never crashes — it either returns a valid
 * parsed result or throws a typed GeminiError with the correct `kind`, which
 * the route handlers map to HTTP status (config.ts / DESIGN §8).
 */

process.env.GEMINI_API_KEY = "test-key-not-real";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock("@google/genai", async () => {
  const actual = await vi.importActual<typeof import("@google/genai")>("@google/genai");
  return {
    ...actual,
    GoogleGenAI: class {
      models = { generateContent: (...args: unknown[]) => generateContentMock(...args) };
    },
  };
});

function mockResponse(json: unknown) {
  return { text: JSON.stringify(json), usageMetadata: { totalTokenCount: 100 } };
}
function mockRawTextResponse(text: string) {
  return { text, usageMetadata: { totalTokenCount: 100 } };
}

function validVoiceModelOutput(overrides: Record<string, unknown> = {}) {
  return {
    transcript: "A perfectly normal transcript with no issues here at all today",
    word_count: 12,
    filler_words: { count: 0, items: [] },
    clarity_score: 80,
    structure_assessment: {
      has_beginning: true,
      has_middle: true,
      has_end: true,
      note: "fine",
    },
    coaching: ["Tip one.", "Tip two."],
    overall_delivery_score: 75,
    ...overrides,
  };
}

function validFallacyRound(overrides: Record<string, unknown> = {}) {
  return {
    argument: "My coworker missed one deadline, so he's clearly incompetent at everything.",
    scenario_summary: "coworker judged incompetent after one missed deadline",
    options: ["hasty_generalization", "strawman", "ad_hominem", "false_cause"],
    correct_fallacy: "hasty_generalization",
    explanation:
      "This is a hasty generalization because it draws a sweeping conclusion about the coworker's overall competence from a single data point (one missed deadline), which is not representative. Strawman doesn't apply because no argument is being misrepresented. Ad hominem doesn't apply because the attack isn't dismissing an argument the coworker made. False cause doesn't apply because there's no causal claim between two events.",
    difficulty: "medium",
    ...overrides,
  };
}

beforeEach(() => {
  generateContentMock.mockReset();
  vi.resetModules();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("voice feedback — structured output parsing", () => {
  it("accepts a well-formed model response", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse(validVoiceModelOutput()));
    const result = await analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30);
    expect(result.transcript).toContain("perfectly normal");
    expect(result.clarity_score).toBe(80);
  });

  it("non-JSON text response triggers one retry, then throws invalid_output if still bad", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock
      .mockResolvedValueOnce(mockRawTextResponse("Sure! Here's your analysis: not json at all"))
      .mockResolvedValueOnce(mockRawTextResponse("still not json"));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
    expect(generateContentMock).toHaveBeenCalledTimes(2); // 1 initial + 1 low-temp retry
  });

  it("non-JSON text response recovers if the retry succeeds", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock
      .mockResolvedValueOnce(mockRawTextResponse("not json"))
      .mockResolvedValueOnce(mockResponse(validVoiceModelOutput()));

    const result = await analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30);
    expect(result.transcript).toContain("perfectly normal");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("valid JSON but missing required field (clarity_score) fails schema, retries, then throws", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const bad = validVoiceModelOutput();
    delete (bad as Record<string, unknown>).clarity_score;
    generateContentMock.mockResolvedValueOnce(mockResponse(bad)).mockResolvedValueOnce(mockResponse(bad));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
  });

  it("clarity_score out of range (>100) fails Zod validation", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const bad = validVoiceModelOutput({ clarity_score: 150 });
    generateContentMock.mockResolvedValueOnce(mockResponse(bad)).mockResolvedValueOnce(mockResponse(bad));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
  });

  it("clarity_score negative fails Zod validation", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const bad = validVoiceModelOutput({ clarity_score: -1 });
    generateContentMock.mockResolvedValueOnce(mockResponse(bad)).mockResolvedValueOnce(mockResponse(bad));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
  });

  it("coaching array with only 1 item fails the min(2) schema constraint", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const bad = validVoiceModelOutput({ coaching: ["only one tip"] });
    generateContentMock.mockResolvedValueOnce(mockResponse(bad)).mockResolvedValueOnce(mockResponse(bad));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
  });

  it("coaching array with 4 items fails the max(3) schema constraint", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const bad = validVoiceModelOutput({ coaching: ["a", "b", "c", "d"] });
    generateContentMock.mockResolvedValueOnce(mockResponse(bad)).mockResolvedValueOnce(mockResponse(bad));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
  });

  it("wrong type (clarity_score as string) fails schema without crashing", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const bad = validVoiceModelOutput({ clarity_score: "eighty" });
    generateContentMock.mockResolvedValueOnce(mockResponse(bad)).mockResolvedValueOnce(mockResponse(bad));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
  });

  it("completely empty object {} fails schema gracefully", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse({})).mockResolvedValueOnce(mockResponse({}));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
  });

  it("truncated/empty string response classifies as invalid_output, not an unhandled crash", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock
      .mockResolvedValueOnce(mockRawTextResponse(""))
      .mockResolvedValueOnce(mockRawTextResponse(""));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30),
    ).rejects.toMatchObject({ name: "GeminiError" });
  });
});

describe("voice feedback — STAR variant (behavioral category, DESIGN_V1 §4.3/§4.4)", () => {
  function validStarModelOutput(overrides: Record<string, unknown> = {}) {
    return validVoiceModelOutput({
      structure_assessment: {
        has_situation: true,
        has_task: true,
        has_action: true,
        has_result: false,
        structure_score: 68,
        note: "No concrete result.",
      },
      ...overrides,
    });
  }

  it("behavioral category parses the STAR schema and maps star + structure_score", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse(validStarModelOutput()));

    const result = await analyzeInterviewAudio(
      new ArrayBuffer(4),
      "audio/webm",
      "Tell me about a time...",
      30,
      "behavioral",
    );
    expect(result.star).toEqual({ situation: true, task: true, action: true, result: false });
    expect(result.structure_score).toBe(68);
    // Legacy structure flags derive from STAR (S→beginning, A→middle, R→end)
    // so structure/structure_note keep working exactly as before.
    expect(result.structure).toEqual({
      has_beginning: true,
      has_middle: true,
      has_end: false,
      note: "No concrete result.",
    });
    expect(result.structure_note).toBe("No concrete result.");
  });

  it("behavioral calls request the STAR schema + rubric (one call, no union guessing)", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse(validStarModelOutput()));

    await analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30, "behavioral");
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const call = generateContentMock.mock.calls[0][0] as {
      config: { systemInstruction: string; responseSchema: { properties: Record<string, unknown> } };
    };
    expect(call.config.systemInstruction).toContain("STAR RUBRIC OVERRIDE");
    const sa = call.config.responseSchema.properties.structure_assessment as {
      properties: Record<string, unknown>;
    };
    expect(Object.keys(sa.properties)).toContain("has_situation");
    expect(Object.keys(sa.properties)).toContain("structure_score");
  });

  it("non-behavioral categories keep the light heuristic: star/structure_score are null", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse(validVoiceModelOutput()));

    const result = await analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30, "pitch");
    expect(result.star).toBeNull();
    expect(result.structure_score).toBeNull();
    const call = generateContentMock.mock.calls[0][0] as {
      config: { systemInstruction: string };
    };
    expect(call.config.systemInstruction).not.toContain("STAR RUBRIC OVERRIDE");
  });

  it("omitting the category behaves like the pre-v1 light call (back-compat default)", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse(validVoiceModelOutput()));

    const result = await analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30);
    expect(result.star).toBeNull();
    expect(result.structure_score).toBeNull();
  });

  it("malformed STAR output (missing has_result) fails the exact-variant schema, retries, then throws", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const bad = validStarModelOutput();
    delete (bad.structure_assessment as Record<string, unknown>).has_result;
    generateContentMock.mockResolvedValueOnce(mockResponse(bad)).mockResolvedValueOnce(mockResponse(bad));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30, "behavioral"),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("a LIGHT-shaped answer to a STAR request fails validation (no silent variant mixing)", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const light = validVoiceModelOutput(); // has_beginning/middle/end shape
    generateContentMock
      .mockResolvedValueOnce(mockResponse(light))
      .mockResolvedValueOnce(mockResponse(light));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30, "behavioral"),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
  });

  it("structure_score out of range (>100) fails Zod validation", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const bad = validStarModelOutput();
    (bad.structure_assessment as Record<string, unknown>).structure_score = 150;
    generateContentMock.mockResolvedValueOnce(mockResponse(bad)).mockResolvedValueOnce(mockResponse(bad));

    await expect(
      analyzeInterviewAudio(new ArrayBuffer(4), "audio/webm", null, 30, "behavioral"),
    ).rejects.toMatchObject({ name: "GeminiError", kind: "invalid_output" });
  });
});

describe("fallacy batch generation — structured output parsing + guardrails", () => {
  it("accepts a well-formed batch and maps to app shape", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse({ rounds: [validFallacyRound()] }));

    const { rounds } = await generateFallacyRounds(1);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].correct_key).toBe("hasty_generalization");
    expect(rounds[0].choices).toHaveLength(4);
    expect(rounds[0].choices.map((c) => c.key)).toContain("hasty_generalization");
  });

  it("drops a round where correct_fallacy is not among its 4 options", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    // Zod enum still allows this shape (correct_fallacy separately enum-checked),
    // but app-level guardrail requires correct ∈ options.
    const bad = validFallacyRound({
      options: ["strawman", "ad_hominem", "false_cause", "bandwagon"],
      correct_fallacy: "hasty_generalization", // NOT in options
    });
    generateContentMock.mockResolvedValueOnce(mockResponse({ rounds: [bad] }));

    const { rounds } = await generateFallacyRounds(1);
    expect(rounds).toHaveLength(0); // dropped, not crashed
  });

  it("drops a round with duplicate options (fewer than 4 unique)", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    const bad = validFallacyRound({
      options: ["hasty_generalization", "hasty_generalization", "strawman", "ad_hominem"],
    });
    generateContentMock.mockResolvedValueOnce(mockResponse({ rounds: [bad] }));

    const { rounds } = await generateFallacyRounds(1);
    expect(rounds).toHaveLength(0);
  });

  it("drops a round whose explanation is too short (<120 chars per AI_DESIGN §2.8)", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    const bad = validFallacyRound({ explanation: "Too short." });
    generateContentMock.mockResolvedValueOnce(mockResponse({ rounds: [bad] }));

    const { rounds } = await generateFallacyRounds(1);
    expect(rounds).toHaveLength(0);
  });

  it("rejects a round with an option outside the closed taxonomy at the Zod layer", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    const bad = validFallacyRound({
      options: ["strawman", "ad_hominem", "false_cause", "not_a_real_fallacy"],
    });
    generateContentMock.mockResolvedValueOnce(mockResponse({ rounds: [bad] }));

    // Whole batch fails Zod parse (array of enums), which surfaces as invalid_output.
    await expect(generateFallacyRounds(1)).rejects.toMatchObject({
      name: "GeminiError",
      kind: "invalid_output",
    });
  });

  it("partial success: one bad round in a batch does not sink the good ones", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    const good = validFallacyRound();
    const badButSchemaValid = validFallacyRound({
      argument: "Different argument text to avoid same-hash collision in this test.",
      scenario_summary: "different scenario",
      explanation: "short", // fails the >=120 char guardrail but is Zod-schema-valid
    });
    generateContentMock.mockResolvedValueOnce(
      mockResponse({ rounds: [good, badButSchemaValid] }),
    );

    const { rounds } = await generateFallacyRounds(2);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].argument_text).toContain("coworker");
  });

  it("empty rounds array is accepted by schema and yields zero valid rounds (no crash)", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse({ rounds: [] }));

    const { rounds } = await generateFallacyRounds(5);
    expect(rounds).toHaveLength(0);
  });

  it("missing top-level 'rounds' key fails schema without crashing", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse({ items: [] }));

    await expect(generateFallacyRounds(5)).rejects.toMatchObject({
      name: "GeminiError",
      kind: "invalid_output",
    });
  });

  it("does NOT retry on invalid_output for fallacy batch (no-retry path; only voice retries)", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(mockResponse({ items: [] }));

    await expect(generateFallacyRounds(5)).rejects.toBeTruthy();
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });
});

describe("error classification (429 / timeout / no_api_key)", () => {
  it("classifies a 429 status error as rate_limited after exhausting retries", async () => {
    vi.useFakeTimers();
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    generateContentMock.mockRejectedValue(err);

    const assertion = expect(generateFallacyRounds(5)).rejects.toMatchObject({
      name: "GeminiError",
      kind: "rate_limited",
    });
    // Let backoff timers resolve (MAX_RETRIES=2 -> up to 2 waits).
    await vi.runAllTimersAsync();
    await assertion;
    expect(generateContentMock).toHaveBeenCalledTimes(3); // initial + 2 retries
    vi.useRealTimers();
  });

  it("honors a server-provided retryDelay instead of the default backoff", async () => {
    vi.useFakeTimers();
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    const err = Object.assign(new Error('RESOURCE_EXHAUSTED retryDelay: "2s"'), { status: 429 });
    generateContentMock.mockRejectedValueOnce(err).mockResolvedValueOnce(
      mockResponse({ rounds: [validFallacyRound()] }),
    );

    const promise = generateFallacyRounds(1);
    await vi.advanceTimersByTimeAsync(2100);
    const result = await promise;
    expect(result.rounds).toHaveLength(1);
    vi.useRealTimers();
  });

  it("classifies a generic 5xx/network error (non-429) as 'failed' after retries", async () => {
    vi.useFakeTimers();
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    generateContentMock.mockRejectedValue(new Error("ECONNRESET"));

    const assertion = expect(generateFallacyRounds(5)).rejects.toMatchObject({
      name: "GeminiError",
      kind: "failed",
    });
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });

  it("recovers if a transient error is followed by a successful call within retry budget", async () => {
    vi.useFakeTimers();
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    generateContentMock
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(mockResponse({ rounds: [validFallacyRound()] }));

    const promise = generateFallacyRounds(1);
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.rounds).toHaveLength(1);
    vi.useRealTimers();
  });

  it("no_api_key error is thrown immediately without ever calling generateContent", async () => {
    vi.resetModules();
    const prevKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    await expect(generateFallacyRounds(5)).rejects.toMatchObject({
      name: "GeminiError",
      kind: "no_api_key",
    });
    expect(generateContentMock).not.toHaveBeenCalled();

    process.env.GEMINI_API_KEY = prevKey;
  });

  it("empty-string API key is treated as absent (no_api_key), not sent to the SDK", async () => {
    vi.resetModules();
    const prevKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "";

    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    await expect(generateFallacyRounds(5)).rejects.toMatchObject({
      name: "GeminiError",
      kind: "no_api_key",
    });

    process.env.GEMINI_API_KEY = prevKey;
  });
});

describe("self-critique pass (needs_review) is best-effort", () => {
  it("a failing self-critique call does not sink the batch — rounds are still returned", async () => {
    vi.useFakeTimers();
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    // First call: the batch itself succeeds.
    generateContentMock
      .mockResolvedValueOnce(mockResponse({ rounds: [validFallacyRound()] }))
      // Second call: self-critique fails every retry.
      .mockRejectedValue(new Error("self-critique down"));

    const promise = generateFallacyRounds(1, { selfCritique: true });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.rounds).toHaveLength(1); // batch content survives
    expect(result.needsReviewSummaries.size).toBe(0); // critique just didn't flag anything
    vi.useRealTimers();
  });

  it("flags a round as needs_review when self-critique says single_fallacy: false", async () => {
    const { generateFallacyRounds } = await import("@/lib/gemini/client");
    const round = validFallacyRound();
    generateContentMock
      .mockResolvedValueOnce(mockResponse({ rounds: [round] }))
      .mockResolvedValueOnce(
        mockResponse({
          verdicts: [{ index: 0, single_fallacy: false, why: "also arguably strawman" }],
        }),
      );

    const result = await generateFallacyRounds(1, { selfCritique: true });
    expect(result.rounds).toHaveLength(1);
    expect(result.needsReviewSummaries.has(round.scenario_summary)).toBe(true);
  });
});
