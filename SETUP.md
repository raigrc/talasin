# Talasin — Local Setup

Follow this in order. Everything here is one-time (or once-per-machine); after
this, `npm run dev` is all you need day to day.

## 0. Prerequisites

- **Node.js** — no version is pinned in `package.json`, but the app targets
  Next.js 16.2.9 / React 19.2.4, so use a current LTS (Node 20+). If `npm
  install` or `npm run dev` complains about engine mismatches, upgrade Node.
- **npm** (ships with Node). No other package manager is set up for this repo.
- A **Google account** (for Google AI Studio) and a **GitHub/email account**
  (for Supabase signup — either works).

## 1. Create the Supabase project

1. Go to https://supabase.com, sign in, **New project**. Pick any name/region
   (free tier). Wait for provisioning (~2 min).
2. Open **SQL Editor** → **New query**, paste the entire contents of
   `schema.sql` from this repo, and run it.
   - It creates all **6 tables** (`fallacy_types`, `fallacy_rounds`,
     `game_attempts`, `interview_prompts`, `interview_attempts`,
     `daily_activity`), enables **RLS deny-all** on each (no policies for
     `anon`/`authenticated` — only the service-role key can read/write), and
     seeds `fallacy_types` (12 fallacies) + `interview_prompts` (12 starter
     prompts).
   - It's **idempotent** — safe to re-run if you're not sure it applied
     cleanly (uses `if not exists` / `on conflict`).
3. Grab your keys: **Project Settings → API**.
   - **Project URL** → this is `SUPABASE_URL`.
   - **service_role key** (NOT the `anon` key) → this is
     `SUPABASE_SERVICE_ROLE_KEY`. This key bypasses RLS — treat it like a root
     password. It only ever lives in `.env.local` / server env vars, never in
     the browser.

## 2. Get a Gemini API key (Google AI Studio, free tier)

1. Go to https://aistudio.google.com/apikey and create an API key. This is
   `GEMINI_API_KEY`.
2. **Before you seed content or go live, re-verify the model and its limits.**
   Model IDs and free-tier quotas drift. The app is currently pinned to
   **`gemini-3.5-flash`**, centralized in one place:
   `lib/gemini/config.ts` → `GEMINI_MODEL`.
   - Check https://aistudio.google.com/rate-limit for the *live* per-project
     RPM/RPD/TPM numbers (AI_DESIGN.md §0 — these vary by account and are not
     reliably published anywhere else).
   - If the model ID has changed or been deprecated, update the single
     constant in `lib/gemini/config.ts` — nothing else needs to change.
   - This is a one-time pre-launch check, not a per-session one, but re-check
     it if Gemini calls start failing with a "model not found" style error.

## 3. Generate secrets

All of these are generated locally — nothing to sign up for.

**Passphrase hash** (scrypt, self-describing format
`scrypt:N:r:p:salt:hash`) — this is what actually gates the app:

```
node scripts/hash-passphrase.mjs "your-passphrase" "your-pepper"
```

- Replace `your-passphrase` with the phrase you'll **type at `/gate`** to log
  in — pick something you can type on a phone.
- Replace `your-pepper` with any long random string — it must **exactly
  match** `TALASIN_PASSPHRASE_PEPPER` below (the pepper is mixed into the
  passphrase before hashing; it's a second secret on top of the per-hash
  salt).
- The command prints ready-to-paste `TALASIN_PASSPHRASE_HASH=` and
  `TALASIN_PASSPHRASE_PEPPER=` lines — copy them into `.env.local` as-is.
- The plaintext passphrase is never stored anywhere; only this hash is.
- **Why colons, not `$`:** Next treats `$X` in `.env` files as variable
  expansion and silently mangles the value. If you ever have an old
  `$`-delimited hash, either regenerate (easiest) or escape every `$` as `\$`.
- Changed `.env.local`? **Restart the dev server** — a running `next dev`
  doesn't pick up env edits.

**Session secret** (HMAC key that signs the login cookie):

```
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```
→ `TALASIN_SESSION_SECRET`

**Admin token** (gates the content top-up endpoint — any long random string
works, reuse the same command):

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```
→ `TALASIN_ADMIN_TOKEN`

## 4. Fill in `.env.local`

Copy `.env.example` to `.env.local`:

```
copy .env.example .env.local
```

Fill in every value. **None of these are prefixed `NEXT_PUBLIC_`** — that's
deliberate, it's what keeps every secret out of the browser bundle. Never
commit `.env.local` (it's already in `.gitignore`).

| Variable | Meaning |
|---|---|
| `GEMINI_API_KEY` | Google AI Studio key (step 2). |
| `SUPABASE_URL` | Your Supabase project URL (step 1). |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key — bypasses RLS, server-only (step 1). |
| `TALASIN_PASSPHRASE_HASH` | scrypt hash of your login passphrase (step 3). |
| `TALASIN_PASSPHRASE_PEPPER` | The pepper string used when generating the hash — must match. |
| `TALASIN_SESSION_SECRET` | HMAC key that signs the session cookie (step 3). |
| `TALASIN_ADMIN_TOKEN` | Shared token required (as `x-talasin-admin` header) to call `POST /api/game/topup` (step 3). |
| `TALASIN_TZ` | Fixed timezone for computing the streak's "local day". Defaults to `Asia/Manila` if unset — leave it unless you're not in Manila. |

## 5. Install and seed content

```
npm install
```

Then seed the fallacy-game question pool:

```
npm run seed:fallacy
```

- This calls **Gemini**, not a static fixture — it uses your `GEMINI_API_KEY`
  quota. Default target is **300 rounds**, generated in batches of **10 per
  call**, so that's **~30 Gemini calls**. The script paces itself at one call
  every ~7 seconds (under the conservative 10 RPM free-tier limit), so a full
  run takes a few minutes.
- It's safe to re-run: it counts existing `active` rounds first and only
  generates enough to reach the target, and dedupes on `content_hash` so
  re-running never doubles up content.
- Custom target: `npm run seed:fallacy -- --count 50`.
- If you hit a 429 mid-run, the script logs a warning and stops cleanly — see
  `RUNBOOK.md` for what to do next.

## 6. Run it

```
npm run dev
```

Open **http://localhost:3017**. You'll land on `/gate` — log in with the
plaintext passphrase you chose in step 3 (not the hash). A successful login
sets an httpOnly session cookie good for 14 days.

## 7. Run the tests

```
npm test
```

This runs the vitest suite (207 tests) against `tests/**/*.test.ts` — covers
session/passphrase logic, streak math, stats aggregation, Gemini
parsing/WPM math, and the API routes. `server-only` is stubbed out for the
test run (see `vitest.config.ts`), so tests don't need a live Next.js server.

Other test commands: `npm run test:watch`, `npm run test:coverage`.

## Next steps

- Day-to-day operation, topping up content later, and troubleshooting →
  **`RUNBOOK.md`**.
- Deploying to Vercel → **`DEPLOY.md`**.
