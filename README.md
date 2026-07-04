# Talasin

Single-user daily "mental gym" PWA. Built to keep Rai's reasoning sharp, get
better at interviews/pitches, and actually track whether either is improving —
in one app instead of three habits. Three pillars:

1. **Brain games** — a game registry with three drills, all scored
   server-side: spot-the-fallacy (multiple choice, spaced repetition on weak
   types), dual n-back (working memory, server-seeded rounds), and syllogism
   sprint (local template bank, zero AI content).
2. **Voice interview practice** — record a spoken answer, Gemini returns a
   transcript + structured delivery feedback. Four prompt categories
   (behavioral / technical explainer / elevator pitch / negotiation),
   STAR-aware scoring for behavioral prompts, attempt history with personal
   bests, and a "vs your last attempt" delta strip.
3. **Progress dashboard** — streak, XP/levels, ~12 achievements, a daily-goal
   ring, weekly this-vs-last insight, and per-game trend charts.

Ops: an `/admin` panel shows the content-pool status and tops up fallacy
rounds (admin token typed per use); the login rate limiter is durable
(DB-backed) across serverless instances.

Next.js 16 (App Router) + Supabase (service-role, RLS deny-all) + Gemini
(free tier, server-side only).

See `DESIGN.md` (MVP architecture, schema, API contracts, streak logic),
`DESIGN_V1.md` (v1 expansion: game registry, interview v2, gamification, ops),
and `AI_DESIGN.md` (Gemini model, prompts, free-tier limits, eval plan) for
the full spec. `AGENTS.md` has the Next 16 breaking-change notes.

> **Status:** MVP (Waves 1–2) plus the v1 expansion (Waves B–C) are built.
> Not yet deployed.

## Stack

- Next.js 16.2.9, React 19.2.4, Tailwind v4, TypeScript 5, ESLint 9.
- `app/` at project root (not `src/app`). Dev/start on **port 3017**.
- Middleware is `proxy.ts` (Next 16 rename). `cookies()` is async.
- `@supabase/supabase-js` (service-role only), `zod` v4, `recharts`,
  `@google/genai` for Gemini.

## Get running locally

Full step-by-step (Supabase project, Gemini key, secrets, seeding) is in
**[`SETUP.md`](./SETUP.md)**. Quick version once everything is configured:

```
npm install
npm run dev        # http://localhost:3017
```

## Tests

```
npm test            # vitest, 355 tests
npm run test:watch
npm run test:coverage
```

## Day-to-day operation / troubleshooting

See **[`RUNBOOK.md`](./RUNBOOK.md)** — topping up game content, what happens
on a Gemini quota hit, the pre-launch eval gate, and common failures (login
rejected, recording errors, Supabase unreachable).

## Deploy

Not done yet — see **`DEPLOY.md`** (Vercel, `talasin.raigrc.com`, env vars,
weekly top-up cron).

## Scripts

- `npm run dev` / `npm run start` — dev/prod server on port 3017
- `npm run build` — production build
- `npm run lint` — ESLint
- `npm run seed:fallacy [-- --count N]` — batch-generate rounds into the DB
- `npm test` / `npm run test:watch` / `npm run test:coverage` — vitest

## Security posture

- Every secret is a **server-only** env var — no `NEXT_PUBLIC_*`. The client
  bundle carries no Gemini/Supabase keys (verified: `grep` of `.next/static`
  finds none).
- Passphrase gate: constant-time compare, HMAC-signed httpOnly/SameSite session
  cookie (`Secure` in production), cheap presence check in `proxy.ts` +
  authoritative `requireSession()` in every handler/page.
- Supabase: the app connects **only** with the service-role key server-side; RLS
  is deny-all so a leaked anon key is inert. The browser never talks to Supabase.
- Audio is **transcribe-then-discard** — no audio column, no Storage bucket. The
  `/api/interview/feedback` handler reads the blob into memory, sends it to Gemini,
  and lets it fall out of scope; only the transcript + scores are persisted. On a
  quota (429) the client stashes the blob in IndexedDB so a retry after the
  Pacific-midnight reset doesn't require re-recording.
