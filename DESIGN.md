# Talasin — Architecture & Design

Single-user daily "mental gym" PWA. Three pillars in one app:

1. **Spot-the-fallacy game** — multiple-choice fallacy identification, scored.
2. **Voice interview practice** — record a spoken answer, Gemini returns transcript + structured feedback.
3. **Progress dashboard** — streak + trend charts across both pillars.

Status: MVP design. Owner: Rai (only user). Target: `talasin.raigrc.com` on Vercel.

> Talasin = Filipino "sharpen" (talas = sharpness). Fits the mental-gym theme and matches Rai's Filipino-wordplay naming pattern.

---

## 0. Fixed constraints (do not re-litigate)

| Constraint | Decision |
| --- | --- |
| Access control | Single shared passphrase → httpOnly session cookie. No Supabase Auth, no magic links, no multi-user. |
| AI | Google Gemini free tier. All calls server-side only. Keys never in client bundle. Fallacy content **cached in DB in batches** (not one call per round). |
| Audio | **Transcribe-then-discard.** Audio blob is NEVER persisted (not in DB, not in Storage). Only transcript + scores stored. |
| Persistence | Supabase free tier. Stay well inside limits. |
| Prompts/models | Owned by the ai-systems agent (parallel). This doc owns the *app boundary*: how we call Gemini, request/response shapes, caching, error flow. |

## Stack (verified against Rai's other Next 16 apps — `randl`, `projects-board`)

- **Next.js 16.2.9**, **React 19.2.4**, **Tailwind CSS v4**, **TypeScript 5**, **ESLint 9**.
- App Router, `app/` at **project root** (NOT `src/app`).
- `@supabase/ssr` + `@supabase/supabase-js` (server-side only here — see §4).
- `zod` v4 for input validation at every route boundary.
- Dev port **3017** → `"dev": "next dev -p 3017"`, `"start": "next start -p 3017"`.
- Deploy: Vercel, subdomain `talasin.raigrc.com`.

> **Next 16 breaking-change notes for the engineer (verify against `node_modules/next/dist/docs/` before coding):**
> - Middleware is renamed **`proxy.ts`** (root-level, same level as `app/`). `NextResponse.redirect/rewrite` still apply. Use it only for the cheap cookie-presence gate — NOT for session validation logic (proxy is explicitly "not for full auth"; docs `01-app/01-getting-started/16-proxy.md`).
> - `cookies()` and `headers()` are **async** — `const jar = await cookies()`. `.set`/`.delete` only work inside Route Handlers / Server Actions, not during Server Component render.
> - Route Handlers live in `route.ts`; typed dynamic params via `RouteContext<'/path/[id]'>` and `await ctx.params`.
> - `GET` Route Handlers are NOT cached by default (good — our data is per-request). Do not add `dynamic = 'force-static'` to any handler that reads cookies/DB.
> - Server Components are the default; add `"use client"` only to the interactive leaf components (recorder, game controls, charts).

---

## 1. System overview

Single Next.js app on Vercel. Browser is a PWA shell. All secrets (Gemini key, Supabase service-role key, passphrase hash) live in server-only env vars and are read only inside Route Handlers / Server Actions / server modules. The browser never holds any Supabase key or the Gemini key — it talks only to our own API routes.

```
┌────────────────────────────── BROWSER (PWA) ──────────────────────────────┐
│  Server Components (RSC) render pages; Client Components handle interaction  │
│                                                                             │
│  /gate (login)   /  (home/dashboard)   /game   /interview                   │
│    │                   ▲                  │          │                      │
│    │ passphrase POST    │ RSC data        │ fetch    │ fetch (multipart)    │
│    ▼                   │                  ▼          ▼                      │
└────┼───────────────────┼──────────────────┼──────────┼─────────────────────┘
     │                   │                  │          │
     │        httpOnly session cookie "talasin_session" on every request
     │                   │                  │          │
┌────▼───────────────────┼──────────────────┼──────────┼─────────────────────┐
│                    proxy.ts (cheap cookie-presence check → redirect)         │
│                          NEXT.JS SERVER (Vercel)                            │
│                                                                             │
│  Route Handlers (app/api/**/route.ts) + Server Actions                      │
│   ├─ POST /api/auth/login      verify passphrase → set cookie               │
│   ├─ POST /api/auth/logout     clear cookie                                 │
│   ├─ GET  /api/game/next       serve next uncached-to-user fallacy round    │
│   ├─ POST /api/game/answer     record attempt, update streak                │
│   ├─ POST /api/game/topup      (protected) batch-generate fallacy rounds ───┼──┐
│   ├─ POST /api/interview/feedback  multipart audio → Gemini → feedback ─────┼─┐│
│   └─ GET  /api/stats           dashboard aggregates (or read via RSC)       │ ││
│                                                                             │ ││
│  lib/ (server-only):                                                        │ ││
│   ├─ supabase/server.ts   service-role client (SUPABASE_SERVICE_ROLE_KEY)   │ ││
│   ├─ gemini/client.ts     Gemini calls (GEMINI_API_KEY)  ◄──────────────────┼─┘│
│   ├─ session.ts           sign/verify session token, cookie helpers         │  │
│   └─ streak.ts            streak computation                                │  │
└──────────────┬──────────────────────────────────────────────────┬─────────┘  │
               │ service-role (server only)                         │ HTTPS      │
               ▼                                                     ▼            │
      ┌──────────────────┐                                 ┌──────────────────┐  │
      │  SUPABASE (PG)   │                                 │  GEMINI API      │◄─┘
      │  RLS: deny-all   │                                 │  (free tier)     │
      │  to anon/auth;   │   audio→transcript+scores       │  audio + text →  │
      │  server bypasses │   (audio never returned/stored) │  structured JSON │
      └──────────────────┘                                 └──────────────────┘
```

### Route / component map

| Route | Type | Server/Client | Purpose |
| --- | --- | --- | --- |
| `app/gate/page.tsx` | Page | Server shell + small client form | Passphrase entry. Only page reachable unauthenticated. |
| `app/page.tsx` | Page | Server (RSC) | Home/dashboard: streak, charts, quick links. Reads stats server-side. |
| `app/game/page.tsx` | Page | Server shell | Loads first round server-side, then client component drives play. |
| `app/game/GameClient.tsx` | Component | Client | Renders round, handles choice, calls `/api/game/answer`, fetches `/api/game/next`. |
| `app/interview/page.tsx` | Page | Server shell | Loads a prompt, then client recorder. |
| `app/interview/RecorderClient.tsx` | Component | Client | `MediaRecorder`, uploads blob to `/api/interview/feedback`, renders feedback. |
| `app/(dashboard)/charts/*` | Component | Client | Recharts trend/streak visuals (client — needs DOM). |
| `app/api/**/route.ts` | Route Handlers | Server | See §3. |
| `proxy.ts` | Proxy | Server (edge) | Cookie-presence gate + redirect. |
| `lib/**` | Modules | Server-only | Supabase service client, Gemini client, session, streak. |

**Server vs client rule:** everything is a Server Component unless it needs browser APIs or interactivity. Only `GameClient`, `RecorderClient`, the charts, and the gate form are `"use client"`. Secrets are imported only into `lib/` server modules and Route Handlers — never into a `"use client"` file (would leak into the bundle).

---

## 2. Data model (Supabase / Postgres)

Single-user app, so we don't need a `users` table or per-row ownership. We use a constant owner marker only if we ever want multi-device separation later; for MVP it's omitted. **Every table below is written/read exclusively by the server (service-role).** RLS posture in §2.6.

### 2.1 `fallacy_rounds` — cached game content (filled by top-up)

Pre-generated by Gemini in batches. This is the quota-conservation core.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK, default `gen_random_uuid()` | |
| `fallacy_key` | `text` NOT NULL | canonical fallacy slug, e.g. `strawman`, `ad_hominem`. FK-lite ref to `fallacy_types.key`. |
| `argument_text` | `text` NOT NULL | the short argument shown to the user |
| `choices` | `jsonb` NOT NULL | array of `{ key: string, label: string }`, 4 options incl. the correct one |
| `correct_key` | `text` NOT NULL | must equal one `choices[].key` and normally `= fallacy_key` |
| `explanation` | `text` NOT NULL | shown after answering |
| `difficulty` | `smallint` NOT NULL default `1` | 1–3, for optional future filtering |
| `content_hash` | `text` NOT NULL UNIQUE | sha256 of normalized `argument_text` — dedupe guard so top-ups don't insert repeats |
| `gen_batch_id` | `uuid` NULL | groups a top-up batch for auditing |
| `gen_model` | `text` NULL | model id that produced it (from ai-systems) |
| `status` | `text` NOT NULL default `'active'` | `active` \| `retired` (retire bad rounds without deleting attempts) |
| `created_at` | `timestamptz` NOT NULL default `now()` | |

Indexes:
- `unique (content_hash)` — dedupe.
- `index (status)` — serving filter.
- Serving uses a NOT-IN against attempted ids (see §5); with a few hundred rows this is trivial. Add `index on fallacy_rounds (status, created_at)` for ordering.

Validation invariant (enforced in the top-up handler, and optionally a CHECK/trigger): `correct_key` ∈ `choices[].key`, and `choices` has exactly 4 unique keys.

### 2.2 `fallacy_types` — reference list of fallacies (small, seeded)

Lets the UI render option labels/definitions consistently and lets the dashboard group by fallacy.

| Column | Type | Notes |
| --- | --- | --- |
| `key` | `text` PK | e.g. `strawman` |
| `label` | `text` NOT NULL | "Straw Man" |
| `short_def` | `text` NOT NULL | one-line definition for review screens |
| `sort_order` | `smallint` | display order |

Seeded once via SQL migration (~15–25 common fallacies). Not Gemini-generated.

### 2.3 `game_attempts` — one row per answered round

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK default `gen_random_uuid()` | |
| `round_id` | `uuid` NOT NULL FK → `fallacy_rounds.id` | |
| `chosen_key` | `text` NOT NULL | what the user picked |
| `is_correct` | `boolean` NOT NULL | derived server-side at insert |
| `fallacy_key` | `text` NOT NULL | denormalized from round for cheap dashboard grouping |
| `answered_ms` | `integer` NULL | time-to-answer in ms (optional analytics) |
| `local_day` | `date` NOT NULL | user-local calendar day (see §6) — drives streak |
| `created_at` | `timestamptz` NOT NULL default `now()` | |

Indexes: `index (local_day)`, `index (fallacy_key)`, `index (round_id)`.
Uniqueness: **no** unique on `round_id` — Rai may replay a round; serving logic avoids repeats but attempts table stays append-only.

### 2.4 `interview_prompts` — the pitch/interview questions

Seeded (static list) for MVP; can be Gemini-topped-up later with the same pattern as fallacies, but not required for launch.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK default `gen_random_uuid()` | |
| `prompt_text` | `text` NOT NULL | "Tell me about a time you handled a tight deadline." |
| `category` | `text` NULL | `behavioral` \| `pitch` \| `technical` |
| `status` | `text` NOT NULL default `'active'` | |
| `created_at` | `timestamptz` default `now()` | |

Index: `index (status)`.

### 2.5 `interview_attempts` — transcript + scores ONLY (audio discarded)

**Schema-level enforcement of transcribe-then-discard: there is no audio column, no bytea, no storage-path column, no Supabase Storage bucket in this project.** The only artifact of the recording is the transcript text and the numeric scores below.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` PK default `gen_random_uuid()` | |
| `prompt_id` | `uuid` NULL FK → `interview_prompts.id` | null if prompt was ad-hoc |
| `transcript` | `text` NOT NULL | Gemini transcript. This is the ONLY persisted representation of the utterance. |
| `filler_count` | `integer` NOT NULL default `0` | |
| `words_per_minute` | `numeric(5,1)` NULL | |
| `clarity_score` | `smallint` NULL | 0–100 |
| `structure_note` | `text` NULL | short structure assessment (e.g. STAR coverage) |
| `coaching` | `text` NULL | short coaching paragraph |
| `duration_sec` | `numeric(6,1)` NULL | derived client-side from recorder, used for WPM sanity |
| `local_day` | `date` NOT NULL | drives streak |
| `created_at` | `timestamptz` NOT NULL default `now()` | |

Index: `index (local_day)`.
Free-tier note: transcripts are text; even at ~2KB each, thousands of attempts stay far under the 500MB free DB cap.

### 2.6 `daily_activity` — materialized streak helper (optional but recommended)

Streak *can* be computed from the two attempt tables on the fly (§6). To keep the dashboard query trivial and O(days), keep a tiny per-day rollup, upserted whenever an attempt is recorded.

| Column | Type | Notes |
| --- | --- | --- |
| `local_day` | `date` PK | one row per active day |
| `game_count` | `integer` NOT NULL default `0` | |
| `interview_count` | `integer` NOT NULL default `0` | |
| `updated_at` | `timestamptz` NOT NULL default `now()` | |

Upsert on each attempt: `insert ... on conflict (local_day) do update set game_count = daily_activity.game_count + excluded.game_count ...`. Streak = longest trailing run of consecutive `local_day` rows ending today/yesterday.

### 2.7 RLS / access posture (important)

- **Enable RLS on every table** and add **no permissive policies** for the `anon` and `authenticated` roles. Net effect: the public anon key can read/write nothing.
- The app connects **only** with the **service-role key**, server-side, which **bypasses RLS**. The service-role key lives in a Vercel server env var and is imported only into `lib/supabase/server.ts`.
- **We do not ship the anon key to the browser at all.** There is no `NEXT_PUBLIC_SUPABASE_*` in this project. The browser never talks to Supabase directly. This is the single strongest lock-down given the passphrase-gate model — the DB is simply unreachable except through our authenticated server routes.
- Rationale: with one user and a passphrase gate (not Supabase Auth), Supabase's row-level auth model gives us nothing; the real trust boundary is "is this request carrying a valid session cookie," which we enforce in our Route Handlers. RLS deny-all is defense-in-depth so a leaked/attempted anon key is inert.

```sql
alter table fallacy_rounds     enable row level security;
alter table fallacy_types      enable row level security;
alter table game_attempts      enable row level security;
alter table interview_prompts  enable row level security;
alter table interview_attempts enable row level security;
alter table daily_activity     enable row level security;
-- No policies created → anon/authenticated denied. service_role bypasses RLS.
```

---

## 3. API contracts

All handlers are **Route Handlers** (`app/api/**/route.ts`). Every route except `/api/auth/login` requires a valid session cookie (checked via `requireSession()` helper at the top of the handler; §4). All request bodies validated with Zod; on failure return `400 { error }`. All responses are JSON except where noted.

Standard error envelope: `{ "error": string, "code"?: string }` with appropriate HTTP status.

### 3.1 `POST /api/auth/login`
- **Auth:** none (this establishes it).
- **Body:** `{ "passphrase": string }`
- **200:** sets `Set-Cookie: talasin_session=<signed>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=...`, body `{ "ok": true }`.
- **401:** `{ "error": "invalid passphrase" }` (constant-time compare; generic message).
- **429:** after N failed attempts within a window (simple in-memory or KV counter; see §8).

### 3.2 `POST /api/auth/logout`
- **Auth:** session cookie.
- **200:** clears cookie, `{ "ok": true }`.

### 3.3 `GET /api/game/next`
- **Auth:** session.
- **Query:** `?exclude=<comma-separated round ids already seen this session>` (optional; server also excludes rounds attempted today).
- **200:** `{ "round": { "id", "argument_text", "choices": [{key,label}], "difficulty" } }` — **`correct_key` and `explanation` are NOT sent** (prevents client-side cheating). The correct answer is revealed only in the `/answer` response.
- **204 / 200 empty:** `{ "round": null, "reason": "exhausted" }` when the pool of unseen active rounds is empty → UI prompts to run top-up or replays oldest.

### 3.4 `POST /api/game/answer`
- **Auth:** session.
- **Body:** `{ "round_id": uuid, "chosen_key": string, "answered_ms"?: number }`
- **Server:** loads round, computes `is_correct = (chosen_key === correct_key)`, inserts `game_attempts`, upserts `daily_activity`, recomputes streak.
- **200:** `{ "is_correct": boolean, "correct_key": string, "explanation": string, "streak": number }`.
- Idempotency: attempts are append-only; a double-submit creates two rows but does not corrupt streak (streak is day-based). Optional client-side debounce.

### 3.5 `POST /api/game/topup` — fallacy content generation (the quota-saver)
- **Auth:** session **plus** a shared `x-talasin-admin` header equal to `TALASIN_ADMIN_TOKEN` (so a scheduled/manual caller can run it without the interactive session; and it's not accidentally triggerable by normal play).
- **Body:** `{ "count"?: number (default 20, max 50), "difficulty"?: 1|2|3, "fallacy_keys"?: string[] }`
- **Server flow:**
  1. Read existing `content_hash` set (or last N hashes) to pass to Gemini as "avoid these themes" context and to dedupe on insert.
  2. Call `lib/gemini/client.ts` → `generateFallacyRounds(count, opts)` → array of `{ fallacy_key, argument_text, choices, correct_key, explanation, difficulty }` (shape owned by ai-systems agent; we validate it with Zod on return).
  3. Validate each: 4 unique choices, `correct_key ∈ choices`, non-empty text. Drop invalid ones.
  4. Compute `content_hash`; `insert ... on conflict (content_hash) do nothing`.
- **200:** `{ "requested": n, "generated": m, "inserted": k, "skipped_duplicates": d, "batch_id": uuid }`.
- **502:** `{ "error": "gemini_failed", "detail" }` if the AI call errors (see §8 error flow). Partial success is allowed — insert whatever validated.
- **How it's invoked:** manually from the dashboard ("Top up questions" button, visible to Rai), or via a Vercel Cron hitting this endpoint with the admin token on a low cadence (e.g. weekly) to keep the pool ahead of consumption. **This is the only place a Gemini text call happens for the game — never at play time.**

### 3.6 `POST /api/interview/feedback` — audio in → structured feedback out
- **Auth:** session.
- **Content-Type:** `multipart/form-data`.
- **Fields:**
  - `audio`: the recorded blob (`audio/webm;codecs=opus` from MediaRecorder). Size cap enforced server-side (e.g. 8 MB / ~2 min).
  - `prompt_id`: uuid (optional).
  - `duration_sec`: number (from the recorder; used to sanity-check WPM).
- **Server flow:**
  1. Read the blob into memory (Route Handler; `await request.formData()`).
  2. Pass bytes + prompt context to `lib/gemini/client.ts` → `analyzeInterviewAudio(bytes, mime, promptText)` → structured JSON `{ transcript, filler_count, words_per_minute, clarity_score, structure_note, coaching }` (shape owned by ai-systems; validated with Zod).
  3. **Discard the audio** — never write it anywhere. The `Buffer`/`ArrayBuffer` goes out of scope; nothing is streamed to Storage or DB.
  4. Insert `interview_attempts` (transcript + scores only), upsert `daily_activity`, recompute streak.
- **200:** `{ "attempt_id": uuid, "transcript", "filler_count", "words_per_minute", "clarity_score", "structure_note", "coaching", "streak": number }`.
- **413:** if blob exceeds size cap.
- **502:** `{ "error": "gemini_failed" }` — nothing written; client keeps blob in memory only long enough to allow a retry, then drops it.

### 3.7 `GET /api/stats` (or read directly in the dashboard RSC)
- **Auth:** session.
- **200:**
```json
{
  "streak": 7,
  "best_streak": 12,
  "game": {
    "total": 210, "correct": 168, "accuracy": 0.8,
    "trend": [{ "local_day": "2026-06-25", "accuracy": 0.75, "count": 5 }],
    "by_fallacy": [{ "fallacy_key": "strawman", "accuracy": 0.6, "count": 20 }]
  },
  "interview": {
    "total": 30,
    "trend": [{ "local_day": "2026-06-25", "avg_filler_rate": 3.2, "avg_clarity": 78, "avg_wpm": 140 }]
  }
}
```
- Prefer computing this in the dashboard **Server Component** directly via `lib/supabase/server.ts` (no extra network hop). Keep the `/api/stats` handler as the fallback for client-side refresh.

### 3.8 `lib/gemini/client.ts` — the app↔Gemini boundary (this doc owns the shape, ai-systems owns internals)

```ts
// server-only module — reads process.env.GEMINI_API_KEY
export async function generateFallacyRounds(
  count: number,
  opts: { difficulty?: 1 | 2 | 3; fallacyKeys?: string[]; avoidHashes?: string[] }
): Promise<GeneratedRound[]>;   // validated by caller with Zod

export async function analyzeInterviewAudio(
  audio: ArrayBuffer,
  mimeType: string,             // e.g. "audio/webm;codecs=opus"
  promptText: string | null
): Promise<InterviewFeedback>;  // validated by caller with Zod
```
- Both functions request **structured JSON output** from Gemini (response schema / JSON mode) so parsing is deterministic. ai-systems agent supplies the prompt + model id + schema; we wrap it, set a timeout, and Zod-validate the result before it touches the DB.

---

## 4. Passphrase-gate design

**Goal:** one shared passphrase unlocks the whole app; keep the secret server-side; issue an httpOnly cookie; protect all routes; leak nothing to the client bundle.

### Secrets (server-only env vars, set in Vercel + `.env.local`)
- `TALASIN_PASSPHRASE_HASH` — a scrypt (memory-hard KDF) hash of `passphrase + PEPPER`, self-describing format `scrypt$N$r$p$saltB64url$hashB64url`. Never store the plaintext. Generate with `scripts/hash-passphrase.mjs`.
- `TALASIN_SESSION_SECRET` — HMAC key used to sign the session token.
- `TALASIN_ADMIN_TOKEN` — for the top-up endpoint / cron.
- `GEMINI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- **None are prefixed `NEXT_PUBLIC_`**, so none can enter the client bundle. (Next.js only inlines `NEXT_PUBLIC_*` into client code.)

### Flow
1. Unauthenticated request to any protected path → `proxy.ts` sees no valid-looking `talasin_session` cookie → `NextResponse.redirect('/gate')`.
2. `/gate` renders a small client form (passphrase input) → `POST /api/auth/login`.
3. Handler: `await request.json()`, constant-time compare `hash(input) === TALASIN_PASSPHRASE_HASH`.
   - On success: build a signed session token = `base64url(payload).HMAC(payload, TALASIN_SESSION_SECRET)` where payload = `{ iat, exp }` (no PII needed — single user). Set cookie:
     ```
     talasin_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600  // 14 days
     ```
   - On failure: 401, increment a failure counter (rate-limit, §8).
4. Subsequent requests carry the cookie. `proxy.ts` does a **cheap presence + structural check only** (cookie exists, not obviously malformed) — per Next 16 docs, proxy is not for heavy auth. The **authoritative** check is `requireSession()` inside each Route Handler and each protected page's Server Component, which recomputes the HMAC and checks `exp`. Invalid/expired → 401 (API) or `redirect('/gate')` (page).
5. Logout: `POST /api/auth/logout` deletes the cookie.

### `requireSession()` (server helper, `lib/session.ts`)
```ts
// returns void on success, throws/redirects on failure
export async function requireSession(): Promise<void> {
  const jar = await cookies();                 // async in Next 16
  const token = jar.get('talasin_session')?.value;
  if (!token || !verifyHmac(token, process.env.TALASIN_SESSION_SECRET!)) {
    throw new UnauthorizedError();             // handler maps to 401; page catches → redirect('/gate')
  }
}
```

### Why signed cookie, not a DB session table
- One user, low stakes, free-tier frugality: a stateless HMAC-signed cookie needs no DB round-trip and no session table. Trade-off: can't revoke a single token before `exp`; acceptable because rotating `TALASIN_SESSION_SECRET` invalidates all tokens instantly if the passphrase ever leaks. Runner-up: a `sessions` table with opaque tokens — switch to it only if Rai wants remote logout of a lost device.

### Client-leak confirmation
- The passphrase hash, session secret, service-role key, and Gemini key are read only in `lib/*` server modules and Route Handlers. No `"use client"` component imports them. No `NEXT_PUBLIC_*`. The browser only ever sees: the passphrase it types (transient), the httpOnly cookie (unreadable by JS), and JSON responses. Confirmed no secret in the client bundle.

---

## 5. Fallacy-content caching strategy (Gemini free-tier conservation)

**Principle: generation is decoupled from play. Play reads pre-generated rows; Gemini is called only during batch top-ups.**

### Generation (write path)
- `POST /api/game/topup` generates a batch (default 20, max 50) in a **single Gemini call** requesting an array of rounds (not one call per round). One top-up call → 20 playable rounds. At ~5 rounds/day of play, one 20-round call covers ~4 days.
- Dedup guard: `content_hash = sha256(normalize(argument_text))` with a `UNIQUE` constraint; `on conflict do nothing`. We also pass the most recent hashes/themes to Gemini as "avoid repeating" context to reduce near-duplicates.
- Cadence: Vercel Cron weekly (admin token) keeps a buffer; plus a manual "Top up" button on the dashboard for on-demand. This keeps total Gemini text calls to a handful per week — trivially inside free tier.

### Serving (read path — no repeats)
- `GET /api/game/next` selects one `active` round **not attempted today** (and not in the client-supplied `exclude` list for the current session):
  ```sql
  select id, argument_text, choices, difficulty
  from fallacy_rounds fr
  where fr.status = 'active'
    and fr.id not in (
      select round_id from game_attempts
      where local_day = $today            -- don't repeat within a day
    )
    and fr.id <> all($exclude)            -- don't repeat within this play session
  order by random()
  limit 1;
  ```
- Rai is one user with a modest pool (hundreds of rows), so `order by random()` is fine. If the pool later grows large, switch to a shuffled cursor. **Never send `correct_key`/`explanation`** in this response.
- Exhaustion: if no unseen active round exists, return `{ round: null, reason: "exhausted" }`; UI shows "You've cleared today's set — top up for more" (button → `/api/game/topup`) and/or offers replay of least-recently-attempted rounds.

### Quota math (sanity)
- Game: ~1 batch call/week. Interview: 1 Gemini call per practice session (unavoidable — it's the feature), so bound by how often Rai practices, not by app design. Gemini free tier (per-minute + per-day request limits) is comfortably above a single user's realistic daily use. If interview usage ever approaches the daily cap, the `/api/interview/feedback` handler surfaces the rate-limit error (§8) rather than failing silently.

---

## 6. Streak logic spec

**Definition:** the streak is the number of consecutive **local calendar days**, ending today (or yesterday if nothing done yet today), on which Rai completed **≥1 activity of either pillar** (one game answer OR one interview attempt counts).

### Day boundary
- Day = Rai's **local** calendar day. The client sends its local day (`YYYY-MM-DD`, derived from the browser's timezone) with each attempt, OR the server derives it from a fixed configured timezone (`Asia/Manila`) — **choose the fixed-timezone approach** for a single-user app: set `TALASIN_TZ=Asia/Manila` and compute `local_day` server-side. This avoids trusting/juggling client clocks and is correct because there's exactly one user in one place. (Open question if Rai travels across timezones — see §9.)
- `local_day` is stored on every `game_attempts` / `interview_attempts` row and rolled into `daily_activity`.

### Computation
- Using `daily_activity` (has one row per active day):
  1. Let `today = current local day (Asia/Manila)`.
  2. Walk backwards from `today`: if a row exists for `today`, streak starts at 1 and continue to `today-1, today-2, ...` while consecutive rows exist.
  3. If no row for `today` but a row for `today-1` exists, the streak is still "alive" (shown as the count through yesterday) — do not zero it until a day is fully missed.
  4. First gap (a day with no `daily_activity` row) stops the count.
- `best_streak`: max run ever — computed the same way over all rows, cached or recomputed on the dashboard (cheap at this scale).

### Edge cases
- **Multiple activities same day:** still counts as 1 day (streak is day-granular, not activity-count).
- **Timezone/midnight:** an attempt at 23:59 and one at 00:01 land on different `local_day`s → two streak days. Correct.
- **Backfill / clock skew:** because the server assigns `local_day` from `Asia/Manila`, a wrong client clock cannot inflate the streak.
- **Same round replayed:** doesn't matter — day-based.
- **Long gap then return:** streak resets to 1 on the return day.
- **Nothing today yet:** dashboard shows the live streak through the last active day and a subtle "practice today to keep your streak" nudge.

---

## 7. Tech decisions & trade-offs

Each: Decision · Rationale · Trade-off · Alternative.

**Charting — Recharts.**
Decision: use Recharts for the trend/streak charts. Rationale: React 19 compatible, declarative, small enough, no license issues, good for simple line/area charts. Trade-off: heavier than a hand-rolled SVG for 2–3 charts. Alternative: `visx` or raw SVG — switch if bundle size on the dashboard becomes a concern; for an MVP dashboard Recharts is fastest to build. Charts are `"use client"` (need DOM/measuring).

**Audio recording — MediaRecorder API (browser-native).**
Decision: `navigator.mediaDevices.getUserMedia({ audio: true })` → `MediaRecorder` producing `audio/webm;codecs=opus`; collect chunks, assemble a `Blob`, POST as multipart to `/api/interview/feedback`. Rationale: zero dependencies, supported in Chrome/Edge/Android (Rai's targets); opus/webm is compact (good for upload + Gemini). Trade-off: Safari/iOS historically flaky with webm — may need `audio/mp4` fallback (`MediaRecorder.isTypeSupported`). Alternative: a lib like `recordrtc` for broader codec normalization — add only if Rai needs iOS. The blob lives in memory only; on successful response it's dropped; on failure it's kept briefly for one retry then dropped. **Never uploaded to Storage.**

**Data fetching / state.**
Decision: Server Components read Supabase directly via `lib/supabase/server.ts` for initial page data (dashboard, first game round, prompt). Client interactivity (`GameClient`, `RecorderClient`) uses plain `fetch` to Route Handlers + local `useState`. Rationale: minimal deps, matches Next 16 RSC-first model, no client cache needed for a single user. Trade-off: no automatic revalidation/caching layer. Alternative: `@tanstack/react-query` (already in `randl`) — adopt if client-side polling/refresh grows; overkill for MVP.

**Validation — Zod v4** at every Route Handler boundary and on every Gemini response before DB insert. Rationale: Gemini output is untrusted; a bad `choices` array must never reach the DB. Matches `randl`'s stack.

**PWA — manifest + minimal service worker (no library).**
Decision: add `app/manifest.ts` (Next 16 metadata route) for name/icons/`display: standalone`/theme color, and a small hand-written `public/sw.js` registered from a tiny client component. Cache strategy: **network-first for pages, cache-first for static assets/icons; do NOT cache API responses or audio.** Rationale: keeps installability + offline shell without pulling in `next-pwa` (which has lagged on Next 16 support). Trade-off: manual SW maintenance. Alternative: `next-pwa`/`serwist` — reconsider only if the manual SW gets complex. Explicitly: the SW must never cache `/api/interview/feedback` requests/responses (would risk retaining transcripts/audio locally).

**Version-sensitive items to verify against `node_modules/next/dist/docs/` before coding:**
- `proxy.ts` (renamed middleware) — matcher config, redirect API.
- Async `cookies()`/`headers()`; `.set` only in handlers/actions.
- `manifest.ts` metadata route signature.
- `RouteContext<'/api/...'>` typing for any dynamic route (we have none in MVP, but note it).
- Route Handler caching defaults (ours must stay dynamic).

**Styling — Tailwind v4** via `@tailwindcss/postcss` (matches `randl`/`projects-board`). shadcn/ui optional for a couple of primitives (button, card) — keep minimal.

---

## 8. Failure & scaling considerations

**Gemini failures / rate limits.**
- Wrap every Gemini call with a timeout (e.g. 30s for audio) and try/catch. On error, classify: `429`/quota → return app-level `{ error: "gemini_rate_limited" }` (HTTP 429) with a "try again in a bit" UI; other errors → `{ error: "gemini_failed" }` (HTTP 502).
- Top-up: partial success allowed (insert whatever validated); never crash the batch on one bad item.
- Interview: on Gemini failure, **nothing is written** and the client may retry once with the in-memory blob; then it's discarded. No half-written attempt rows.

**Idempotency.**
- `fallacy_rounds` dedup via `content_hash UNIQUE` + `on conflict do nothing` — safe to re-run top-ups.
- Attempts are append-only; day-based streak makes accidental double-submits harmless.

**Login abuse.**
- Rate-limit `/api/auth/login`: simple counter keyed by IP (in-memory per lambda is weak on serverless; use Supabase table `login_attempts` or Vercel KV if Rai wants it robust). For MVP a short exponential backoff + generic 401 is enough given a single legit user and a strong passphrase.

**Validation at the seam.**
- All Gemini output Zod-validated before DB. Malformed `choices`/missing `correct_key` → dropped (top-up) or 502 (interview).

**Observability.**
- Log (server console → Vercel logs): top-up batch results (`generated/inserted/skipped`), Gemini latency + error class, login failures, interview feedback latency. No transcript/audio in logs. Add a lightweight `gen_batch` audit via `gen_batch_id` on rounds.

**Free-tier scaling.**
- Supabase: text-only rows; thousands of attempts + hundreds of rounds ≪ 500MB. No Storage bucket used at all.
- Vercel: a handful of endpoints, no heavy compute except forwarding audio to Gemini (streamed through the lambda, bounded by the 8MB cap and function timeout — set `maxDuration` on the interview route if needed).
- Single user → no concurrency concerns. `order by random()` serving is fine at this scale.

---

## 9. Open questions / risks for the engineer

1. **Gemini response schemas** — exact JSON shape for both `generateFallacyRounds` and `analyzeInterviewAudio` is owned by the ai-systems agent. Align the Zod schemas in `lib/gemini/` with whatever they finalize; this doc's shapes are the app-side contract to match.
2. **Gemini audio format support** — confirm the free-tier model accepts `audio/webm;codecs=opus` directly, and the max audio length/size it will process. Sets the client recording cap. If webm isn't accepted, transcode is out of scope (free tier) → constrain recorder to a supported format.
3. **iOS/Safari MediaRecorder** — if Rai will practice on iPhone, verify codec support and add `audio/mp4` fallback; otherwise scope to Chrome/Android for MVP.
4. **Timezone** — fixed `Asia/Manila` assumed for `local_day`. If Rai travels and practices across timezones, streaks could feel off by a day; revisit only if it happens.
5. **Login rate-limit durability** — decide whether in-memory backoff is acceptable or whether to add a `login_attempts` table / Vercel KV. Recommend deferring unless the app is exposed to bots.
6. **Interview prompt source** — MVP seeds a static `interview_prompts` list. Confirm whether Rai wants Gemini-generated prompts later (same top-up pattern) or a curated list is fine.
7. **Service worker + auth** — ensure the SW never serves a cached authed page to an expired session; network-first for HTML avoids stale gated content. Verify install behavior on `talasin.raigrc.com`.
8. **Top-up trigger** — confirm cadence for the Vercel Cron (weekly proposed) and buffer size, so the pool never empties mid-session.

---

## 10. Build sequence (personal-sprint friendly)

1. **Scaffold** — `next@16.2.9` app at `C:\Users\DELL\Desktop\Rai\talasin`, `app/` at root, Tailwind v4, TS, ESLint 9, port 3017. Copy the `AGENTS.md` "read the docs" note from Rai's other apps. Add env var stubs.
2. **Supabase schema** — run migrations for all tables in §2, enable RLS deny-all, seed `fallacy_types` and `interview_prompts`. Wire `lib/supabase/server.ts` (service-role, server-only).
3. **Passphrase gate** — `lib/session.ts`, `/api/auth/login`, `/api/auth/logout`, `proxy.ts` presence gate, `/gate` page. Verify no secret in client bundle.
4. **Fallacy top-up** — `lib/gemini/client.ts` (stub → real), `/api/game/topup`, dedup + Zod validation. Seed the pool with one batch.
5. **Game play loop** — `/api/game/next`, `/api/game/answer`, `GameClient`, streak update via `daily_activity` + `lib/streak.ts`.
6. **Interview practice** — `RecorderClient` (MediaRecorder), `/api/interview/feedback` (multipart → Gemini → discard audio → store transcript+scores).
7. **Dashboard** — RSC reads stats via `lib/supabase/server.ts`; Recharts trend/streak charts; `/api/stats` fallback.
8. **PWA polish** — `app/manifest.ts`, minimal `public/sw.js` (no API/audio caching), icons, install test on `talasin.raigrc.com`.
9. **Deploy** — Vercel project, env vars (all server-only), `talasin.raigrc.com` domain, weekly top-up Cron.
```
