/**
 * --mock mode plumbing: intercept `globalThis.fetch` so the REAL production
 * call path (lib/gemini/client.ts → @google/genai SDK → HTTP) runs end-to-end
 * against canned responses, with zero network and no API key.
 *
 * Why fetch-level (not module mocking): the @google/genai SDK calls the global
 * `fetch` at request time (verified against the installed SDK), so replacing it
 * exercises everything real — request serialization, runStructured's timeout/
 * retry wrapper, Zod validation, and the server-side WPM/filler math. The mock
 * only plays the part of Google's HTTP endpoint.
 */

export interface MockRoute {
  /** Return true if this route should answer the request (match on the raw JSON body). */
  match: (body: string) => boolean;
  /** Produce the model's JSON payload (the object the app expects to JSON.parse). */
  respond: (body: string) => unknown;
  /** Label used in error messages. */
  label: string;
}

const GEMINI_HOST = "generativelanguage.googleapis.com";

export function installMockGemini(routes: MockRoute[]): void {
  // The client refuses to run without a key; any non-empty string works since
  // no request ever leaves the process.
  if (!process.env.GEMINI_API_KEY) process.env.GEMINI_API_KEY = "mock-key-not-real";

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes(GEMINI_HOST)) return realFetch(input, init);

    const body = typeof init?.body === "string" ? init.body : "";
    const route = routes.find((r) => r.match(body));
    if (!route) {
      throw new Error(
        `[mock-gemini] no canned route matched a Gemini request (url=${url.split("?")[0]})`,
      );
    }
    const modelJson = route.respond(body);
    const payload = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: JSON.stringify(modelJson) }] },
          finishReason: "STOP",
          index: 0,
        },
      ],
      // Plausible numbers so the token meter path is exercised too.
      usageMetadata: {
        promptTokenCount: 4300,
        candidatesTokenCount: 700,
        totalTokenCount: 5000,
      },
    };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

/**
 * Build a queue-backed responder: each matching request consumes the next
 * canned item. Throws loudly if the script under test makes more calls than
 * the mock data planned for (that itself is a useful failure signal).
 */
export function queueResponder(label: string, queue: unknown[]): (body: string) => unknown {
  return () => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`[mock-gemini] ${label}: canned response queue exhausted`);
    }
    return next;
  };
}

/**
 * A tiny valid mono 16-bit PCM WAV buffer (~0.2s of silence). --mock mode
 * feeds this through analyzeInterviewAudio so the real base64/inlineData path
 * runs; the bytes never reach a real model.
 */
export function silentWav(): ArrayBuffer {
  const sampleRate = 16_000;
  const samples = Math.floor(sampleRate * 0.2);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // PCM format
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
