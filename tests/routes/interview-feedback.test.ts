import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Route-handler validation tests for POST /api/interview/feedback
 * (DESIGN.md §3.6, AI_DESIGN §1.2/§1.8, DESIGN_V1.md §4.3). `requireSession`,
 * `analyzeInterviewAudio`, the interview DB helpers, and afterActivity are
 * mocked so these exercise ONLY the route's own request-shape validation,
 * status-code mapping, variant selection (category → STAR), and the additive
 * v1 response fields — no live Gemini/Supabase call.
 *
 * Priority test area #5 from the QA brief: duration 0 -> 400, empty/tiny audio ->
 * 400, unsupported mime -> 400, no-api-key -> graceful 500.
 */

const {
  requireSessionMock,
  analyzeMock,
  getPromptByIdMock,
  insertInterviewAttemptMock,
  getPreviousMock,
  afterActivityMock,
} = vi.hoisted(() => ({
  requireSessionMock: vi.fn().mockResolvedValue(undefined),
  analyzeMock: vi.fn(),
  getPromptByIdMock: vi.fn().mockResolvedValue(null),
  insertInterviewAttemptMock: vi.fn().mockResolvedValue("attempt-123"),
  getPreviousMock: vi.fn().mockResolvedValue(null),
  afterActivityMock: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireSession: requireSessionMock,
  UnauthorizedError: class UnauthorizedError extends Error {},
}));
vi.mock("@/lib/gemini/client", () => ({
  analyzeInterviewAudio: analyzeMock,
}));
vi.mock("@/lib/interview", () => ({
  getPromptById: getPromptByIdMock,
  insertInterviewAttempt: insertInterviewAttemptMock,
  getPreviousComparableAttempt: getPreviousMock,
}));
vi.mock("@/lib/progression", () => ({
  afterActivity: afterActivityMock,
}));

async function loadHandler() {
  const mod = await import("@/app/api/interview/feedback/route");
  return mod.POST;
}

function buildRequest(form: FormData): Request {
  return new Request("http://localhost/api/interview/feedback", {
    method: "POST",
    body: form,
  });
}

function validForm(overrides: { audio?: Blob; duration_sec?: string; prompt_id?: string } = {}): FormData {
  const form = new FormData();
  const audio = overrides.audio ?? new Blob([new Uint8Array(2048)], { type: "audio/webm;codecs=opus" });
  form.set("audio", audio, "clip.webm");
  form.set("duration_sec", overrides.duration_sec ?? "30");
  if (overrides.prompt_id) form.set("prompt_id", overrides.prompt_id);
  return form;
}

function validFeedback(overrides: Record<string, unknown> = {}) {
  return {
    transcript: "hi",
    word_count: 1,
    filler_count: 0,
    filler_items: [],
    filler_per_min: 0,
    words_per_minute: 60,
    clarity_score: 80,
    structure: { has_beginning: true, has_middle: true, has_end: true, note: "" },
    structure_note: "",
    star: null,
    structure_score: null,
    coaching: ["a", "b"],
    overall_delivery_score: 70,
    confidence: "high",
    model: "gemini-3.5-flash",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  requireSessionMock.mockResolvedValue(undefined);
  getPromptByIdMock.mockResolvedValue(null);
  insertInterviewAttemptMock.mockResolvedValue("attempt-123");
  getPreviousMock.mockResolvedValue(null);
  afterActivityMock.mockResolvedValue({
    streak: 1,
    xpAwarded: 50,
    xpTotal: 550,
    level: 3,
    newAchievements: [],
  });
});

describe("POST /api/interview/feedback — auth", () => {
  it("returns 401 when there is no valid session", async () => {
    const { UnauthorizedError } = await import("@/lib/session");
    requireSessionMock.mockRejectedValueOnce(new UnauthorizedError());
    const POST = await loadHandler();

    const res = await POST(buildRequest(validForm()));
    expect(res.status).toBe(401);
  });
});

describe("POST /api/interview/feedback — request validation", () => {
  it("400 when audio field is missing entirely", async () => {
    const POST = await loadHandler();
    const form = new FormData();
    form.set("duration_sec", "30");
    const res = await POST(buildRequest(form));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/missing audio/i);
  });

  it("400 when duration_sec is 0", async () => {
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm({ duration_sec: "0" })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid duration/i);
  });

  it("400 when duration_sec is negative", async () => {
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm({ duration_sec: "-5" })));
    expect(res.status).toBe(400);
  });

  it("400 when duration_sec is missing (NaN after Number())", async () => {
    const POST = await loadHandler();
    const form = new FormData();
    form.set("audio", new Blob([new Uint8Array(2048)], { type: "audio/webm" }), "clip.webm");
    const res = await POST(buildRequest(form));
    expect(res.status).toBe(400);
  });

  it("400 when duration_sec is non-numeric garbage", async () => {
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm({ duration_sec: "not-a-number" })));
    expect(res.status).toBe(400);
  });

  it("400 when duration_sec exceeds the 130s ceiling", async () => {
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm({ duration_sec: "9999" })));
    expect(res.status).toBe(400);
  });

  it("400 when audio is empty (0 bytes, below MIN_AUDIO_BYTES)", async () => {
    const POST = await loadHandler();
    const emptyAudio = new Blob([], { type: "audio/webm" });
    const res = await POST(buildRequest(validForm({ audio: emptyAudio })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("empty_audio");
  });

  it("400 when audio is tiny (below the 1KB MIN_AUDIO_BYTES floor)", async () => {
    const POST = await loadHandler();
    const tinyAudio = new Blob([new Uint8Array(100)], { type: "audio/webm" });
    const res = await POST(buildRequest(validForm({ audio: tinyAudio })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("empty_audio");
  });

  it("413 when audio exceeds the 12MB cap", async () => {
    const POST = await loadHandler();
    const bigAudio = new Blob([new Uint8Array(12 * 1024 * 1024 + 1)], { type: "audio/webm" });
    const res = await POST(buildRequest(validForm({ audio: bigAudio })));
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.code).toBe("audio_too_large");
  });

  it("400 for an unsupported MIME type (e.g. video/mp4)", async () => {
    const POST = await loadHandler();
    const badMime = new Blob([new Uint8Array(2048)], { type: "video/mp4" });
    const res = await POST(buildRequest(validForm({ audio: badMime })));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("unsupported_format");
  });

  it("400 for an unsupported MIME type (text/plain — nonsense upload)", async () => {
    const POST = await loadHandler();
    const badMime = new Blob([new Uint8Array(2048)], { type: "text/plain" });
    const res = await POST(buildRequest(validForm({ audio: badMime })));
    expect(res.status).toBe(400);
  });

  it("accepts audio/wav as a fallback format", async () => {
    analyzeMock.mockResolvedValueOnce(validFeedback());
    const POST = await loadHandler();
    const wavAudio = new Blob([new Uint8Array(2048)], { type: "audio/wav" });
    const res = await POST(buildRequest(validForm({ audio: wavAudio })));
    expect(res.status).toBe(200);
  });

  it("a Blob appended to FormData with no explicit MIME type is serialized as " +
    "application/octet-stream by the multipart encoder and is REJECTED as unsupported " +
    "(documents real fetch/undici + browser FormData behavior — an untyped MediaRecorder " +
    "blob would fail this check; recorder must always set a mimeType)", async () => {
    const POST = await loadHandler();
    const noType = new Blob([new Uint8Array(2048)]); // type === "" before multipart encoding
    const res = await POST(buildRequest(validForm({ audio: noType })));
    // NOTE: audio.type becomes "application/octet-stream" after the multipart
    // round-trip (verified independently), which is NOT in ACCEPTED_MIME_PREFIXES.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("unsupported_format");
  });

  it("unknown/retired prompt_id is treated as ad-hoc (does not error)", async () => {
    getPromptByIdMock.mockResolvedValueOnce(null);
    analyzeMock.mockResolvedValueOnce(validFeedback());
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm({ prompt_id: "00000000-0000-0000-0000-000000000000" })));
    expect(res.status).toBe(200);
    expect(insertInterviewAttemptMock).toHaveBeenCalledWith(expect.anything(), null, 30);
    // Ad-hoc: analysis runs with a null category (light heuristic, not STAR).
    expect(analyzeMock).toHaveBeenCalledWith(expect.anything(), "audio/webm", null, 30, null);
  });
});

describe("POST /api/interview/feedback — category → STAR variant selection (DESIGN_V1 §4.3)", () => {
  it("a behavioral prompt's category is passed to analyzeInterviewAudio", async () => {
    getPromptByIdMock.mockResolvedValueOnce({
      id: "p-behavioral",
      prompt_text: "Tell me about a time...",
      category: "behavioral",
    });
    analyzeMock.mockResolvedValueOnce(
      validFeedback({
        star: { situation: true, task: true, action: true, result: false },
        structure_score: 68,
      }),
    );
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm({ prompt_id: "p-behavioral" })));
    expect(res.status).toBe(200);
    expect(analyzeMock).toHaveBeenCalledWith(
      expect.anything(),
      "audio/webm",
      "Tell me about a time...",
      30,
      "behavioral",
    );
    const body = await res.json();
    expect(body.star).toEqual({ situation: true, task: true, action: true, result: false });
    expect(body.structure_score).toBe(68);
  });

  it("a pitch prompt keeps the light heuristic: star/structure_score come back null", async () => {
    getPromptByIdMock.mockResolvedValueOnce({
      id: "p-pitch",
      prompt_text: "Pitch yourself.",
      category: "pitch",
    });
    analyzeMock.mockResolvedValueOnce(validFeedback());
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm({ prompt_id: "p-pitch" })));
    expect(res.status).toBe(200);
    expect(analyzeMock).toHaveBeenCalledWith(
      expect.anything(),
      "audio/webm",
      "Pitch yourself.",
      30,
      "pitch",
    );
    const body = await res.json();
    expect(body.star).toBeNull();
    expect(body.structure_score).toBeNull();
  });
});

describe("POST /api/interview/feedback — Gemini error mapping", () => {
  it("no_api_key classifies as HTTP 500 (graceful, not a crash)", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    analyzeMock.mockRejectedValueOnce(new GeminiError("no_api_key", "no key"));
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("no_api_key");
  });

  it("rate_limited classifies as HTTP 429", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    analyzeMock.mockRejectedValueOnce(new GeminiError("rate_limited", "quota exhausted"));
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm()));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("gemini_rate_limited");
  });

  it("invalid_output classifies as HTTP 502", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    analyzeMock.mockRejectedValueOnce(new GeminiError("invalid_output", "bad json"));
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm()));
    expect(res.status).toBe(502);
  });

  it("generic/unknown error classifies as HTTP 500 server_error", async () => {
    analyzeMock.mockRejectedValueOnce(new Error("something exploded"));
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm()));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("server_error");
  });

  it("on Gemini failure, nothing is written (insert + afterActivity are never called)", async () => {
    const { GeminiError } = await import("@/lib/gemini/config");
    analyzeMock.mockRejectedValueOnce(new GeminiError("failed", "boom"));
    const POST = await loadHandler();
    await POST(buildRequest(validForm()));
    expect(insertInterviewAttemptMock).not.toHaveBeenCalled();
    expect(afterActivityMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/interview/feedback — happy path", () => {
  it("200 with full feedback shape + additive v1 gamification fields on success", async () => {
    analyzeMock.mockResolvedValueOnce(
      validFeedback({ transcript: "hello world", word_count: 2, overall_delivery_score: 88 }),
    );
    afterActivityMock.mockResolvedValueOnce({
      streak: 4,
      xpAwarded: 50,
      xpTotal: 1200,
      level: 4,
      newAchievements: [{ key: "first_interview", name: "First rep" }],
    });
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempt_id).toBe("attempt-123");
    expect(body.transcript).toBe("hello world");
    // legacy field kept, additive fields per DESIGN_V1 §4.3
    expect(body.streak).toBe(4);
    expect(body.xp_awarded).toBe(50);
    expect(body.xp_total).toBe(1200);
    expect(body.level).toBe(4);
    expect(body.new_achievements).toEqual([{ key: "first_interview", name: "First rep" }]);
    expect(body.previous).toBeNull();

    // afterActivity received the interview pillar + the facts predicates need.
    expect(afterActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pillar: "interview",
        xpAwarded: 50,
        attemptFacts: expect.objectContaining({
          duration_sec: 30,
          overall_delivery_score: 88,
        }),
      }),
    );
  });

  it("the previous comparable attempt flows through for the delta strip", async () => {
    getPromptByIdMock.mockResolvedValueOnce({
      id: "p1",
      prompt_text: "Q",
      category: "behavioral",
    });
    analyzeMock.mockResolvedValueOnce(validFeedback());
    const prev = {
      attempt_id: "prev1",
      created_at: "2026-07-01T10:00:00Z",
      overall_delivery_score: 71,
      clarity_score: 74,
      filler_per_min: 3.2,
      words_per_minute: 141,
    };
    getPreviousMock.mockResolvedValueOnce(prev);
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm({ prompt_id: "p1" })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previous).toEqual(prev);
    expect(getPreviousMock).toHaveBeenCalledWith("p1", "behavioral");
  });

  it("a failing previous-attempt lookup degrades to previous: null (does not sink the response)", async () => {
    analyzeMock.mockResolvedValueOnce(validFeedback());
    getPreviousMock.mockRejectedValueOnce(new Error("read failed"));
    const POST = await loadHandler();
    const res = await POST(buildRequest(validForm()));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.previous).toBeNull();
    expect(insertInterviewAttemptMock).toHaveBeenCalled(); // the attempt still lands
  });
});
