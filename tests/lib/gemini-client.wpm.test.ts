import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * WPM + filler-rate computation tests (AI_DESIGN §1.4, §1.7).
 *
 * `analyzeInterviewAudio` in lib/gemini/client.ts is the only place this math
 * lives (it's not separately exported), so we drive it end-to-end through a
 * mocked @google/genai SDK. This exercises the REAL production math:
 *   wpm             = round(serverWordCount / (durationSeconds / 60))
 *   fillerPerMin    = round1(model.filler_words.count / (durationSeconds / 60))
 *   confidence      = |serverWordCount - model.word_count| / serverWordCount < 0.10 ? high : low
 * without any network call or API key.
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

function mockResponse(json: unknown, tokens = 500) {
  return {
    text: JSON.stringify(json),
    usageMetadata: { totalTokenCount: tokens },
  };
}

function validVoiceModelOutput(overrides: Record<string, unknown> = {}) {
  return {
    transcript: "This is a short test answer without any filler words at all here",
    word_count: 13,
    filler_words: { count: 0, items: [] },
    clarity_score: 80,
    structure_assessment: {
      has_beginning: true,
      has_middle: true,
      has_end: true,
      note: "Clear structure.",
    },
    coaching: ["Be more concise.", "Vary your pacing."],
    overall_delivery_score: 75,
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

describe("analyzeInterviewAudio — WPM + filler-rate math", () => {
  it("computes WPM from server word count and true duration (normal case)", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    // 13 words / (60s / 60) = 13 wpm at exactly 60s... use a case with round numbers.
    // 150 words over 60 seconds = 150 WPM.
    const words = new Array(150).fill("word").join(" ");
    generateContentMock.mockResolvedValueOnce(
      mockResponse(validVoiceModelOutput({ transcript: words, word_count: 150 })),
    );

    const result = await analyzeInterviewAudio(
      new ArrayBuffer(10),
      "audio/webm",
      "Tell me about yourself",
      60,
    );

    expect(result.word_count).toBe(150);
    expect(result.words_per_minute).toBe(150);
    expect(result.confidence).toBe("high");
  });

  it("computes filler-rate per minute correctly", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    // 6 fillers over 120 seconds (2 min) = 3.0 fillers/min.
    generateContentMock.mockResolvedValueOnce(
      mockResponse(
        validVoiceModelOutput({
          filler_words: {
            count: 6,
            items: [{ word: "um", occurrences: 6 }],
          },
        }),
      ),
    );

    const result = await analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, 120);
    expect(result.filler_per_min).toBe(3);
  });

  it("filler-rate rounds to 1 decimal place", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    // 5 fillers over 90 seconds (1.5 min) = 3.333... -> rounds to 3.3
    generateContentMock.mockResolvedValueOnce(
      mockResponse(
        validVoiceModelOutput({
          filler_words: { count: 5, items: [{ word: "like", occurrences: 5 }] },
        }),
      ),
    );

    const result = await analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, 90);
    expect(result.filler_per_min).toBe(3.3);
  });

  it("rejects zero duration before calling Gemini at all", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    await expect(
      analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, 0),
    ).rejects.toMatchObject({ name: "GeminiError" });
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("rejects negative duration before calling Gemini at all", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    await expect(
      analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, -5),
    ).rejects.toMatchObject({ name: "GeminiError" });
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it("empty transcript yields word_count 0 and wpm 0, not NaN/Infinity", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(
      mockResponse(validVoiceModelOutput({ transcript: "", word_count: 0 })),
    );

    const result = await analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, 30);
    expect(result.word_count).toBe(0);
    expect(result.words_per_minute).toBe(0);
    expect(Number.isFinite(result.words_per_minute)).toBe(true);
    // 0/0 comparison in confidence calc must not throw or produce NaN-driven crash.
    expect(["high", "low"]).toContain(result.confidence);
  });

  it("whitespace-only transcript counts as zero words (countWords filters empties)", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(
      mockResponse(validVoiceModelOutput({ transcript: "   \n\t  ", word_count: 0 })),
    );
    const result = await analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, 30);
    expect(result.word_count).toBe(0);
  });

  it("confidence is 'low' when model word_count diverges >10% from server-recomputed count", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const words = new Array(100).fill("word").join(" "); // server recount = 100
    generateContentMock.mockResolvedValueOnce(
      mockResponse(validVoiceModelOutput({ transcript: words, word_count: 50 })), // model says 50 -> 50% divergence
    );
    const result = await analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, 60);
    expect(result.word_count).toBe(100); // server count is authoritative
    expect(result.confidence).toBe("low");
  });

  it("confidence is 'high' when model/server word counts are within 10%", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    const words = new Array(100).fill("word").join(" ");
    generateContentMock.mockResolvedValueOnce(
      mockResponse(validVoiceModelOutput({ transcript: words, word_count: 95 })), // 5% divergence
    );
    const result = await analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, 60);
    expect(result.confidence).toBe("high");
  });

  it("very short duration (1s) still computes a finite (large) WPM, no crash", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    generateContentMock.mockResolvedValueOnce(
      mockResponse(validVoiceModelOutput({ transcript: "hello world", word_count: 2 })),
    );
    const result = await analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, 1);
    // 2 words / (1/60 min) = 120 wpm
    expect(result.words_per_minute).toBe(120);
    expect(Number.isFinite(result.words_per_minute)).toBe(true);
  });

  it("WPM uses the SERVER word count, not the model's self-reported word_count", async () => {
    const { analyzeInterviewAudio } = await import("@/lib/gemini/client");
    // Model claims word_count: 999 but transcript actually has 10 words.
    const words = new Array(10).fill("word").join(" ");
    generateContentMock.mockResolvedValueOnce(
      mockResponse(validVoiceModelOutput({ transcript: words, word_count: 999 })),
    );
    const result = await analyzeInterviewAudio(new ArrayBuffer(10), "audio/webm", null, 60);
    expect(result.word_count).toBe(10); // server truth
    expect(result.words_per_minute).toBe(10); // computed from server truth, not 999
  });
});
