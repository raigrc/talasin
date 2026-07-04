import { createHash } from "node:crypto";
import { FORMS, TERM_TRIPLES, type SyllogismForm } from "./templates";

/**
 * Syllogism round composition (DESIGN_V1.md §3.5). Pure: substitute a term
 * triple into a form's phrasing, look validity up deterministically from the
 * template bank, and avoid recently-seen exact combos via a terms hash.
 */

export interface ComposedRound {
  form_id: string;
  valid: boolean;
  premises: [string, string];
  conclusion: string;
  explanation: string;
  terms_hash: string;
  triple: number; // index into TERM_TRIPLES
  phrasing: 0 | 1;
}

/** Look a form up by id; null for unknown ids (e.g. a token minted pre-rename). */
export function getForm(id: string): SyllogismForm | null {
  return FORMS.find((f) => f.id === id) ?? null;
}

/** Stable hash of the exact (form, terms, phrasing) combo — stored in detail.terms_hash. */
export function termsHash(formId: string, tripleIdx: number, phrasingIdx: number): string {
  return createHash("sha256")
    .update(`${formId}|${tripleIdx}|${phrasingIdx}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function substitute(template: string, terms: [string, string, string]): string {
  return template
    .replaceAll("{A}", terms[0])
    .replaceAll("{B}", terms[1])
    .replaceAll("{C}", terms[2]);
}

/** Compose the concrete round for a (form, triple, phrasing) pick. Deterministic. */
export function composeRound(
  formIdx: number,
  tripleIdx: number,
  phrasingIdx: 0 | 1,
): ComposedRound {
  const form = FORMS[formIdx];
  const terms = TERM_TRIPLES[tripleIdx];
  const phrasing = form.phrasings[phrasingIdx];
  return {
    form_id: form.id,
    valid: form.valid,
    premises: [
      substitute(phrasing.premises[0], terms),
      substitute(phrasing.premises[1], terms),
    ],
    conclusion: substitute(phrasing.conclusion, terms),
    explanation: form.explanation,
    terms_hash: termsHash(form.id, tripleIdx, phrasingIdx),
    triple: tripleIdx,
    phrasing: phrasingIdx,
  };
}

const MAX_PICK_TRIES = 80;

/**
 * Random round excluding recently-seen combos (by terms_hash). With 2,880
 * combos and a ≤300-hash exclusion window, rejection sampling almost always
 * lands on the first try; after MAX_PICK_TRIES we accept a repeat rather than
 * loop forever (the pool can never be exhausted, only briefly unlucky).
 */
export function pickRound(
  recentHashes: ReadonlySet<string>,
  rand: () => number = Math.random,
): ComposedRound {
  let candidate: ComposedRound | null = null;
  for (let i = 0; i < MAX_PICK_TRIES; i++) {
    const formIdx = Math.floor(rand() * FORMS.length);
    const tripleIdx = Math.floor(rand() * TERM_TRIPLES.length);
    const phrasingIdx = (rand() < 0.5 ? 0 : 1) as 0 | 1;
    candidate = composeRound(formIdx, tripleIdx, phrasingIdx);
    if (!recentHashes.has(candidate.terms_hash)) return candidate;
  }
  return candidate as ComposedRound;
}
