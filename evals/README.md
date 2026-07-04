# Talasin evals — the "before you trust the trend charts" gate

This is the evaluation harness AI_DESIGN.md §1.9 / §2.9 specifies and
RUNBOOK.md ("Before you trust the trend charts") flags as the top pre-launch
follow-up. It answers two questions empirically:

1. **Voice:** are Gemini's filler counts, transcripts, and scores accurate and
   *stable* enough that the `/progress` trend lines mean something? (If the
   same performance scores 60 one day and 85 the next, the chart is noise.)
2. **Fallacy:** are the generated game rounds actually labeled with the
   fallacy they commit, and unambiguously so? (A round whose distractor is
   *also* correct actively teaches the wrong thing.)

Both scripts drive the **real production code path** — the same
`analyzeInterviewAudio` / `generateFallacyRounds` in `lib/gemini/client.ts`
the app calls, with the same prompts, response schemas, Zod validation, and
server-side WPM math. Nothing is reimplemented for the eval; if the eval
passes, the code the app runs passed. Neither script touches Supabase.

```
npm run eval:voice     # needs GEMINI_API_KEY + recorded fixtures (see fixtures/README.md)
npm run eval:fallacy   # needs GEMINI_API_KEY only
npm run eval:voice -- --mock     # no key needed: self-tests the harness itself
npm run eval:fallacy -- --mock
```

Both exit non-zero on FAIL, so they can gate CI later.

---

## eval:voice — voice feedback accuracy + stability (AI_DESIGN §1.9)

Reads `evals/fixtures/manifest.json` (8 scripted clips with known transcript,
word count, planted filler count, and measured duration), runs each through
`analyzeInterviewAudio` N times (default 2, `--runs 3` for the full §1.9
stability check), and gates on:

| Gate | Threshold | Why |
|---|---|---|
| Filler accuracy | detected count within **±1** of planted count, every run | The headline feature. If this is off, the filler trend is fiction. |
| WPM accuracy | app-computed WPM within **±5%** of `word_count / duration` | WPM is server-math from trusted duration; the only error source is transcript word-count drift. |
| Transcription | **WER < 10%** (word-level Levenshtein vs the script; case/punctuation-normalized; 15% for the Taglish clip) | Coaching that quotes a wrong transcript is garbage-in. |
| Score stability | `overall_delivery_score` and `clarity_score` vary **≤ 5 pts** across repeated runs of the *same* clip | Trend tracking is meaningless if identical input scores differently. |

Structure flags (s1 clear close vs s8 no-close) are checked informationally,
not gated, per §1.9's "manual check."

Flags: `--runs N`, `--limit K` (first K fixtures), `--delay-ms MS` (default
7000 — stays under the ~10 RPM free tier), `--manifest PATH`, `--mock`.

**Cost:** default run = 8 fixtures × 2 runs = **16 requests, ~70–80K tokens**
(~6% of the conservative 250 RPD free-tier budget), ~2–3 minutes paced.
`--runs 3` = 24 requests. $0 inside the free tier.

### Interpreting failures

- **Filler gate fails:** look at *which* clips. If only s4/s5 ("like"-heavy),
  it's the meaning-vs-crutch judgment — tighten the filler rules in
  `lib/gemini/prompts.ts` (VOICE_SYSTEM_PROMPT) and re-run. If it fails on
  zero-filler clips (phantom fillers), that's worse — consider dropping
  temperature to 0 in `lib/gemini/client.ts`.
- **WPM gate fails but WER passes:** the model is dropping/merging words at
  scale (often on the fast clip s3). Re-record slower or accept the model
  can't track >180 WPM — and know the app's `confidence: low` flag should be
  appearing on such clips (the per-run `conf` column shows it).
- **WER fails only on s7 (Taglish):** spelling variance, mostly cosmetic —
  check the transcript by eye; if the words are *recognizably* right and the
  filler count holds, the feature is fine for Taglish answers.
- **Stability fails:** the direct threat to the dashboard. Drop temperature
  0.2 → 0 for the voice call, or tighten the scoring rubric wording in the
  system prompt. Do not ship trend UI decisions until this passes (§1.9).

## eval:fallacy — content label quality (AI_DESIGN §2.9)

Generates 2 batches via the real `generateFallacyRounds` (with the production
self-critique pass on), then:

- **(a) structural re-check** of every surviving round (§2.8: 4 distinct
  taxonomy options, correct ∈ options, explanation ≥120 chars and names its
  fallacy, answer-position spread, in-run duplicates). Violations must be 0 —
  the production guardrails filter them, so any hit is a bug.
- **(b) blind second-opinion check:** one extra Gemini call per batch is shown
  ONLY what a player sees (argument + 4 options, **no answer key**) and asked
  to identify the fallacy. Agreement with the stored label is the automated
  proxy for §2.9 **label precision, gate ≥ 90%**.
- **(c) ambiguity:** rounds flagged multi-fallacy by the production
  self-critique, vs the §2.9 **< 5%** gate.

Every disagreement/flag is printed as "review these by hand" and ALL rounds
are written to `evals/output/fallacy-review.csv` (argument, label, judge pick,
flags) for the §2.9 human spot-check — open it in Excel/Sheets, read the
arguments, and decide whether the stored label is genuinely the one committed.

Honest caveat: the free tier only offers the Flash family, so the "second
opinion" is the same model id, independently prompted. Correlated errors are
possible, which makes agreement an **optimistic** proxy — that's exactly why
disagreements go to a human CSV instead of being auto-trusted, and why §2.9's
first ~30-round human read-through still matters.

Flags: `--batches N` (default 2), `--batch-size K` (default 10),
`--no-critique`, `--delay-ms MS`, `--mock`.

**Cost:** each batch = 2 requests (generation + critique) + 1 judge request →
**default run ≈ 6 Gemini requests** (~4 with `--no-critique`), ~25–30K tokens,
$0 inside the free tier. The eval prints this before running.

### Interpreting failures

- **Precision < 90%:** read the disagreeing rounds in the CSV. If the judge is
  right and the label is wrong → tighten `FALLACY_SYSTEM_PROMPT` (the
  "EXACTLY ONE fallacy" rules) and regenerate; consider purging similar rounds
  from the DB (`status='needs_review'`). If the *label* is right and the judge
  is wrong, the content is fine — note it and move on (this is why the gate
  has a human in the loop).
- **Ambiguity ≥ 5%:** the self-critique is catching multi-fallacy arguments at
  generation time. The pipeline already holds these out of play
  (`needs_review`), so players are safe — but a high rate means wasted quota
  and a prompt that needs tightening, especially the `hard` difficulty rules.
- **Structural violations > 0:** a `lib/gemini/client.ts` guardrail regressed.
  Fix the lib, not the content.

---

## --mock mode: how we know the harness itself is honest

`--mock` intercepts the HTTP layer (`globalThis.fetch`) underneath the real
SDK and plays canned Gemini responses through the **entire production
pipeline** — request serialization, retries, Zod validation, server WPM math,
batch guardrails. No API key, no network, no audio files needed.

The canned data is engineered so that **every gate demonstrably trips**: one
mock case fails ONLY the filler gate, one ONLY the WPM gate (8.5% word drift
with WER still under 10% — proving the gates are independent), one ONLY WER,
one ONLY stability; the fallacy mock contains a structurally invalid round
(must be dropped by the production guardrail), two engineered judge
disagreements (agreement = 80% → precision gate must FAIL), and one
needs_review flag (10% → ambiguity gate must FAIL). The run ends with a
self-test table comparing actual vs engineered outcomes and exits non-zero on
any mismatch.

Run the mocks after ANY change to `evals/` — they are the harness's own test
suite.

## When to re-run the real evals

- **Before first trusting the `/progress` dashboard** (this is the RUNBOOK gate).
- **Whenever `GEMINI_MODEL` changes** in `lib/gemini/config.ts` — model IDs
  drift and every model scores/counts differently (AI_DESIGN §5).
- **Whenever a prompt changes** in `lib/gemini/prompts.ts` (either feature).
- **Voice:** if score temperature/rubric changes; **Fallacy:** before any big
  `seed:fallacy` top-up if generation quality looked off.
- Periodically (monthly-ish) — free-tier models get silently updated.

Keep results comparable: don't re-record fixtures between runs you intend to
compare; re-record only when a script changes (then update `manifest.json`
ground truth — the harness cross-checks it at startup and refuses to run on
inconsistent ground truth).

## Files

```
evals/
  voice-eval.ts          # §1.9 harness (npm run eval:voice)
  fallacy-quality.ts     # §2.9 harness (npm run eval:fallacy)
  lib/                   # WER math, CLI args, mock fetch layer, blind judge, token meter
  fixtures/
    README.md            # recording protocol + the 8 scripts (start here)
    manifest.json        # ground truth (transcripts/counts pre-filled; you fill durations)
    audio/               # your recordings (git-ignored)
    mock/                # canned data for --mock self-tests
  output/                # fallacy-review.csv lands here (git-ignored)
```
