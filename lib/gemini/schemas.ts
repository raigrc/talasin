import "server-only";
import { z } from "zod";
import { Type } from "@google/genai";

/**
 * Zod schemas (app-side validation of untrusted Gemini output) + the Gemini
 * responseSchema objects that ENFORCE structured JSON output.
 *
 * AI_DESIGN.md §1.7 (VOICE_SCHEMA) and §2.5 (FALLACY_BATCH_SCHEMA).
 * DESIGN.md §3.8 owns the app-facing return shapes.
 */

// ---------------------------------------------------------------------------
// Fallacy taxonomy (closed set — AI_DESIGN §2.2)
// ---------------------------------------------------------------------------
export const FALLACY_KEYS = [
  "strawman",
  "ad_hominem",
  "false_cause",
  "appeal_to_authority",
  "slippery_slope",
  "false_dilemma",
  "hasty_generalization",
  "circular_reasoning",
  "appeal_to_emotion",
  "bandwagon",
  "red_herring",
  "tu_quoque",
] as const;

export type FallacyKey = (typeof FALLACY_KEYS)[number];

export const DIFFICULTY_LABELS = ["easy", "medium", "hard"] as const;
export type DifficultyLabel = (typeof DIFFICULTY_LABELS)[number];

// ---------------------------------------------------------------------------
// Pronunciation taxonomy (closed set — AI_DESIGN pronunciation analysis)
// ---------------------------------------------------------------------------
export const PRONUNCIATION_CATEGORIES = [
  "th_stop",
  "vowel_merger",
  "r_color",
  "l_r_confusion",
  "consonant_cluster",
  "stress_timing",
  "v_w_merge",
  "final_consonant",
  "vowel_insertion",
  "other",
] as const;

export type PronunciationCategory = (typeof PRONUNCIATION_CATEGORIES)[number];

export const ACCENT_LABELS = [
  "filipino",
  "indian",
  "chinese",
  "japanese",
  "korean",
  "southeast_asian_other",
  "neutral",
  "unclear",
] as const;

export type AccentLabel = (typeof ACCENT_LABELS)[number];

export const SEVERITY_LEVELS = ["low", "medium", "high"] as const;
export type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

/** easy=1, medium=2, hard=3 for the smallint column. */
export function difficultyToInt(label: DifficultyLabel): number {
  return label === "easy" ? 1 : label === "medium" ? 2 : 3;
}

// ===========================================================================
// Feature 1 — Voice interview feedback
// ===========================================================================

/** Zod validation of the raw model JSON (AI_DESIGN §1.7). */
export const voiceModelSchema = z.object({
  transcript: z.string(),
  word_count: z.number().int(),
  filler_words: z.object({
    count: z.number().int(),
    items: z.array(
      z.object({
        word: z.string(),
        occurrences: z.number().int(),
      }),
    ),
  }),
  clarity_score: z.number().int().min(0).max(100),
  structure_assessment: z.object({
    has_beginning: z.boolean(),
    has_middle: z.boolean(),
    has_end: z.boolean(),
    note: z.string(),
  }),
  coaching: z.array(z.string()).min(2).max(3),
  overall_delivery_score: z.number().int().min(0).max(100),
});

export type VoiceModelOutput = z.infer<typeof voiceModelSchema>;

/**
 * STAR variant (DESIGN_V1.md §4.4) — used ONLY when the answered prompt's
 * category is 'behavioral'. Same call, same base fields; structure_assessment
 * becomes a strict Situation/Task/Action/Result rubric + a 0-100 structure
 * score. Derived from the base schema via .omit().extend() so the two variants
 * can't drift on the shared fields.
 */
export const voiceStarModelSchema = voiceModelSchema
  .omit({ structure_assessment: true })
  .extend({
    structure_assessment: z.object({
      has_situation: z.boolean(),
      has_task: z.boolean(),
      has_action: z.boolean(),
      has_result: z.boolean(),
      structure_score: z.number().int().min(0).max(100),
      note: z.string(),
    }),
  });

export type VoiceStarModelOutput = z.infer<typeof voiceStarModelSchema>;

/** Zod validation of a single pronunciation problem sound. */
export const pronunciationProblemSoundSchema = z.object({
  category: z.enum(PRONUNCIATION_CATEGORIES),
  description: z.string().min(1),
  examples: z.array(z.string()).min(1).max(3),
  severity: z.enum(SEVERITY_LEVELS),
  tip: z.string().min(1),
});

/** Zod validation of the pronunciation analysis block from the model. */
export const pronunciationAnalysisSchema = z.object({
  pronunciation_score: z.number().int().min(0).max(100),
  accent_label: z.enum(ACCENT_LABELS),
  accent_notes: z.string().min(1),
  problem_sounds: z.array(pronunciationProblemSoundSchema).max(5),
  pronunciation_coaching: z.array(z.string()).min(2).max(3),
});

export const voiceModelSchemaWithPronunciation = voiceModelSchema.extend({
  pronunciation: pronunciationAnalysisSchema,
});

export const voiceStarModelSchemaWithPronunciation = voiceStarModelSchema.extend({
  pronunciation: pronunciationAnalysisSchema,
});

/** The four STAR presence flags, as surfaced to the app/UI (DESIGN_V1.md §4.3). */
export interface StarFlags {
  situation: boolean;
  task: boolean;
  action: boolean;
  result: boolean;
}

/**
 * App-facing feedback (DESIGN.md §3.6). WPM and fillerPerMin are computed
 * SERVER-SIDE from the trusted client duration, never from the model
 * (AI_DESIGN §1.4). `word_count`/`wpm` here are the authoritative server numbers.
 * `star`/`structure_score` are non-null ONLY for behavioral prompts
 * (DESIGN_V1.md §4.3) — a pitch is never STAR-scored.
 */
export interface InterviewFeedback {
  transcript: string;
  word_count: number; // server-recomputed (authoritative)
  filler_count: number;
  filler_items: { word: string; occurrences: number }[];
  filler_per_min: number;
  words_per_minute: number; // server-computed
  clarity_score: number;
  structure: { has_beginning: boolean; has_middle: boolean; has_end: boolean; note: string };
  structure_note: string;
  star: StarFlags | null; // behavioral prompts only
  structure_score: number | null; // 0..100, behavioral prompts only
  coaching: string[];
  overall_delivery_score: number;
  confidence: "high" | "low";
  model: string;
  pronunciation: {
    score: number;
    accent_label: AccentLabel;
    accent_notes: string;
    problem_sounds: {
      category: PronunciationCategory;
      description: string;
      examples: string[];
      severity: SeverityLevel;
      tip: string;
    }[];
    coaching: string[];
  };
}

/** Gemini responseSchema for the voice call (JSON-Schema subset via SDK Type). */
const PRONUNCIATION_SCHEMA_PROPS = {
  pronunciation_score: { type: Type.INTEGER },
  accent_label: { type: Type.STRING, enum: [...ACCENT_LABELS] },
  accent_notes: { type: Type.STRING },
  problem_sounds: {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        category: { type: Type.STRING, enum: [...PRONUNCIATION_CATEGORIES] },
        description: { type: Type.STRING },
        examples: { type: Type.ARRAY, items: { type: Type.STRING } },
        severity: { type: Type.STRING, enum: [...SEVERITY_LEVELS] },
        tip: { type: Type.STRING },
      },
      required: ["category", "description", "examples", "severity", "tip"],
    },
  },
  pronunciation_coaching: { type: Type.ARRAY, items: { type: Type.STRING } },
};

const PRONUNCIATION_REQUIRED = [
  "pronunciation_score",
  "accent_label",
  "accent_notes",
  "problem_sounds",
  "pronunciation_coaching",
];

const VOICE_RESPONSE_SCHEMA_BASE = {
  type: Type.OBJECT,
  properties: {
    transcript: { type: Type.STRING },
    word_count: { type: Type.INTEGER },
    filler_words: {
      type: Type.OBJECT,
      properties: {
        count: { type: Type.INTEGER },
        items: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              word: { type: Type.STRING },
              occurrences: { type: Type.INTEGER },
            },
            required: ["word", "occurrences"],
          },
        },
      },
      required: ["count", "items"],
    },
    clarity_score: { type: Type.INTEGER },
    structure_assessment: {
      type: Type.OBJECT,
      properties: {
        has_beginning: { type: Type.BOOLEAN },
        has_middle: { type: Type.BOOLEAN },
        has_end: { type: Type.BOOLEAN },
        note: { type: Type.STRING },
      },
      required: ["has_beginning", "has_middle", "has_end", "note"],
    },
    coaching: { type: Type.ARRAY, items: { type: Type.STRING } },
    overall_delivery_score: { type: Type.INTEGER },
  },
  required: [
    "transcript",
    "word_count",
    "filler_words",
    "clarity_score",
    "structure_assessment",
    "coaching",
    "overall_delivery_score",
  ],
} as const;

export const VOICE_RESPONSE_SCHEMA = {
  ...VOICE_RESPONSE_SCHEMA_BASE,
  properties: {
    ...VOICE_RESPONSE_SCHEMA_BASE.properties,
    pronunciation: {
      type: Type.OBJECT,
      properties: PRONUNCIATION_SCHEMA_PROPS,
      required: PRONUNCIATION_REQUIRED,
    },
  },
  required: [...VOICE_RESPONSE_SCHEMA_BASE.required, "pronunciation"],
} as const;

/** Gemini responseSchema for the STAR variant — mirrors voiceStarModelSchema. */
export const VOICE_STAR_RESPONSE_SCHEMA = {
  ...VOICE_RESPONSE_SCHEMA_BASE,
  properties: {
    ...VOICE_RESPONSE_SCHEMA_BASE.properties,
    structure_assessment: {
      type: Type.OBJECT,
      properties: {
        has_situation: { type: Type.BOOLEAN },
        has_task: { type: Type.BOOLEAN },
        has_action: { type: Type.BOOLEAN },
        has_result: { type: Type.BOOLEAN },
        structure_score: { type: Type.INTEGER },
        note: { type: Type.STRING },
      },
      required: [
        "has_situation",
        "has_task",
        "has_action",
        "has_result",
        "structure_score",
        "note",
      ],
    },
    pronunciation: {
      type: Type.OBJECT,
      properties: PRONUNCIATION_SCHEMA_PROPS,
      required: PRONUNCIATION_REQUIRED,
    },
  },
  required: [...VOICE_RESPONSE_SCHEMA_BASE.required, "pronunciation"],
} as const;

// ===========================================================================
// Feature 2 — Spot-the-fallacy batch generation
// ===========================================================================

/** Zod validation of a single raw model round (AI_DESIGN §2.5). */
export const fallacyModelRoundSchema = z.object({
  argument: z.string().min(1),
  scenario_summary: z.string().min(1),
  options: z.array(z.enum(FALLACY_KEYS)).length(4),
  correct_fallacy: z.enum(FALLACY_KEYS),
  explanation: z.string().min(1),
  difficulty: z.enum(DIFFICULTY_LABELS),
});

export const fallacyBatchSchema = z.object({
  rounds: z.array(fallacyModelRoundSchema),
});

export type FallacyModelRound = z.infer<typeof fallacyModelRoundSchema>;

/**
 * App-facing generated round (DESIGN.md §3.8 return shape).
 * `choices` are {key,label} pairs; `correct_key` ∈ choices; difficulty is 1..3.
 */
export interface GeneratedRound {
  fallacy_key: FallacyKey;
  argument_text: string;
  scenario_summary: string;
  choices: { key: FallacyKey; label: string }[];
  correct_key: FallacyKey;
  explanation: string;
  difficulty: number; // 1..3
}

/** Gemini responseSchema for the batch call. `options`/`correct_fallacy` enum-constrained. */
export const FALLACY_BATCH_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    rounds: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          argument: { type: Type.STRING },
          scenario_summary: { type: Type.STRING },
          options: {
            type: Type.ARRAY,
            items: { type: Type.STRING, enum: [...FALLACY_KEYS] },
          },
          correct_fallacy: { type: Type.STRING, enum: [...FALLACY_KEYS] },
          explanation: { type: Type.STRING },
          difficulty: { type: Type.STRING, enum: [...DIFFICULTY_LABELS] },
        },
        required: [
          "argument",
          "scenario_summary",
          "options",
          "correct_fallacy",
          "explanation",
          "difficulty",
        ],
      },
    },
  },
  required: ["rounds"],
} as const;

// ===========================================================================
// Self-critique pass (AI_DESIGN §2.8) — flags multi-fallacy items.
// ===========================================================================
export const selfCritiqueSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.number().int(),
      single_fallacy: z.boolean(),
      why: z.string(),
    }),
  ),
});

export const SELF_CRITIQUE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    verdicts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER },
          single_fallacy: { type: Type.BOOLEAN },
          why: { type: Type.STRING },
        },
        required: ["index", "single_fallacy", "why"],
      },
    },
  },
  required: ["verdicts"],
} as const;
