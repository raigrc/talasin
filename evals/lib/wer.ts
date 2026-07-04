/**
 * Word Error Rate (WER) — standard word-level Levenshtein distance between a
 * ground-truth reference transcript and the model's hypothesis transcript,
 * divided by the reference length (AI_DESIGN.md §1.9: gate is WER < 10% on
 * clear reads).
 *
 * Normalization before comparison: lowercase, unify curly apostrophes, strip
 * all punctuation except in-word apostrophes, collapse whitespace. This keeps
 * the metric about WORDS, not about whether the model wrote "row-by-row" vs
 * "row by row," or ended a sentence with a period.
 */

export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-level Levenshtein distance (substitutions + deletions + insertions). */
export function wordLevenshtein(ref: readonly string[], hyp: readonly string[]): number {
  const n = ref.length;
  const m = hyp.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= m; j++) {
      cur[j] = Math.min(
        prev[j] + 1, // deletion
        cur[j - 1] + 1, // insertion
        prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1), // substitution
      );
    }
    prev = cur;
  }
  return prev[m];
}

/** WER as a percentage of the reference word count. */
export function werPercent(referenceText: string, hypothesisText: string): number {
  const ref = normalizeWords(referenceText);
  const hyp = normalizeWords(hypothesisText);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 100;
  return (wordLevenshtein(ref, hyp) / ref.length) * 100;
}

/** The APP'S word-count method (must match lib/gemini/client.ts countWords). */
export function appWordCount(transcript: string): number {
  return transcript.trim().split(/\s+/).filter(Boolean).length;
}
