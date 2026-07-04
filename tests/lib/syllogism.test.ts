import { describe, it, expect } from "vitest";
import { FORMS, TERM_TRIPLES } from "@/lib/games/syllogism/templates";
import {
  composeRound,
  getForm,
  pickRound,
  termsHash,
} from "@/lib/games/syllogism/engine";

/**
 * Syllogism template-bank + engine tests (DESIGN_V1.md §3.5). The validity
 * table below is HAND-CHECKED, form by form — it is the ground truth the game
 * scores against, so every form is asserted individually. If a form is edited,
 * this table must be re-verified by a human, not just updated to match.
 */

// Hand-checked validity table (12 valid, 12 invalid).
const EXPECTED_VALIDITY: Record<string, boolean> = {
  // valid deductive forms
  barbara: true, //                All A⊂B, B⊂C ⊢ A⊂C
  celarent: true, //               No B are C, A⊂B ⊢ no A are C
  darii: true, //                  B⊂C, some A are B ⊢ some A are C
  ferio: true, //                  No B are C, some A are B ⊢ some A are not C
  modus_ponens: true, //           A→B, A ⊢ B
  modus_tollens: true, //          A→B, ¬B ⊢ ¬A
  hypothetical_syllogism: true, // A→B, B→C ⊢ A→C
  disjunctive_syllogism: true, //  A∨B, ¬A ⊢ B
  contraposition: true, //         A⊂B, ¬B ⊢ ¬A
  ferio_variant: true, //          No A are B, some C are A ⊢ some C are not B
  conversion_e: true, //           No A are B ⊢ no B are A (applied to an instance)
  conversion_i: true, //           Some A are B, A⊂C ⊢ some C are B
  // invalid forms (named fallacies)
  affirm_consequent: false, //     A→B, B ⊬ A
  deny_antecedent: false, //       A→B, ¬A ⊬ ¬B
  undistributed_middle: false, //  A⊂B, C⊂B ⊬ A⊂C
  illicit_major: false, //         A⊂B, no C are A ⊬ no C are B
  illicit_minor: false, //         A⊂B, A⊂C ⊬ C⊂B
  exclusive_premises: false, //    two negative premises prove nothing
  neg_premise_affirm_conclusion: false, // negative premise ⊬ affirmative conclusion
  existential_fallacy: false, //   universal premises ⊬ existential conclusion
  illicit_conversion_a: false, //  All A are B ⊬ all B are A
  illicit_conversion_o: false, //  Some A are not B ⊬ some B are not A
  affirm_disjunct: false, //       inclusive A∨B, A ⊬ ¬B
  some_for_all: false, //          premises license "some", conclusion claims "all"
};

describe("template bank shape", () => {
  it("has exactly 24 forms: 12 valid, 12 invalid, unique ids", () => {
    expect(FORMS).toHaveLength(24);
    expect(FORMS.filter((f) => f.valid)).toHaveLength(12);
    expect(FORMS.filter((f) => !f.valid)).toHaveLength(12);
    expect(new Set(FORMS.map((f) => f.id)).size).toBe(24);
  });

  it("has exactly 60 term triples of 3 non-empty terms each", () => {
    expect(TERM_TRIPLES).toHaveLength(60);
    for (const triple of TERM_TRIPLES) {
      expect(triple).toHaveLength(3);
      for (const term of triple) expect(term.length).toBeGreaterThan(0);
    }
  });

  it("every form carries 2 phrasings and a non-empty explanation", () => {
    for (const form of FORMS) {
      expect(form.phrasings).toHaveLength(2);
      expect(form.explanation.length).toBeGreaterThan(20);
      for (const phrasing of form.phrasings) {
        expect(phrasing.premises).toHaveLength(2);
        expect(phrasing.conclusion.length).toBeGreaterThan(0);
      }
    }
  });

  it("asserts every form's validity against the hand-checked table, one by one", () => {
    expect(Object.keys(EXPECTED_VALIDITY).sort()).toEqual(FORMS.map((f) => f.id).sort());
    for (const form of FORMS) {
      // Custom message so a failure names the offending form.
      expect(`${form.id}=${form.valid}`).toBe(`${form.id}=${EXPECTED_VALIDITY[form.id]}`);
    }
  });
});

describe("composeRound — substitution + determinism", () => {
  it("substitutes all placeholders (no residual {A}/{B}/{C} in any combo)", () => {
    for (let f = 0; f < FORMS.length; f++) {
      for (const p of [0, 1] as const) {
        const round = composeRound(f, 0, p);
        for (const text of [...round.premises, round.conclusion]) {
          expect(text).not.toMatch(/[{}]/);
        }
      }
    }
  });

  it("is deterministic and mirrors the form's validity + explanation", () => {
    const a = composeRound(0, 5, 1);
    const b = composeRound(0, 5, 1);
    expect(a).toEqual(b);
    expect(a.form_id).toBe(FORMS[0].id);
    expect(a.valid).toBe(FORMS[0].valid);
    expect(a.explanation).toBe(FORMS[0].explanation);
    expect(a.triple).toBe(5);
    expect(a.phrasing).toBe(1);
  });

  it("weaves the triple's terms into the surface text", () => {
    const [termA] = TERM_TRIPLES[0];
    const round = composeRound(0, 0, 0); // barbara, phrasing 0: "All {A} are {B}."
    expect(round.premises[0]).toContain(termA);
  });
});

describe("termsHash — recent-combo exclusion key", () => {
  it("is stable for the same combo and distinct across combos", () => {
    expect(termsHash("barbara", 0, 0)).toBe(termsHash("barbara", 0, 0));
    expect(termsHash("barbara", 0, 0)).not.toBe(termsHash("barbara", 0, 1));
    expect(termsHash("barbara", 0, 0)).not.toBe(termsHash("barbara", 1, 0));
    expect(termsHash("barbara", 0, 0)).not.toBe(termsHash("celarent", 0, 0));
    expect(termsHash("barbara", 0, 0)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("pickRound — repeat avoidance", () => {
  /** rand stub yielding a scripted sequence (repeats the last value if exhausted). */
  function seqRand(values: number[]): () => number {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  }

  it("returns the first candidate when it is not recently seen", () => {
    const round = pickRound(new Set(), seqRand([0, 0, 0]));
    expect(round).toEqual(composeRound(0, 0, 0));
  });

  it("skips a recently-seen combo and returns the next candidate", () => {
    const seen = new Set([termsHash(FORMS[0].id, 0, 0)]);
    // 1st try → combo(0,0,0) (excluded); 2nd try → combo(1,1,1) (fresh).
    const rand = seqRand([0, 0, 0, 1 / FORMS.length, 1 / TERM_TRIPLES.length, 0.9]);
    const round = pickRound(seen, rand);
    expect(round.terms_hash).not.toBe(termsHash(FORMS[0].id, 0, 0));
    expect(round).toEqual(composeRound(1, 1, 1));
  });

  it("accepts a repeat after exhausting the retry budget rather than looping forever", () => {
    const seen = new Set([termsHash(FORMS[0].id, 0, 0)]);
    const round = pickRound(seen, () => 0); // every try lands on the excluded combo
    expect(round.terms_hash).toBe(termsHash(FORMS[0].id, 0, 0));
  });
});

describe("getForm", () => {
  it("finds a form by id and returns null for unknown ids", () => {
    expect(getForm("barbara")?.valid).toBe(true);
    expect(getForm("affirm_consequent")?.valid).toBe(false);
    expect(getForm("not-a-form")).toBeNull();
  });
});
