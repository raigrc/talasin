/**
 * Interview prompt categories + display labels (DESIGN_V1.md §4.5). Plain
 * constants with NO server-only import so client components (category chips)
 * can share them. Existing DB keys are kept ('pitch' ≙ "Elevator pitch",
 * 'technical' ≙ "Technical explainer") — labels live here, no data rewrite.
 */

export const INTERVIEW_CATEGORIES = [
  "behavioral",
  "technical",
  "pitch",
  "negotiation",
] as const;

export type InterviewCategoryKey = (typeof INTERVIEW_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<InterviewCategoryKey, string> = {
  behavioral: "Behavioral",
  technical: "Technical explainer",
  pitch: "Elevator pitch",
  negotiation: "Negotiation",
};

/** Display label for a stored category value; raw value / fallback otherwise. */
export function categoryLabel(category: string | null | undefined): string {
  if (!category) return "Ad-hoc";
  return CATEGORY_LABELS[category as InterviewCategoryKey] ?? category;
}

/** Type guard for the ?category= searchParam and chip state. */
export function isInterviewCategory(value: string): value is InterviewCategoryKey {
  return (INTERVIEW_CATEGORIES as readonly string[]).includes(value);
}
