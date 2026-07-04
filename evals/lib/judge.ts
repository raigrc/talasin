/**
 * Blind second-opinion judge for fallacy content quality (AI_DESIGN §2.9).
 *
 * For each generated round, an INDEPENDENT Gemini call is shown only what a
 * player sees — the argument and its four options — and asked to identify the
 * fallacy. It never sees the labeled answer or the explanation. Agreement rate
 * between the blind judge and the stored `correct_key` is the automated proxy
 * for label precision (§2.9 gate: ≥90%).
 *
 * Honest caveat (also in evals/README.md): the free tier only offers the Flash
 * family, so the judge is the SAME model id as the generator. Correlated
 * errors are possible — agreement is an optimistic proxy, which is why every
 * disagreement is routed to a human-review CSV instead of being auto-trusted.
 *
 * This file is eval-only code; it deliberately does NOT modify lib/gemini.
 */
import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { GEMINI_MODEL } from "@/lib/gemini/config";
import { FALLACY_KEYS, type FallacyKey, type GeneratedRound } from "@/lib/gemini/schemas";

/** Marker string used by --mock routing to recognize judge requests. */
export const JUDGE_MARKER = "blind fallacy identification";

const JUDGE_SYSTEM_PROMPT = `You are an expert in informal logic performing ${JUDGE_MARKER}.
You are shown short arguments, each with four candidate fallacy labels. For each argument,
pick the ONE option that names the fallacy the argument actually commits. You are given no
answer key — judge only from the argument text. If two options seem defensible, pick the
single best fit. Output ONLY valid JSON matching the schema.`;

const judgeResponseZod = z.object({
  answers: z.array(
    z.object({
      index: z.number().int(),
      fallacy: z.enum(FALLACY_KEYS),
    }),
  ),
});

const JUDGE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    answers: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER },
          fallacy: { type: Type.STRING, enum: [...FALLACY_KEYS] },
        },
        required: ["index", "fallacy"],
      },
    },
  },
  required: ["answers"],
} as const;

/** One Gemini request for the whole batch. Returns index → judged fallacy. */
export async function judgeRounds(rounds: GeneratedRound[]): Promise<Map<number, FallacyKey>> {
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });

  const body = rounds
    .map(
      (r, i) =>
        `Argument ${i}:\n${r.argument_text}\nOptions: ${r.choices.map((c) => c.key).join(", ")}`,
    )
    .join("\n\n");

  const res = await client.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `Identify the fallacy committed by each argument below. Answer for every index 0 through ${rounds.length - 1}.\n\n${body}`,
          },
        ],
      },
    ],
    config: {
      systemInstruction: JUDGE_SYSTEM_PROMPT,
      responseMimeType: "application/json",
      responseSchema: JUDGE_RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  const text = res.text;
  if (!text) throw new Error("judge: empty model response");
  const parsed = judgeResponseZod.parse(JSON.parse(text));
  return new Map(parsed.answers.map((a) => [a.index, a.fallacy]));
}
