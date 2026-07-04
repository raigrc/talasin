# Deploying Talasin to Vercel

Target: **`talasin.raigrc.com`** on Vercel (Hobby plan assumed).
Stack: Next.js 16.2.9 (App Router, Turbopack) + Supabase (service-role, RLS deny-all) + Gemini.

This is a single-user PWA. **All secrets are server-side env vars** — none are
`NEXT_PUBLIC_*`, so nothing sensitive reaches the browser bundle. The browser
talks only to this app's own API routes.

> This file is deploy PREP. Do the steps below in order the first time; after
> that, deploys are just `git push` (Vercel auto-builds) or `vercel --prod`.

---

## 0. Blockers to clear first (do these before you deploy)

You cannot get a working prod app until all of these are done. None are hard,
but the app will 500 on first request if the env vars are missing.

1. **Supabase project + schema — HARD precondition; apply BEFORE deploying the
   v1 build.**
   - Create a Supabase project. Note the **Project URL** and the
     **service-role key** (Project Settings → API → `service_role`, NOT `anon`).
   - Open the Supabase SQL editor, paste the full contents of
     [`schema.sql`](./schema.sql), and run it **twice**. It is idempotent by
     design — the second run proves that against the live DB (DESIGN_V1.md §10
     re-run check) and must complete with zero errors. This creates the tables
     with RLS **enabled and deny-all** — the app only ever connects with the
     service-role key, which bypasses RLS server-side.
   - **Why the ordering matters (security):** the v1 login rate limiter is
     backed by the `login_attempts` table and **fails open** on any DB error —
     including `relation "login_attempts" does not exist`. Deploy the v1 build
     against a DB without the v1 schema delta and the login endpoint has **no
     rate limiting at all** (unthrottled scrypt per request). The n-back /
     syllogism games break too: their attempt inserts use v1 columns and the
     `game_attempts_round_uid_key` replay index — without the delta they fail
     closed with 500s (unusable, not replayable).
   - **Verify before deploying** — run this in the SQL editor; every column
     must be **non-NULL**, otherwise STOP and (re)apply `schema.sql`:

     ```sql
     select
       to_regclass('public.login_attempts')              as login_attempts_table,
       to_regclass('public.login_attempts_ip_time_idx')  as limiter_index,
       to_regclass('public.game_attempts_round_uid_key') as replay_guard_index;
     ```

     (psql equivalent: `\d login_attempts` exists and `\d game_attempts` lists
     the `game_attempts_round_uid_key` partial unique index.)
   - This same ordering applies to every FUTURE deploy that ships a schema
     delta: apply `schema.sql` to the live DB first (twice), verify, then
     deploy the code. Code-before-schema is never safe to assume here.
2. **Gemini API key.** Create one at https://aistudio.google.com/apikey
   (Google AI Studio free tier is enough for this app's usage).
3. **Generate the scrypt passphrase hash** (see §2, `TALASIN_PASSPHRASE_HASH`).
4. **Set every env var in Vercel** (§2) — Production (and Preview if you want
   preview deploys to work).
5. **DNS for `talasin.raigrc.com`** (§4) — a CNAME you add at your DNS host.
6. **Seed the fallacy pool** once so the game isn't empty on launch (§6).

---

## 1. Link / create the Vercel project

From the repo root (`talasin/`):

```bash
# one-time: install the CLI if you don't have it
npm i -g vercel

# link this directory to a Vercel project (creates one if it doesn't exist)
vercel link
```

Framework preset, build command, and output are **auto-detected** for Next.js —
do not override them. Confirmed defaults for this app:

| Setting          | Value (leave as default)         |
| ---------------- | -------------------------------- |
| Framework Preset | Next.js                          |
| Build Command    | `next build` (from `package.json`) |
| Output Directory | (Next.js default — leave blank)  |
| Install Command  | `npm install` (default)          |
| Node.js Version  | 22.x or 24.x (default; 24 LTS is fine) |

No custom build settings are needed. `vercel.json` in the repo only configures
the interview function's `maxDuration` and the weekly cron (see §3, §5).

> Note: `dev` uses port 3017 locally, but that is irrelevant on Vercel — Vercel
> runs `next build` + serverless functions, not `next dev`.

---

## 2. Environment variables (set in the Vercel dashboard)

Project → **Settings → Environment Variables**. Add each of these to the
**Production** environment (and **Preview** too if you want preview URLs to run).
All of these are **secrets except `TALASIN_TZ`** — do not paste real values into
git, screenshots, or this file.

| Env var                        | Secret? | What it is / where to get it |
| ------------------------------ | ------- | ---------------------------- |
| `GEMINI_API_KEY`               | **Yes** | Google AI Studio key (https://aistudio.google.com/apikey). |
| `SUPABASE_URL`                 | No\*    | Project URL, e.g. `https://xxxx.supabase.co`. Not secret, but keep together with the rest. |
| `SUPABASE_SERVICE_ROLE_KEY`    | **Yes** | Supabase → Settings → API → `service_role`. **Bypasses RLS. Server-only. Never `NEXT_PUBLIC_*`.** |
| `TALASIN_PASSPHRASE_HASH`      | **Yes** | scrypt hash of your login passphrase (see generation step below). |
| `TALASIN_PASSPHRASE_PEPPER`    | **Yes** | Extra server-only secret mixed into the passphrase before hashing. Must be the SAME value you passed when generating the hash. |
| `TALASIN_SESSION_SECRET`       | **Yes** | HMAC key that signs the session cookie. Long random string. |
| `TALASIN_ADMIN_TOKEN`          | **Yes** | Shared token for `POST /api/game/topup` (`x-talasin-admin` header) and the seed script. Long random string. |
| `TALASIN_TZ`                   | No      | Timezone for streak day-boundary. Defaults to `Asia/Manila` if unset — set it explicitly to be safe. |
| `CRON_SECRET`                  | **Yes** | Only needed once the weekly cron follow-up route exists (see §5). Long random string (≥16 chars). |

\* `SUPABASE_URL` is not sensitive on its own (the anon key it pairs with is never
used here), but treat the whole set as config you don't leak.

### Generate the scrypt passphrase hash

Run locally (Node installed), passing your chosen passphrase and the SAME pepper
you'll set as `TALASIN_PASSPHRASE_PEPPER`:

```bash
node scripts/hash-passphrase.mjs "your-login-passphrase" "your-pepper"
```

It prints a self-describing string `scrypt$N$r$p$salt$hash`. Paste the WHOLE
string as `TALASIN_PASSPHRASE_HASH`. The plaintext passphrase is what you type on
the `/gate` login screen; it is never stored.

### Generate the random secrets

For `TALASIN_SESSION_SECRET`, `TALASIN_ADMIN_TOKEN`, `TALASIN_PASSPHRASE_PEPPER`,
and `CRON_SECRET`, use long random strings:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> **Rotation note:** rotating `TALASIN_SESSION_SECRET` invalidates the current
> login cookie (you'll be bounced to `/gate` and must log in again). Rotating
> `TALASIN_PASSPHRASE_HASH`/`_PEPPER` changes the login passphrase. Redeploy
> after changing any env var — Vercel env changes only take effect on the next
> build/deploy.

---

## 3. `vercel.json` — what it configures and why

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "functions": {
    "app/api/interview/feedback/route.ts": { "maxDuration": 90 }
  },
  "crons": [
    { "path": "/api/cron/topup", "schedule": "0 20 * * 0" }
  ]
}
```

- **`functions.maxDuration: 90`** — the interview route forwards audio to Gemini
  (up to a 60s model call) and needs headroom. The route also declares
  `export const maxDuration = 90` in code; this `vercel.json` entry makes the
  intent explicit and centralised. **90s is well within the Hobby limit** —
  Vercel's default *and* maximum function duration is now **300s on all plans**
  (Fluid Compute). No reduction needed. (See §7.)
- **`crons`** — weekly schedule, `0 20 * * 0` = Sunday 20:00 **UTC** (= Monday
  04:00 Asia/Manila). Vercel cron timezone is always UTC. On the **Hobby plan
  crons run at most once per day**, so a weekly cadence is fine; a more-frequent
  expression would fail the deploy. **This cron will not do anything useful until
  the follow-up route in §5 exists** — see that section before relying on it.

---

## 4. Domain: `talasin.raigrc.com`

1. Vercel → Project → **Settings → Domains → Add** → `talasin.raigrc.com`.
2. Vercel shows a DNS record to create. For a subdomain this is normally a
   **CNAME** `talasin` → `cname.vercel-dns.com` (use the exact target Vercel
   shows). Add it at wherever `raigrc.com`'s DNS is managed (same place as your
   other `*.raigrc.com` apps).
3. Wait for Vercel to verify (usually minutes). TLS is issued automatically.
4. Set this domain to point at the **Production** branch/deployment.

Once the domain is on Production, `talasin.raigrc.com` serves over HTTPS, which
matters for the session cookie (§7).

---

## 5. The weekly top-up cron — auth reality + REQUIRED follow-up

**Read this before assuming the cron works.**

DESIGN.md §3.5 wants a weekly Vercel Cron to call the top-up endpoint so the
fallacy pool stays ahead of play. But the existing endpoint
[`app/api/game/topup/route.ts`](./app/api/game/topup/route.ts) **cannot be called
by a Vercel cron as-is**:

- The route only exports **`POST`**; Vercel cron sends **`GET`**.
- The route calls `requireSession()` first — it requires a valid **session
  cookie**. A cron has no cookie and no way to log in.
- The route then requires the `x-talasin-admin` header. Vercel cron does **not**
  let you set custom request headers; the only auth it sends is
  `Authorization: Bearer $CRON_SECRET` (when `CRON_SECRET` is set on the project).

So a cron pointed straight at `/api/game/topup` would fail on method + auth. The
correct fix is **not** to weaken `/api/game/topup` (it stays session+admin
gated). Instead, add a small dedicated cron route:

**Follow-up (small, ~1 file): create `app/api/cron/topup/route.ts`**

- Export **`GET`** (crons are GET).
- Authenticate with the Vercel cron secret only:
  `authHeader === "Bearer " + process.env.CRON_SECRET` → else `401`.
  Use a constant-time compare (`safeEqual` from `lib/session.ts`).
- Then call the **same generation logic** the POST route uses. Refactor the
  batch-generation body of `app/api/game/topup/route.ts` into a shared helper
  (e.g. `lib/game/topup.ts` → `runTopup({ count })`) and have both routes call
  it. The interactive POST route keeps its session + admin-token gate; the cron
  route uses the `CRON_SECRET` gate. No shared secret is exposed to the browser.
- Set `export const maxDuration` on that route too (a 20-round Gemini batch is
  well under 60s, but give it headroom, e.g. `60`).

Then set `CRON_SECRET` in Vercel env (§2) and keep the `crons` entry in
`vercel.json` pointing at `/api/cron/topup` (already added). On the next
production deploy the cron registers automatically.

> Why not just make `/api/game/topup` accept the admin token without a session?
> That would be a second, weaker auth path on a Gemini-spending endpoint. The
> dedicated cron route keeps each entry point single-purpose and the spend path
> gated by exactly one mechanism. **This is a deliberate small follow-up, not a
> blocker for the first deploy** — the app is fully usable without it; you just
> top up manually (the dashboard "Top up" button, or the seed script) until the
> cron route lands.

**Verify the cron is registered:** after deploying, Vercel → Project →
**Settings → Cron Jobs**. You should see `/api/cron/topup` with schedule
`0 20 * * 0`. Use **View Logs** there to confirm invocations (it will 404 until
the follow-up route exists — that's expected and harmless).

---

## 6. Seed the initial fallacy pool (so the game isn't empty)

The weekly cron only *tops up*; the first batch has to be seeded. Run this
**locally against the production Supabase** (it needs the service-role key and
Gemini key in your local `.env.local`):

```bash
# .env.local must have GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm run seed:fallacy               # ~300 rounds, paced under the free-tier RPM
# or a smaller first batch:
npm run seed:fallacy -- --count 50
```

It's idempotent (dedupes on content hash), so re-running just tops up toward the
target. Alternatively, after deploy, hit the "Top up" button in the dashboard
while logged in.

---

## 7. Production / `NODE_ENV` considerations

- **Session cookie `secure` flag:** `lib/session.ts` sets
  `secure: process.env.NODE_ENV === "production"`. Vercel sets
  `NODE_ENV=production` automatically for production builds, so the cookie will
  be `Secure` in prod (and correctly not-Secure only in local `next dev`). No
  action needed — just make sure the app is served over HTTPS, which the
  `talasin.raigrc.com` domain (§4) provides. Do **not** set `NODE_ENV` yourself.
- **Cookie flags in prod:** `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=14d`
  — correct for a same-origin single-user app.
- **`maxDuration = 90`:** valid on Hobby (default and max are both 300s now). No
  change required. If you ever move heavy work here, note Hobby's ceiling is
  300s (Pro can go to 800s / 1800s beta).
- **Runtime:** the API routes use Node crypto (`scrypt`, `hmac`) and
  `server-only` guards, so they run on the Node.js runtime (default). Do not
  switch them to the Edge runtime.

---

## 8. Deploy

Once §0–§4 are done — **§0.1's schema verification query must have passed
against the production DB first** (deploying v1 code before `schema.sql` is
applied ships a login endpoint with no rate limiting — see §0.1):

```bash
# from talasin/
vercel --prod
```

Or push to the branch Vercel builds from and let it auto-deploy. The first
production deploy also **registers the cron** from `vercel.json`.

---

## 9. Verify the deploy is healthy

Do NOT assume green build == working app. Check, in order:

1. **App loads:** open `https://talasin.raigrc.com` — you should be redirected to
   `/gate` (no session cookie yet). HTTPS padlock present.
2. **Login works:** enter your passphrase at `/gate`. A wrong passphrase returns
   a generic 401; the right one sets the cookie and lets you in. (This exercises
   `TALASIN_PASSPHRASE_HASH` + `_PEPPER` + `TALASIN_SESSION_SECRET` end to end.)
3. **Game serves a round:** open the fallacy game — it should return a round
   (this confirms Supabase connectivity and that the pool was seeded in §6). If
   it says "exhausted", the pool is empty → re-run the seed (§6).
4. **Interview feedback works:** record a short answer and submit. A structured
   result confirms `GEMINI_API_KEY` + the 90s function budget are working.
5. **Cron registered:** Settings → Cron Jobs shows `/api/cron/topup`
   (will 404 until the §5 follow-up route exists — expected).
6. **Logs clean:** Vercel → Logs. No `Missing required environment variable`
   errors, no unhandled 500s. The top-up and interview handlers log structured
   one-liners (batch counts, latency) — no transcripts or audio are logged.
   Specifically there must be **no `[auth] limiter degraded` lines** — that
   warning means the login limiter is failing open (usually: `login_attempts`
   table missing → §0.1 wasn't done).
7. **Login lockout works (deferred v1 manual pass):** at `/gate`, submit a
   wrong passphrase 10 times. The 11th attempt (any passphrase, same IP,
   within 15 min) must return
   `429 { "error": "too many attempts, try again shortly", "code": "rate_limited" }`
   — this proves the durable limiter is live against the real table. Then
   either wait out the 15-minute window or clear your lockout from the SQL
   editor (`delete from login_attempts where success = false;`) and log in.
8. **Replay guard works (deferred v1 manual pass):** play one n-back or
   syllogism round with DevTools → Network open, then right-click the
   `/api/game/answer` POST → "Fetch/XHR → Replay" (or copy-as-fetch and resend
   the identical body). The replay must return
   `409 { "error": "already_scored" }` — this proves the
   `game_attempts_round_uid_key` unique index exists and each signed round
   scores at most once.

---

## 10. Rollback

Vercel keeps every deployment. To roll back:

1. Vercel → Project → **Deployments**.
2. Find the last known-good deployment → **⋯ → Instant Rollback** (promotes it to
   production immediately, no rebuild).

Caveats specific to this app:

- **Cron jobs are NOT reverted by Instant Rollback.** If a bad deploy changed the
  cron, the old cron keeps running until you redeploy or disable it in
  Settings → Cron Jobs.
- **Env var changes are not part of a deployment rollback.** If the incident was
  a bad secret, fix the env var and redeploy — rolling back the code won't undo
  an env change.
- **Schema/data:** rollbacks are code-only. `schema.sql` is additive/idempotent;
  it does not drop data, so a code rollback is safe against the existing DB.

To fully back out a change: Instant Rollback the deployment **and** revert any
`vercel.json`/env changes that shipped with it, then redeploy.

---

## Quick reference — everything Rai must provide

- Supabase project created + `schema.sql` applied (twice) **and the §0.1
  verification query passing — BEFORE the first v1 deploy**.
- Gemini API key.
- Env vars set in Vercel (Production): `GEMINI_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `TALASIN_PASSPHRASE_HASH`,
  `TALASIN_PASSPHRASE_PEPPER`, `TALASIN_SESSION_SECRET`, `TALASIN_ADMIN_TOKEN`,
  `TALASIN_TZ` (+ `CRON_SECRET` once the §5 cron route exists).
- DNS CNAME for `talasin.raigrc.com` → Vercel.
- Initial fallacy pool seeded (`npm run seed:fallacy`).
- Follow-up (non-blocking): add `app/api/cron/topup/route.ts` for the weekly
  cron (§5).
