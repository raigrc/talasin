# Talasin — Runbook

Day-to-day operation and troubleshooting. For first-time setup see
`SETUP.md`; for architecture/API details see `DESIGN.md` and `AI_DESIGN.md`.

---

## Topping up fallacy-game content

Play never calls Gemini — it only reads pre-generated rows from
`fallacy_rounds`. When the pool of unseen rounds runs low (the game UI shows
"You've cleared today's set" once you've exhausted today's unseen rounds),
top it up.

**Easiest path: the `/admin` panel** (v1). It shows the pool status (totals by
status/difficulty, unseen-today) and has a top-up form — count, optional
difficulty, optional fallacy-key targeting. You type the admin token into a
password field **per use**; it is held in component state only and never
persisted (no localStorage/cookie), so a stolen session cookie alone still
can't burn Gemini quota. The form POSTs to the same endpoint below.

The equivalent admin-token-gated API call (scripting / curl):

```
curl -X POST https://<your-deployed-host-or-localhost:3017>/api/game/topup \
  -H "Content-Type: application/json" \
  -H "x-talasin-admin: <TALASIN_ADMIN_TOKEN>" \
  -H "Cookie: talasin_session=<your session cookie>" \
  -d "{\"count\": 20}"
```

- Requires **both** a valid session cookie *and* the `x-talasin-admin` header
  matching `TALASIN_ADMIN_TOKEN` — logging in through the browser is not
  enough by itself.
- `count` is optional (default 20, max 50). You can also pass `difficulty`
  (`1`/`2`/`3`) or `fallacy_keys` (array of taxonomy keys) to target specific
  gaps.
- Response: `{ requested, generated, inserted, skipped_duplicates, needs_review, batch_id }`.
  `skipped_duplicates` is normal (dedup on `content_hash`); `needs_review`
  rounds are held back from play pending a manual check (see "Content
  quality" below).
- The same underlying function backs `npm run seed:fallacy` — same pacing,
  same guardrails.

**Cron:** DESIGN.md proposes a weekly Vercel Cron hitting this endpoint with
the admin token so the pool never runs dry between sessions. That cron is
DevOps's responsibility — see `DEPLOY.md` for whether/how it's wired up.

---

## Gemini quota / 429 behavior

Both AI features are on the Gemini **free tier**, budgeted conservatively
against ~10 requests/minute and ~250 requests/day (AI_DESIGN.md §0, §3).
Realistic single-user daily use is far under that ceiling, but if you hit it:

- **Interview feedback:** `POST /api/interview/feedback` returns `429` with
  `{ "error": "gemini_rate_limited" }`. The client automatically stashes your
  recorded audio blob in the browser's IndexedDB (`pendingStore.ts`) so you
  don't have to re-record — retry later from the same device/browser.
- **Content top-up:** `POST /api/game/topup` returns `429` the same way; `npm
  run seed:fallacy` logs a warning and stops cleanly instead of hammering the
  API — just re-run it later, it resumes toward the target.
- **Reset:** Gemini's daily quota resets at **midnight Pacific time**, not
  Manila time. Both error paths already tell you "resumes after midnight
  Pacific."
- **Checking remaining quota:** there's no in-app quota counter. Check
  https://aistudio.google.com/rate-limit / your AI Studio project dashboard
  for live usage against your actual per-project limits (these are
  account-specific and not reliably published elsewhere).
- **Non-quota Gemini failures** (5xx, timeout, malformed JSON after retry)
  surface as `502 { "error": "gemini_failed" }`. These already get a capped
  retry (max 2, exponential backoff) inside `lib/gemini/client.ts` before
  bubbling up — no manual retry loop needed on your end beyond trying again.
- **No API key configured:** any Gemini-backed route returns
  `500 { "error": "no_api_key" }` instead of crashing. If you see this, check
  `GEMINI_API_KEY` is actually set in the running environment (a common local
  gotcha: `.env.local` not picked up because the dev server was started
  before the file existed — restart `npm run dev`).

---

## Before you trust the trend charts

**The `/progress` dashboard is only as good as the numbers feeding it.** Both
AI features have a defined-but-not-yet-built evaluation step
(AI_DESIGN.md §1.9, §2.9) that exists specifically to catch a failure mode
where the model *looks* like it's working but silently produces inconsistent
or wrong scores — which would make the trend lines meaningless (e.g. the same
interview performance scoring 60 one day and 85 the next isn't "improvement,"
it's noise).

**Run this once, before you start relying on trends, and again if you change
the model ID or prompts:**

1. **Voice eval (AI_DESIGN §1.9).** Build a small fixture set of 8–12 known-
   ground-truth clips: scripted passages at known WPM (slow/normal/fast),
   passages with a known injected filler count, and a few structure variants
   (clear beginning/middle/end vs. rambling vs. no close). Run them through
   `analyzeInterviewAudio` and check:
   - Filler-count error within **±1** per clip (the headline metric).
   - Computed WPM within **±5%** of the metronomed truth.
   - Running the *same* clip 3× at the production temperature — scores should
     vary by **≤5 points**. More than that means the scores aren't stable
     enough to trend on; tighten the prompt or drop temperature before
     shipping the dashboard as something you act on.
2. **Content spot-check (AI_DESIGN §2.9).** After the initial
   `npm run seed:fallacy` run, manually read through ~30 generated rounds:
   is the labeled `correct_fallacy` actually the one being committed? Target
   ≥90% precision. Also watch for a distractor that's arguably *also* correct
   — that's the failure mode that makes the game actively teach the wrong
   thing. Anything flagged `needs_review` by the self-critique pass is
   already held out of play; treat a high `needs_review` rate as a signal to
   tighten the generation prompt (`lib/gemini/prompts.ts`).

**Status: this eval harness is not built yet.** AI_DESIGN.md sketches a
`evals/voice_eval.mjs` script and fixture format, but no `evals/` directory
exists in this repo. Recommended follow-up before leaning on the dashboard
for real decisions (e.g. "am I actually getting better at interviews") —
until then, treat trend lines as directional, not authoritative.

---

## Adding game #4

v1 built the game registry (`lib/games/`, DESIGN_V1.md §3) exactly so a new
game is a small, local job — no new routes, no schema change:

1. **Engine:** a new `lib/games/<id>/` folder — a pure engine module plus an
   `index.ts` exporting a `GameDefinition` (`next()` produces a round that
   never contains the answer key; `answer()` verifies/scores server-side and
   inserts the `game_attempts` row with `game_type`, `score` 0–100, `detail`
   jsonb, and `xp`). Stateless rounds use the HMAC token helpers in
   `lib/games/token.ts` (replay-guarded via `detail.round_uid`).
2. **Registry:** one entry in `GAMES` in `lib/games/registry.ts`. The
   polymorphic `/api/game/next?type=` and `/api/game/answer` routes dispatch
   automatically; the `/game` hub grows a card from `listGameMeta()`.
3. **UI:** an `app/game/<id>/` folder — RSC shell + a `"use client"` play
   component, following `app/game/syllogism/` as the template.
4. **Streak/XP:** nothing to do — `answer()` routes already call
   `afterActivity()` (streak + XP totals + achievements) for every game type,
   and `daily_activity.game_count` covers all games in the reasoning pillar.
5. **Stats:** extend `lib/stats.ts`'s `games` block and the trend-selector
   tabs in `app/progress/DashboardCharts.tsx` if the new game needs its own
   trend line.
6. **Content discipline (only if AI-generated):** keep the fallacy pattern —
   batch generation, content-hash dedup, Zod-validate before insert, never
   call Gemini at play time. N-back and syllogism use zero Gemini calls.

---

## Common failures

| Symptom | Likely cause | Fix |
|---|---|---|
| Recording upload returns `400 { "error": "unsupported audio format" }` | Browser's `MediaRecorder` produced a mime type outside the accepted list (`audio/webm`, `ogg`, `mp4`, `mpeg`/`mp3`, `wav`/`x-wav`, `aac`, `flac`, `aiff`) | Usually a Safari/iOS quirk — Safari may not emit an accepted webm/opus variant. Check what mime the recorder actually produced; this is a known gap noted in DESIGN.md §9 (iOS fallback not yet verified). |
| `400 { "error": "recording too short or empty" }` | Clip under 1 KB (near-silent/instant stop) | Not a bug — re-record. Server floor is intentionally low; a near-empty clip isn't worth a Gemini call. |
| `413 { "error": "audio too large" }` | Clip over 12 MB | Recorder should hard-cap at 120s mono/low-bitrate (~0.5MB); if you're hitting this, something's recording at a much higher bitrate/duration than intended — check the recorder config. |
| `400 { "error": "invalid duration" }` | `duration_sec` missing, ≤0, or >130s | Duration is a required client-measured input (AI_DESIGN §1.4 — Gemini's own audio timestamps aren't trusted for WPM). Recorder must send the real measured duration. |
| Login always rejected, passphrase you're sure is right | **Most common: an old `$`-delimited hash mangled by Next's `.env` variable expansion** (the value loads as `scrypt6384` — `$16384`, `$salt`, `$hash` get expanded as if they were env vars). Otherwise: pepper mismatch, or you edited `.env.local` without restarting the dev server. | Regenerate: `node scripts/hash-passphrase.mjs "your-passphrase" "your-pepper"` — it now emits a colon-delimited hash (`scrypt:N:r:p:salt:hash`) that is immune to expansion, and prints ready-to-paste env lines. Make sure the pepper argument matches `TALASIN_PASSPHRASE_PEPPER` exactly, then **restart the dev server**. If you must keep an old `$`-delimited hash, escape every `$` as `\$` in `.env.local`. Cost-param note: params are read from the stored string, so old hashes keep verifying after any script changes. |
| `/progress` shows "Could not load your stats" | Supabase unreachable, or `schema.sql` not applied | Check `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are correct and the project isn't paused (Supabase free projects pause after inactivity — wake it from the dashboard). Re-run `schema.sql` if tables are missing. |
| Logs show `[auth] limiter degraded` / login never returns 429 after 10+ wrong passphrases | `login_attempts` table missing — v1 `schema.sql` was never applied to this DB (the limiter **fails open** on DB errors, so login has NO rate limiting in this state) | Apply `schema.sql` now (DEPLOY.md §0.1: run twice, then the verification query), then re-check: 10 wrong passphrases → 11th attempt returns `429 rate_limited`. |
| N-back / syllogism answers always return `500 { "error": "server_error" }` (fallacy may still work) | v1 `schema.sql` delta missing — attempt inserts use v1 columns (`game_type`/`score`/`detail`/`xp`) and the `game_attempts_round_uid_key` replay index | Same fix: apply `schema.sql` per DEPLOY.md §0.1 and verify with its query. Code deploys must never precede the schema delta. |
| Any Gemini-backed route returns `500 { "error": "no_api_key" }` | `GEMINI_API_KEY` unset in the running process | Set it in `.env.local` (dev) or the deploy environment (prod) and restart the server — env changes aren't picked up by a running `next dev`. |
| `npm run seed:fallacy` stops early with "Rate limited — stopping" | Hit the free-tier RPM/RPD ceiling mid-seed | Expected graceful behavior, not a crash. Re-run the same command later (it's idempotent and resumes toward the target); if it happens immediately, check quota at https://aistudio.google.com/rate-limit. |
| Game shows "You've cleared today's set" quickly | Fallacy pool exhausted for today (each round only shown once per day) or seed didn't reach target | Run a manual top-up (see above) or re-run `npm run seed:fallacy`. |
| XP total / achievements stop moving after heavy long-term use | PostgREST caps unbounded selects at 1000 rows by default — `getXpTotal()`, some achievement predicates, and the full-history stats read silently truncate past ~1000 attempts | Not urgent at launch (~1000 attempts ≈ many months of daily use). When total `game_attempts + interview_attempts` approaches 1000, move XP sums and tallies to a Postgres RPC (`create function ... returns bigint` with `sum(xp)`) or deliberately raise the project's max-rows setting. |

---

## Discrepancies found while writing these docs

- **DESIGN.md §3.5 / §5** describe a "Top up questions" **button visible on
  the dashboard**. ~~No such button exists~~ **Resolved in v1 (Wave C):** the
  `/admin` page now provides the top-up form (token typed per use). It lives
  on `/admin`, not `/progress`, per DESIGN_V1.md §4.7.
- **DESIGN.md §3.6 / AI_DESIGN.md §1.3** disagree on the interview route path
  (`/api/interview/feedback` vs `/api/voice/analyze`). The actual code uses
  `POST /api/interview/feedback` — this is called out directly in a comment
  in `app/api/interview/feedback/route.ts`, so it's a known/accepted drift,
  not something to fix.
- **AI_DESIGN.md §1.9 / §2.9 eval harness is unbuilt.** No `evals/` directory
  exists in the repo yet, despite the design doc sketching
  `evals/voice_eval.mjs` and a fixtures format. Flagged above as a
  recommended follow-up before trusting the dashboard for real decisions.
- **Node engine version isn't pinned** in `package.json` (no `engines`
  field). SETUP.md recommends Node 20+ as a reasonable floor for Next 16 but
  this isn't enforced by the repo itself.
