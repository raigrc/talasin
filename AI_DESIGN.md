# Talasin — Gemini AI Integration Design

**Owner:** AI Systems
**Status:** Design spec (for senior-engineer to integrate — this is NOT the built app)
**Date:** 2026-07-01
**Scope:** Two Gemini-powered features on a single-user Next.js PWA, running on the **Gemini FREE tier** (Google AI Studio API key). **All Gemini calls are server-side** (Next.js route handlers). The API key lives only in a server env var and never reaches the client.

> `talas` = sharp/keen (Filipino). *Talasin* = "sharpen it" — the app sharpens delivery (voice feature) and reasoning (fallacy game).

---

## 0. Verified Gemini free-tier reality (checked 2026-07-01 via web + Google docs)

Model IDs and limits drift constantly, so these were re-verified today. **Numbers below are directional — the live cap for THIS project must be read from https://aistudio.google.com/rate-limit before launch, because free-tier limits vary by region, account age, and billing state.** Google's own rate-limits page explicitly refuses to publish per-model free numbers and points you at AI Studio.

### Models available on the free tier (2026-07-01)
As of mid-2026 the free tier covers **Flash and Flash-Lite only** — the Pro models moved behind billing. Current stable Flash line:

| Model ID | Notes | Audio in? | JSON schema out? |
|---|---|---|---|
| `gemini-3.5-flash` | Newest stable Flash (launched ~2026-05-19), 1M context, best price/perf Flash | Yes (native multimodal) | Yes |
| `gemini-2.5-flash` | Prior-gen Flash, still free | Yes | Yes |
| `gemini-3.1-flash-lite` | Cheapest/fastest, slightly lower quality | Yes | Yes |
| `gemini-2.5-flash-lite` | Older lite | Yes | Yes |

### Free-tier limits (directional — confirm in AI Studio)
Third-party trackers disagree because the number is per-project. Plan against the **conservative** end:

- **RPM:** ~10–15 requests/min (treat as **10**)
- **RPD:** ~250–1,500 requests/day (treat as **250** to be safe; many projects get more)
- **TPM:** ~250,000 tokens/min (some report up to 1M for 2.5-flash)
- **RPD reset:** midnight **Pacific** time
- **Cost on free tier:** $0 for input/output tokens. Google's pricing page lists a nominal per-1M audio rate on some Flash-Lite rows, but that is the *paid*-tier rate; free-tier usage is billed at $0 up to the quota. We stay inside quota by design, so cost = $0.

### Audio input facts (from https://ai.google.dev/gemini-api/docs/audio)
- **Supported MIME types:** `audio/wav`, `audio/mp3`, `audio/aiff`, `audio/aac`, `audio/ogg`, `audio/flac`.
- **Inline request cap:** **20 MB total** (prompt + all inline files combined). Above that you must use the **Files API** (upload then reference).
- **Token cost of audio:** **32 tokens / second** → **1 minute ≈ 1,920 tokens**. A 2-min clip ≈ **3,840 tokens** of input.
- **Max audio length:** 9.5 hours (irrelevant here; we cap at ~2 min).
- **Transcription + structured output:** confirmed supported together — you can ask for a transcript and receive it inside a JSON-schema-constrained response in one call.
- **Timestamps:** available via an `audioTimestamp` generation-config flag, but they are **logically-grouped (paragraph-level), NOT reliable per-word.** → **We do NOT trust Gemini for duration/WPM.** See §1.4.

### Structured output facts (from https://ai.google.dev/gemini-api/docs/structured-output)
- Set `responseMimeType: "application/json"` + a `responseSchema` on the request.
- Supports a **subset** of JSON Schema. Works with Zod (TS) / Pydantic (Py) via the GenAI SDK.
- Available on the free-tier Flash models. This is the enforcement mechanism for BOTH features.

**Sources:** [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) · [Audio understanding](https://ai.google.dev/gemini-api/docs/audio) · [Structured output](https://ai.google.dev/gemini-api/docs/structured-output) · [Models](https://ai.google.dev/gemini-api/docs/models) · [Pricing](https://ai.google.dev/gemini-api/docs/pricing)

---

## 1. Feature 1 — Voice interview feedback

The user records a spoken answer (in-browser, capped ~2 min) to an interview/pitch prompt. Audio → one Gemini call → structured feedback.

### 1.1 Model choice
**`gemini-3.5-flash`.**
- Rationale: native audio, structured JSON output, strong transcription accuracy, free tier. Flash (not Flash-Lite) because transcription quality + filler-word detection is the whole product — Lite occasionally skips short phrases (exactly the fillers we care about). If evals (§1.9) show Lite is close enough on filler accuracy, downgrade to `gemini-3.1-flash-lite` to widen quota headroom.
- **One call does everything:** transcript + all analysis in a single request. Do NOT do a separate transcription call then an analysis call — that doubles quota use for no accuracy gain.

### 1.2 Client-side capture (constraints that protect the quota AND cost)
The recorder must:
1. **Hard-cap at 120 s.** Auto-stop at 2:00.
2. **Record mono, low bitrate.** Prefer `audio/ogg;codecs=opus` (or webm/opus) at ~24–32 kbps mono. A 2-min mono Opus clip is ~350–500 KB — far under the 20 MB inline cap, so **we never need the Files API**. (This keeps the request as a single inline base64 part.)
   - If the browser only gives `audio/webm`, transcode is unnecessary — send as-is; Gemini accepts ogg/opus. If a browser produces something not in the supported list, fall back to `audio/wav` (bigger but still << 20 MB for 2 min mono).
3. **Measure exact duration client-side** from the recorder (`MediaRecorder` start/stop timestamps, or decode the blob). Send `durationSeconds` to the server alongside the audio. This is the ground truth for WPM (§1.4).
4. **Reject empty/near-silent clips client-side** (< ~3 s or no detected audio) before spending a request.

### 1.3 Request shape (server-side route handler)
`POST /api/voice/analyze` (server only). Body: base64 audio + mimeType + durationSeconds + the interview prompt the user was answering.

The Gemini request (GenAI SDK, `generateContent`):
- `model: "gemini-3.5-flash"`
- `contents`: `[ { role: "user", parts: [ {inlineData: {mimeType, data: <base64>}}, {text: <USER_PROMPT below>} ] } ]`
- `config`:
  - `systemInstruction: <SYSTEM_PROMPT below>`
  - `responseMimeType: "application/json"`
  - `responseSchema: <VOICE_SCHEMA below>`
  - `temperature: 0.2` (deterministic-ish; this is measurement, not creativity)
  - `thinkingConfig: { thinkingBudget: 0 }` if the SDK/model exposes it — we don't need extended reasoning for this and it burns tokens/latency. (Leave default if the param isn't available on the model.)

### 1.4 WPM computation — the honest approach
**Gemini does NOT compute WPM. The app does.**

- Gemini's audio timestamps are paragraph-grouped and not word-accurate, so any duration it "estimates" is unreliable.
- The **client already knows the exact recording duration** (it owns the recorder). That's ground truth.
- **Server computes:** `wordCount = transcript.trim().split(/\s+/).filter(Boolean).length`; `wpm = round(wordCount / (durationSeconds / 60))`.
- The JSON schema still asks Gemini for `word_count` and its own `filler_words.count`, but the server **recomputes** `word_count` from the transcript and uses the server's number for WPM. Gemini's `word_count` is only a cross-check (if it diverges wildly from the server count, flag low confidence).
- **Filler rate/min** = `filler_words.count / (durationSeconds / 60)`, computed server-side from the durations we trust, not from anything Gemini estimates.

This means: **duration is a required input, never a model output.** Reject the request if `durationSeconds` is missing or ≤ 0.

### 1.5 SYSTEM prompt (stable — put first for future prompt-cache eligibility)
```
You are a blunt, experienced interview and pitch delivery coach. You analyze a single
spoken answer and return a precise, structured assessment. You are not a cheerleader:
your job is to help the speaker actually improve, so be honest and specific. Never
flatter. Never invent content that isn't in the audio.

Rules:
- Transcribe exactly what was said, verbatim, including filler words and false starts.
  Do not clean up, paraphrase, or summarize the transcript.
- Count filler words strictly. Filler words include: um, uh, er, ah, like (as filler,
  not comparison), you know, i mean, so (as a sentence-starter crutch), actually,
  basically, literally, right (as a tic), okay (as a tic), well (as a stall).
  Only count a word as filler when it is used as a verbal crutch, not when it carries
  real meaning. List each filler token and how many times it occurred.
- Do NOT estimate speaking rate, duration, or words-per-minute. That is computed by the
  application from the true recording length. Only report word_count and the transcript.
- clarity_score (0-100): how easy the answer is to follow on first listen. Driven by
  enunciation implied by the transcript, sentence completeness, coherence, and how much
  filler/rambling interrupts the point. 90-100 = crisp and clear; 70-89 = mostly clear
  with minor stumbles; 50-69 = followable but noticeably cluttered; below 50 = hard to
  follow. Do not reward length.
- structure_assessment: a LIGHT judgment only. Does the answer have a recognizable
  beginning (frames the point/situation), middle (the substance/action), and end
  (result or clear close)? Mark each present/absent and give one sentence. This is a
  loose STAR-ish heuristic, NOT a strict rubric. Do not demand perfect STAR.
- coaching: 2 to 3 tips. Each is one short, blunt, actionable sentence tied to something
  concrete in THIS answer (quote or reference it). No generic advice, no praise padding.
- overall_delivery_score (0-100): your single-number verdict on delivery quality for
  trend tracking. Weigh clarity, filler density, and structure. Be consistent run to run.
- Output ONLY valid JSON matching the provided schema. No prose outside the JSON.
```

### 1.6 USER prompt (per request)
```
The speaker was answering this interview/pitch prompt:
"<INTERVIEW_PROMPT>"

The attached audio is their spoken answer. Analyze it per your rules and return the JSON.
```
(`<INTERVIEW_PROMPT>` is the question the user chose to practice, e.g. "Tell me about a time you handled a conflict on your team.")

### 1.7 Response JSON schema (`VOICE_SCHEMA`)
Expressed as JSON Schema (map to Zod/Pydantic at integration). Everything `required`; `additionalProperties: false`.

```jsonc
{
  "type": "object",
  "properties": {
    "transcript": { "type": "string" },
    "word_count": {
      "type": "integer",
      "description": "Model's word count; app recomputes and treats app's as authoritative."
    },
    "filler_words": {
      "type": "object",
      "properties": {
        "count": { "type": "integer" },
        "items": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "word": { "type": "string" },
              "occurrences": { "type": "integer" }
            },
            "required": ["word", "occurrences"]
          }
        }
      },
      "required": ["count", "items"]
    },
    "clarity_score": { "type": "integer", "minimum": 0, "maximum": 100 },
    "structure_assessment": {
      "type": "object",
      "properties": {
        "has_beginning": { "type": "boolean" },
        "has_middle": { "type": "boolean" },
        "has_end": { "type": "boolean" },
        "note": { "type": "string" }
      },
      "required": ["has_beginning", "has_middle", "has_end", "note"]
    },
    "coaching": {
      "type": "array",
      "minItems": 2,
      "maxItems": 3,
      "items": { "type": "string" }
    },
    "overall_delivery_score": { "type": "integer", "minimum": 0, "maximum": 100 }
  },
  "required": [
    "transcript", "word_count", "filler_words",
    "clarity_score", "structure_assessment", "coaching",
    "overall_delivery_score"
  ]
}
```

**Server post-processing (the authoritative numbers the UI/DB store):**
```
serverWordCount = countWords(response.transcript)
wpm             = round(serverWordCount / (durationSeconds / 60))
fillerPerMin    = round1(response.filler_words.count / (durationSeconds / 60))
confidence      = abs(serverWordCount - response.word_count) / serverWordCount < 0.10 ? "high" : "low"
```
Persist: transcript, serverWordCount, wpm, filler count + items + fillerPerMin, clarity_score, structure flags+note, coaching, overall_delivery_score, durationSeconds, confidence, model id, timestamp. WPM and fillerPerMin come from the server math, never from the model.

### 1.8 Rate-limit / retry / graceful degradation
- **429 / RESOURCE_EXHAUSTED (quota):** exponential backoff with jitter, but **cap at 2 retries** (delays ~1 s, ~3 s). Do NOT hammer — retries burn the same quota. If Google returns a `retryDelay` in the error, honor it instead of guessing.
- **On persistent 429 (out of quota for the day):** DO NOT keep retrying. Return a clean error to the UI: "Daily practice limit reached — analysis resumes after midnight Pacific." Store the raw audio blob locally (IndexedDB) so the user can re-submit for analysis tomorrow without re-recording. This is the graceful-degradation path.
- **5xx / transient network:** same capped backoff (2 retries).
- **Parse/validation failure** (model returned non-conforming JSON — rare with responseSchema but possible): **one** retry with `temperature: 0` and an appended instruction "Return ONLY the JSON object, nothing else." If it fails again, surface the transcript alone (if present) plus "scoring unavailable, try re-recording" — never crash, never show a half-parsed blob.
- **Timeout:** 60 s server-side ceiling on the Gemini call.
- Every failure mode is logged with the token counts (from `usageMetadata`) for the quota budget (§3).

### 1.9 Eval approach (do this BEFORE Rai trusts the trend line)
The whole point is trend tracking, so the numbers must be accurate first. Build a tiny, scripted eval set — **do not eval on vibes.**

**Test corpus:** record (or synthesize with TTS for repeatability) **8–12 short clips with KNOWN ground truth**:
1. Read a **scripted 150-word passage at a metronomed pace** so true WPM is known (e.g. 150 words over exactly 60 s = 150 WPM). Make 3 versions: slow (~110), normal (~150), fast (~190).
2. **Filler-injected scripts:** a passage with a *known* number of fillers ("um" ×5, "like" ×3, "you know" ×2). Make 2–3 variants with different filler densities.
3. **Structure variants:** one clip with clear beginning/middle/end; one that's a rambling middle only; one with a strong open but no close.
4. **Edge cases:** near-silence, very fast mumbling, one non-English word mid-sentence, a 5-second ultra-short clip.

**Metrics + acceptance targets:**
- **Transcription:** Word Error Rate (WER) on the scripted passages. Target **WER < 10%** on clear reads. (Compute against the known script.)
- **Filler count accuracy:** absolute error vs known injected count. Target **within ±1** per clip; the *category* (which filler) should match. This is the single most important metric — the filler counter is the headline feature.
- **WPM:** since WPM is app-computed from true duration + transcript word count, the only error source is transcription word-count drift. Target computed WPM **within ±5%** of the metronomed truth on clear reads.
- **Score stability:** run the SAME clip 3× (temperature 0.2). `overall_delivery_score` and `clarity_score` should vary by **≤ 5 points** run-to-run. If they swing more, drop temperature to 0 and/or tighten the rubric wording. Trend tracking is meaningless if the same performance scores differently each time.
- **Structure flags:** manual check that the 3 structure variants get the expected present/absent flags.

**Harness:** a small Node script (`evals/voice_eval.mjs`) that loops the fixture clips through the real `/api/voice/analyze` (or the Gemini call directly), collects JSON, and prints a table: clip | true WPM vs computed | true fillers vs detected | WER | score-run-variance. Store fixtures in `evals/fixtures/` with a `ground_truth.json`. Re-run whenever the model ID or prompt changes. **Gate:** don't ship trend-tracking UI until filler accuracy and score stability pass.

**Known failure modes (documented, handled):**
- "so"/"like"/"actually" as real words vs fillers → prompt instructs meaning-based counting; eval measures residual error; accept small overcount.
- Very fast/mumbled speech → higher WER → note `confidence: low` when model vs server word count diverge >10%.
- Accent/ESL words → Gemini is strong multilingually but may misspell proper nouns; doesn't affect scores materially.
- Background noise → client-side silence/short-clip rejection reduces garbage-in.

---

## 2. Feature 2 — Spot-the-fallacy content generation

Generate brain-game rounds. Each round = one short realistic argument committing exactly ONE fallacy + multiple-choice options + the correct answer + a plain-language explanation. **Content is generated in BATCHES offline and cached in the DB. Gemini is NOT called at play time.**

### 2.1 Model choice
**`gemini-3.5-flash`** for generation quality (the explanations must genuinely teach). Batch generation is infrequent (a cron or manual "top-up" job), so we can afford the better Flash. `temperature: 0.9` for variety across a batch, but with strong schema + dedup guardrails.

### 2.2 Fallacy taxonomy (the answer key + distractor pool)
Cover these 12. Each round's `correct_fallacy` and the 4 options are drawn from this closed set (stored as an enum so the schema constrains it):

1. `strawman` — misrepresenting an opponent's argument to attack it.
2. `ad_hominem` — attacking the person instead of the argument.
3. `false_cause` (post hoc) — assuming A caused B because B followed A.
4. `appeal_to_authority` — "it's true because [authority/celebrity] said so," esp. irrelevant authority.
5. `slippery_slope` — one small step will inevitably lead to extreme consequences.
6. `false_dilemma` (false dichotomy) — presenting only two options when more exist.
7. `hasty_generalization` — broad conclusion from too few/unrepresentative cases.
8. `circular_reasoning` (begging the question) — conclusion assumed in the premise.
9. `appeal_to_emotion` — using fear/pity/flattery in place of a reason.
10. `bandwagon` (appeal to popularity) — "everyone does it, so it's right/true."
11. `red_herring` — irrelevant distraction from the issue.
12. `tu_quoque` (appeal to hypocrisy) — dismissing a claim because the speaker doesn't practice it.

`options` for each round = the `correct_fallacy` + **3 distractors sampled from the taxonomy** (never the correct one twice, always plausible-but-wrong).

### 2.3 Difficulty levels
- `easy` — textbook, on-the-nose example; the fallacy is blatant; distractors are obviously different (e.g. ad hominem vs slippery slope).
- `medium` — realistic everyday framing (workplace, social media, news); fallacy clear on a careful read; distractors include 1 "close cousin."
- `hard` — subtle, persuasive-sounding argument; the wrong-but-tempting distractor is a genuinely adjacent fallacy (e.g. false_cause vs hasty_generalization, or strawman vs red_herring). Still **exactly one** defensible answer.

### 2.4 BATCH generation prompt
Generate **N rounds per call** (recommend **N = 10**) to amortize the request against quota. One call → 10 rounds. A batch job asks for a specific `fallacy` + `difficulty` mix so the library stays balanced.

**SYSTEM prompt (stable):**
```
You are a critical-thinking curriculum designer. You write short, realistic arguments
that each commit EXACTLY ONE logical fallacy, for a "spot the fallacy" game whose goal
is to train genuine reasoning skill — not trivia.

Hard requirements for every item you produce:
- The argument commits EXACTLY ONE fallacy from the allowed taxonomy. It must not
  plausibly be labeled as a different fallacy. If an argument is ambiguous or commits
  two fallacies, do not produce it — rewrite until exactly one clearly applies.
- The argument is realistic and natural — something a real person might say in a
  conversation, meeting, comment section, or news clip. No cartoonish strawmen.
- Exactly 4 options: the one correct fallacy plus 3 distractors, all drawn from the
  taxonomy. Distractors must be plausible enough to require thought but clearly wrong
  on analysis. Never include the correct fallacy twice. Options must be in randomized
  order (the correct one is not always first).
- The explanation teaches: in 2-4 plain sentences, name the fallacy, quote or point to
  the exact move in the argument that commits it, and briefly say why that reasoning is
  invalid. Also, in one sentence, say why each of the tempting distractors does NOT
  apply here. Write for a smart non-expert. No jargon without a plain gloss.
- Match the requested difficulty. easy = blatant. medium = realistic, clear on a careful
  read. hard = subtle and persuasive, with a genuinely adjacent distractor, but still
  exactly one defensible answer.
- Do not reuse scenarios, names, or phrasings across items in the batch. Vary domains
  (work, health, tech, relationships, money, politics-lite, sports, food).
- Output ONLY valid JSON matching the schema.
```

**USER prompt (per batch):**
```
Generate <N> spot-the-fallacy rounds.
Allowed fallacy taxonomy (use these exact keys): strawman, ad_hominem, false_cause,
appeal_to_authority, slippery_slope, false_dilemma, hasty_generalization,
circular_reasoning, appeal_to_emotion, bandwagon, red_herring, tu_quoque.

Distribution for THIS batch:
<e.g. "3 easy, 5 medium, 2 hard; cover at least 8 different fallacies; do not make more
than 2 items share the same correct_fallacy">

Avoid these already-used scenario summaries (do not reproduce or lightly reword them):
<INJECT last ~50 existing one-line scenario_summaries from the DB for de-duplication>
```

### 2.5 Round JSON schema (`FALLACY_BATCH_SCHEMA`)
Batch = array of rounds. Each round:
```jsonc
{
  "type": "object",
  "properties": {
    "rounds": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "argument": { "type": "string", "description": "The realistic argument, 1-4 sentences." },
          "scenario_summary": { "type": "string", "description": "≤10-word tag for de-dup, e.g. 'boss dismisses idea by attacking intern age'." },
          "options": {
            "type": "array",
            "minItems": 4, "maxItems": 4,
            "items": {
              "type": "string",
              "enum": ["strawman","ad_hominem","false_cause","appeal_to_authority",
                       "slippery_slope","false_dilemma","hasty_generalization",
                       "circular_reasoning","appeal_to_emotion","bandwagon",
                       "red_herring","tu_quoque"]
            }
          },
          "correct_fallacy": {
            "type": "string",
            "enum": ["strawman","ad_hominem","false_cause","appeal_to_authority",
                     "slippery_slope","false_dilemma","hasty_generalization",
                     "circular_reasoning","appeal_to_emotion","bandwagon",
                     "red_herring","tu_quoque"]
          },
          "explanation": { "type": "string" },
          "difficulty": { "type": "string", "enum": ["easy","medium","hard"] }
        },
        "required": ["argument","scenario_summary","options","correct_fallacy","explanation","difficulty"]
      }
    }
  },
  "required": ["rounds"]
}
```
Maps to the architect's `fallacy_rounds` table (one row per round; `options` as JSON/text[], `correct_fallacy`, `difficulty`, `explanation`, `argument`, `scenario_summary`, plus `content_hash`, `status`, `created_at`, `served_count`).

### 2.6 Batch-caching strategy (stay off Gemini at play time)
1. **Play time reads only from the DB.** The game selects an unseen `status='approved'` round by difficulty. **Zero Gemini calls during play.** This is the core quota-protection design — a session of 50 rounds costs 0 requests.
2. **Top-up job** (manual button or a cron) runs when `approved` rounds fall below a threshold (e.g. < 20 per difficulty). It calls Gemini in batches of 10.
3. **Budgeting a big library up front:** to seed, say, 300 rounds = 30 batch calls. At ~10 RPM free-tier that's a few minutes of paced calls, or spread across a day — trivially inside 250 RPD. See §3.
4. **Pacing:** the top-up loop sleeps to stay under RPM (e.g. 1 call every ~7 s → <10 RPM). Never fire batches in a tight loop.

### 2.7 De-duplication (two layers)
1. **Prompt-level:** inject the last ~50 existing `scenario_summary` strings into the batch prompt and instruct "do not reproduce or reword these." Cheap, catches most repeats.
2. **Post-generation dedup (authoritative):** for each returned round compute a `content_hash` = normalized hash of `argument` (lowercase, strip punctuation/whitespace) AND a near-dup check via similarity on `scenario_summary` (simple token-Jaccard ≥ 0.8 → reject). Reject rounds whose hash/summary collides with an existing row before insert. Because we generate offline, we can afford to discard dups and just generate more.

### 2.8 Content-quality guardrails (no ambiguous / multi-fallacy items)
Every generated round passes an automated validator BEFORE it becomes `status='approved'`:
- **Schema valid** (enforced by responseSchema; reject on parse fail).
- **`correct_fallacy` ∈ `options`** — must be present exactly once. Reject otherwise.
- **Exactly 4 distinct options**, no duplicates, all from taxonomy. Reject otherwise.
- **Correct answer not always in the same position** across a batch (guards a "always pick A" leak) — shuffle server-side anyway before storing, and store the shuffled index.
- **Explanation length** ≥ ~120 chars and mentions the correct fallacy term — cheap sanity gate against empty/lazy explanations.
- **Optional LLM self-critique pass (recommended for `hard`):** a second cheap call (or same batch call) asks Gemini "For each round, is there EXACTLY ONE defensible fallacy? Reply per-round {id, single_fallacy: bool, why}." Any `single_fallacy: false` → set `status='needs_review'` instead of auto-approving. This is the guard against ambiguous/multi-fallacy items. Since it's offline, the extra call is affordable and keeps play-time content clean.
- Anything failing a guardrail → `status='rejected'` or `'needs_review'`, never served.

### 2.9 Eval for fallacy content
Smaller than the voice eval but still empirical:
- **Human spot-check** the first ~30 generated rounds: is the labeled fallacy actually the one committed? Track a **precision** number (correct-label rate). Target ≥ 90% before trusting auto-approve; below that, tighten the prompt or route more to `needs_review`.
- **Distractor quality:** count rounds where a distractor is *also* arguably correct (the failure we most fear). Target < 5%. The self-critique pass (§2.8) is the automated proxy.
- **Difficulty calibration:** sanity-check that `hard` items are actually harder (self-play or a quick friend test). Not blocking, but informs the difficulty prompt.

---

## 3. Token & quota budgeting (realistic single-user daily use)

Free tier, `gemini-3.5-flash`. Plan conservatively against **10 RPM / 250 RPD**.

### Voice feature per call
- **Input:** 2-min mono audio ≈ 1,920–3,840 tokens + prompts (~500 tokens) ≈ **~4,300 input tokens**.
- **Output:** transcript (~300 words ≈ 400 tokens) + analysis (~300 tokens) ≈ **~700 output tokens**.
- **1 request per analysis.** A heavy practice day = ~20 analyses = **20 requests, ~100K tokens** — far under 250 RPD and under TPM (spread over time). Realistic use (3–5/day) is trivial.

### Fallacy feature
- **Batch of 10 rounds:** input prompt ~1,500 tokens (incl. 50 dedup summaries); output ~2,500 tokens. **1 request → 10 playable rounds.**
- **Seeding 300 rounds** = 30 requests, ~120K tokens total — **one-time**, well under a single day's 250 RPD even alone.
- **Steady state:** top-up maybe 1–3 batches/week. Negligible.
- **Play time: 0 requests.** Cached.

### Combined worst-case day
20 voice analyses + 3 fallacy batches = **23 requests/day**. Ceiling is ~250 RPD. **~9% of the conservative daily quota.** Comfortable. If RPD turns out to be the higher 1,500 figure, headroom is enormous. **Cost: $0** (inside free tier).

### Quota-protection rules (enforced in code)
- Voice: 120 s recording cap + mono/low-bitrate + single call + capped retries (max 2) + client-side short/silent rejection.
- Fallacy: batch-of-10 + DB cache + never call at play time + paced top-up under RPM.
- Both: read `usageMetadata` from every response, log tokens, and keep a simple per-day request counter so the app can show "N of ~250 requests used today" and stop cleanly before hitting a hard 429.

---

## 4. Key decisions (summary)
1. **Model:** `gemini-3.5-flash` for both features (free tier, native audio, JSON-schema output, strong transcription). Confirm the exact ID and live limits in AI Studio at integration time — model IDs drift.
2. **Voice = one call.** Transcript + full structured analysis in a single `generateContent` with `responseSchema`. No separate transcription step.
3. **WPM is app-computed from true client-measured duration**, never trusted from the model (Gemini's audio timestamps are paragraph-level, not word-accurate). Duration is a required *input*.
4. **Structured output enforced** via `responseMimeType: "application/json"` + `responseSchema` on both features; server validates and has a single low-temp retry + graceful degradation on failure.
5. **Fallacy content is batch-generated (10/call) and DB-cached; Gemini is never called at play time.** Dedup (prompt + hash/similarity) and quality guardrails (correct∈options, single-fallacy self-critique, explanation sanity) gate what gets `approved`.
6. **Free tier is respected by design:** ~120 s mono audio cap, single calls, capped retries, batch+cache, paced top-ups. Worst realistic day ≈ 23 requests vs ~250 RPD floor. Cost $0.
7. **Nothing ships on vibes:** voice trends gated on a filler-accuracy + score-stability eval; fallacy auto-approve gated on a labeling-precision spot check.

## 5. Known failure modes → handling (index)
| Failure | Handling |
|---|---|
| 429 / daily quota exhausted | Capped backoff (max 2), honor `retryDelay`; then stop, store audio in IndexedDB, "resumes after midnight Pacific" |
| Non-conforming JSON | 1 retry at temp 0 + "JSON only"; else return transcript alone / "scoring unavailable" |
| Filler mis-count ("so"/"like" as real words) | Meaning-based counting instruction; eval measures residual; accept ±1 |
| Mumbled/fast speech → high WER | `confidence: low` when model vs server word count diverge >10% |
| Audio > 20 MB inline | Impossible by design (2 min mono ≈ <0.5 MB); Files-API fallback documented but unused |
| Ambiguous / multi-fallacy round | Self-critique pass → `needs_review`; never auto-served |
| Duplicate fallacy scenarios | Prompt dedup + post-gen content_hash/similarity reject |
| Model ID / limit drift | Model ID centralized in one server config; re-verify AI Studio + re-run evals on change |
