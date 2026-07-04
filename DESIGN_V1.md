# Talasin v1 — Expansion Design (multi-game, interview v2, gamification, ops)

**Status:** design for two sequential build waves (Wave B, Wave C). MVP is code-complete
(219 vitest tests passing; README's "207" is stale), security-reviewed, not yet deployed.
**This doc extends the built MVP** — everything here was verified against the actual code
(`schema.sql`, `lib/*`, `app/*`), not against DESIGN.md's original sketch.

Ground-truth notes that shaped this design (verified 2026-07-02):

- `game_attempts` has **no** `game_type` column today; it is fallacy-shaped
  (`round_id uuid NOT NULL FK → fallacy_rounds`, `chosen_key/is_correct/fallacy_key NOT NULL`).
- `interview_prompts` **already has** a nullable `category text` column
  (`'behavioral' | 'pitch' | 'technical'`, 12 seeded prompts, no CHECK).
- `interview_attempts` persists `structure_note text` only — the beginning/middle/end
  booleans from the Gemini response are **not** stored today.
- The login rate limiter is an in-memory `Map` inside `app/api/auth/login/route.ts`.
- Top-up is API-only (`POST /api/game/topup`, session + `x-talasin-admin`; `GET /api/cron/topup`,
  `CRON_SECRET` Bearer). There is no dashboard button (RUNBOOK "Discrepancies").
- `recordActivityAndGetStreak(pillar)` takes `"game" | "interview"`; `daily_activity` has
  exactly `game_count` / `interview_count`.
- `analyzeInterviewAudio(audio, mimeType, promptText, durationSeconds)` is one Gemini call;
  WPM/filler-rate are server math; audio is transcribe-then-discard.

Unchanged invariants (do not re-litigate):

- All secrets server-only, **no `NEXT_PUBLIC_*`**, RSC-first, `"use client"` only on
  interactive leaves.
- Server-side answer validation for every game (anti-cheat) — the client never receives
  the answer key before answering.
- **Zero Gemini calls at game play time.** New games use zero Gemini calls, period.
  Interview stays exactly one call per attempt. Transcribe-then-discard stays.
- `schema.sql` is applied by hand, top-to-bottom, repeatedly → every delta below is
  **additive and idempotent** and safe against a DB that already has MVP data.
- **Zero new env vars.** Round tokens reuse `TALASIN_SESSION_SECRET` (domain-separated);
  the admin panel uses the existing `TALASIN_ADMIN_TOKEN` typed per use.

---

## 1. Overview

v1 turns the single fallacy game into a **game registry** with three games (fallacy,
dual n-back, syllogism sprint), upgrades interview practice (4 prompt categories,
STAR-aware scoring for behavioral prompts, attempt history / personal bests / retry),
and adds a light gamification layer (XP + levels, ~12 achievements, spaced repetition
for weak fallacies, a daily goal ring) plus ops polish (admin top-up panel, DB-backed
login limiter). The design principle: **new games are pure TypeScript engines with
server-held ground truth** — n-back rounds are seeded server-side and scored from raw
client responses; syllogism rounds come from a local template bank with deterministic
validity. No new content pipeline, no new cron, no new Gemini usage.

```
                            BROWSER (PWA, session cookie)
   /            /game (hub)      /game/fallacy | /game/nback | /game/syllogism
   home v2      game cards       GameClient      NBackClient    SyllogismClient
   (XP, goal,        │               │  ▲             │  ▲            │  ▲
   achievements)     │               ▼  │             ▼  │            ▼  │
                     │        GET /api/game/next?type=X   POST /api/game/answer
                     │               │                        │ (discriminated body)
   /interview ──► RecorderClient ──► POST /api/interview/feedback (1 Gemini call)
   /interview/history (RSC list)     │
   /progress (trend selector,        ▼
     weekly insight, achievements)  NEXT.JS SERVER
   /admin (top-up panel,     ┌──────────────────────────────────────────────┐
     token typed per use)    │ lib/games/registry.ts  ← the seam            │
                             │   ├─ fallacy   → lib/game.ts (DB rounds,     │
                             │   │              weighted by weak fallacies) │
                             │   ├─ nback     → seeded engine + HMAC round  │
                             │   │              token, score from raw       │
                             │   │              responses server-side       │
                             │   └─ syllogism → template bank + HMAC token, │
                             │                  validity looked up server   │
                             │ lib/progression.ts afterActivity():          │
                             │   streak + XP totals + achievements unlocks  │
                             │ lib/loginLimiter.ts → login_attempts table   │
                             └───────────┬──────────────────────┬───────────┘
                                         ▼                      ▼
                                   SUPABASE (RLS deny-all)   GEMINI (interview +
                                   + achievements,           fallacy top-up ONLY;
                                   + login_attempts          games: zero calls)
```

---

## 2. Data model — schema deltas (all additive + idempotent)

All deltas append to the existing `schema.sql` (same style: `add column if not exists`,
guarded `do $$` constraint adds, `create index if not exists`, idempotent seeds/backfills).
**Wave B lands the entire v1 schema delta in one pass** so `schema.sql` is touched by
exactly one wave.

### 2.1 `game_attempts` — generalize across game types (single-table decision)

One table for all game attempts, not per-game tables. Rationale: XP totals, achievements,
"100 rounds played", daily counts, and the streak all want one append-only activity log;
per-game tables (the RUNBOOK's earlier sketch) would force UNIONs everywhere and a schema
change per new game, defeating the "game #4 is a one-folder job" requirement. Per-game
variance goes into a `detail jsonb` column.

```sql
-- v1: multi-game generalization of game_attempts -----------------------------
alter table game_attempts add column if not exists game_type text not null default 'fallacy';
alter table game_attempts add column if not exists score     smallint;      -- 0..100 normalized
alter table game_attempts add column if not exists detail    jsonb;         -- per-game payload
alter table game_attempts add column if not exists xp        smallint not null default 0;

-- Fallacy-specific columns become nullable for other game types (no-op if already nullable).
alter table game_attempts alter column round_id    drop not null;
alter table game_attempts alter column chosen_key  drop not null;
alter table game_attempts alter column is_correct  drop not null;
alter table game_attempts alter column fallacy_key drop not null;

do $$
begin
  -- Fallacy rows must still carry the full fallacy shape.
  if not exists (select 1 from pg_constraint where conname = 'game_attempts_fallacy_shape_chk') then
    alter table game_attempts add constraint game_attempts_fallacy_shape_chk check (
      game_type <> 'fallacy'
      or (round_id is not null and chosen_key is not null
          and is_correct is not null and fallacy_key is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'game_attempts_score_chk') then
    alter table game_attempts add constraint game_attempts_score_chk
      check (score is null or score between 0 and 100);
  end if;
  -- NOTE: deliberately NO enum CHECK on game_type — adding game #4 must not need
  -- a schema change. The registry is the source of truth for valid types.
end
$$;

create index if not exists game_attempts_type_day_idx on game_attempts (game_type, local_day);

-- Replay guard for stateless (token-served) rounds: each signed round can be
-- scored at most once. Fallacy rows have no round_uid → excluded by the WHERE.
create unique index if not exists game_attempts_round_uid_key
  on game_attempts ((detail->>'round_uid'))
  where (detail->>'round_uid') is not null;

-- Idempotent backfills for pre-v1 rows (no legit row has score NULL / xp 0 post-v1).
update game_attempts
  set score = case when is_correct then 100 else 0 end
  where game_type = 'fallacy' and score is null;

update game_attempts ga
  set xp = 10 + (case when ga.is_correct then 5 else 0 end) + 5 * (fr.difficulty - 1)
  from fallacy_rounds fr
  where fr.id = ga.round_id and ga.game_type = 'fallacy' and ga.xp = 0;
```

Per-game `detail` payloads (documented shape, validated by Zod app-side before insert):

| game_type | detail |
| --- | --- |
| `fallacy` | `null` (unchanged rows) |
| `nback` | `{ round_uid, n, trials, position: {hits, misses, false_alarms}, letter: {hits, misses, false_alarms} }` |
| `syllogism` | `{ round_uid, form_id, terms_hash, valid, phrasing }` |

`score` semantics per type: fallacy = `is_correct ? 100 : 0`; syllogism = same; n-back =
the 0–100 session score (§4.2). All three plot on the existing 0–100 trend axes.

### 2.2 `interview_prompts` — category CHECK + ~24-prompt seed

The column exists; v1 constrains it (existing values all pass) and adds `'negotiation'`.
Existing keys are kept (`pitch` ≙ "Elevator pitch", `technical` ≙ "Technical explainer" —
display labels live in code, no data rewrite).

```sql
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'interview_prompts_category_chk') then
    alter table interview_prompts add constraint interview_prompts_category_chk
      check (category is null or category in ('behavioral','pitch','technical','negotiation'));
  end if;
end
$$;

-- Seed: 12 additional prompts (same idempotent NOT EXISTS pattern as the MVP block).
insert into interview_prompts (prompt_text, category)
select v.prompt_text, v.category
from (values
  -- negotiation (Rai is actively job-hunting; anchor high — see memory feedback)
  ('What are your rate expectations for this role?',                                              'negotiation'),
  ('We like you, but your rate is above our budget. How do you respond?',                         'negotiation'),
  ('A recruiter asks for your current salary. Respond, and steer to the value you bring.',        'negotiation'),
  ('The client offered a rate 30% below your target. Make the case for your number.',             'negotiation'),
  ('Walk me through how you would justify a rate increase to a long-term client.',                'negotiation'),
  ('You have two offers. Tell the preferred company what it would take to close you today.',      'negotiation'),
  -- technical-explainer (automation/AI work, non-technical audiences)
  ('Explain what an AI automation workflow is to a business owner who has never used one.',       'technical'),
  ('Explain to a skeptical executive what an LLM can and cannot reliably do.',                    'technical'),
  ('Describe how you take a manual business process and turn it into an automated workflow.',     'technical'),
  -- behavioral (career-change narrative + production war story)
  ('Why are you leaving your current role, and what are you looking for next?',                   'behavioral'),
  ('Tell me about a time an automation you built failed in production. What did you do?',         'behavioral'),
  -- pitch
  ('You have 60 seconds with a hiring manager: pitch yourself for an AI automation role.',        'pitch')
) as v(prompt_text, category)
where not exists (
  select 1 from interview_prompts ip where ip.prompt_text = v.prompt_text
);
```

Result: 24 active prompts — behavioral 8, technical 6, negotiation 6, pitch 4.

### 2.3 `interview_attempts` — STAR flags + structure score + XP

```sql
alter table interview_attempts add column if not exists star_situation  boolean;
alter table interview_attempts add column if not exists star_task       boolean;
alter table interview_attempts add column if not exists star_action     boolean;
alter table interview_attempts add column if not exists star_result     boolean;
alter table interview_attempts add column if not exists structure_score smallint;  -- 0..100
alter table interview_attempts add column if not exists xp              smallint not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'interview_attempts_structure_chk') then
    alter table interview_attempts add constraint interview_attempts_structure_chk
      check (structure_score is null or structure_score between 0 and 100);
  end if;
end
$$;

-- Backfill: every existing attempt earns the flat interview XP retroactively.
update interview_attempts set xp = 50 where xp = 0;
```

STAR columns stay NULL for non-behavioral and pre-v1 attempts — history/bests treat
NULL as "not assessed", never as zero.

### 2.4 `achievements` — unlock log (new table)

Catalog (names, descriptions, predicates) lives in code (`lib/achievements.ts`); the DB
stores only unlock facts. Single-user → `key` is the PK, no user column.

```sql
create table if not exists achievements (
  key         text primary key,                 -- e.g. 'streak_7' (catalog in lib/achievements.ts)
  unlocked_at timestamptz not null default now(),
  context     jsonb                             -- snapshot of what unlocked it (optional)
);
alter table achievements enable row level security;
-- NOTE (revised 2026-07-03, verified on real Postgres 17): no FORCE. FORCE
-- subjects the table OWNER to RLS, which breaks schema.sql's own seed INSERTs
-- and backfill UPDATEs when the file is run by hand in the Supabase SQL editor.
-- ENABLE with zero policies already denies anon/authenticated; service_role
-- bypasses via BYPASSRLS. Applies to ALL tables in schema.sql.
```

### 2.5 `login_attempts` — durable login limiter (new table, per security review)

```sql
create table if not exists login_attempts (
  id           bigint generated always as identity primary key,
  ip           text        not null,
  success      boolean     not null,
  attempted_at timestamptz not null default now()
);
create index if not exists login_attempts_ip_time_idx on login_attempts (ip, attempted_at);
alter table login_attempts enable row level security;  -- no FORCE (see §2.4 note)
```

Pruning strategy: no cron. `lib/loginLimiter.ts` deletes rows older than 24h
opportunistically — before each limiter check (one cheap `delete ... where attempted_at
< now() - interval '24 hours'`). Single-user volume makes this trivially cheap; the
index covers both the window count and the prune.

### 2.6 `daily_activity` — **no change**

N-back and syllogism increment the existing `game_count` (they are the same "reasoning
game" pillar). Streak semantics are untouched: ≥1 activity of either pillar keeps the
day alive. Per-game "today" counts, where the UI wants them, come from
`game_attempts (game_type, local_day)` via the new index — no new rollup columns.

### 2.7 `lib/supabase/types.ts` deltas

`GameAttempt` gains `game_type: string; score: number | null; detail: Record<string,
unknown> | null; xp: number` (and the four fallacy fields become `| null`).
`InterviewAttempt` gains the five STAR/structure fields + `xp`. New `AchievementRow`,
`LoginAttemptRow`. `InterviewPrompt.category` narrows to the union
`'behavioral' | 'pitch' | 'technical' | 'negotiation' | null`.

---

## 3. Game registry (`lib/games/`)

### 3.1 File structure

```
lib/games/
  registry.ts            GameType, GameMeta, GameDefinition, GAMES map, getGame()
  types.ts               shared round/answer/outcome types + Zod body schemas per game
  token.ts               signRoundToken()/verifyRoundToken() — HMAC, stateless rounds
  fallacy.ts             adapter: delegates to the existing lib/game.ts (untouched logic)
  nback/
    engine.ts            pure: seeded PRNG, sequence generation, scoring, progression
    index.ts             GameDefinition impl (produce round, verify+score+insert)
  syllogism/
    templates.ts         pure data: 24 forms, 60 term triples, 2 phrasings, explanations
    engine.ts            pure: compose round, validity lookup, recent-combo exclusion hash
    index.ts             GameDefinition impl
```

Adding game #4 later = new `lib/games/<id>/` folder + one registry entry + one
`app/game/<id>/` folder. No route changes, no schema changes (open `game_type`,
`detail jsonb`).

### 3.2 The contract

```ts
// lib/games/registry.ts (server-only)
export type GameType = "fallacy" | "nback" | "syllogism";

export interface GameMeta {
  id: GameType;
  name: string;          // "Spot the fallacy" | "Dual N-back" | "Syllogism sprint"
  tagline: string;       // one-liner for the hub card
  href: string;          // "/game/fallacy" etc.
  pillarLabel: string;   // trend-chart label
}

export interface AnswerOutcome {
  reveal: Record<string, unknown>; // per-game reveal payload (merged into the response)
  isCorrect: boolean | null;       // null for non-binary games (n-back)
  score: number;                   // 0..100 normalized (fits existing trend charts)
  xpAwarded: number;
}

export interface GameDefinition extends GameMeta {
  /** Produce the next round. Must NEVER include the answer key / ground truth. */
  next(opts: { exclude: string[] }): Promise<Record<string, unknown> | null>;
  /** Zod schema for this game's answer body (after the game_type discriminator). */
  answerBody: z.ZodTypeAny;
  /** Verify + score server-side, insert the game_attempts row, return the outcome.
   *  Returns null for "round not found / bad or replayed token" (route maps to 404/409). */
  answer(body: unknown): Promise<AnswerOutcome | null>;
}

export const GAMES: Record<GameType, GameDefinition>;
export function getGame(id: string): GameDefinition | null;
export function listGameMeta(): GameMeta[];   // serializable — safe to pass to RSC/hub UI
```

`lib/game.ts` (fallacy DB logic + top-up insert helpers) is **kept as-is** and wrapped by
`lib/games/fallacy.ts`, so `tests/lib/game.test.ts` continues to test the real logic.

### 3.3 Stateless round tokens (`lib/games/token.ts`)

N-back and syllogism rounds are generated per-request — no rounds tables. Ground truth
travels in an HMAC-signed token the client must echo back:

```ts
// payload = { v: 1, g: GameType, uid: string, exp: number, data: object }
// token   = base64url(JSON(payload)) + "." + HMAC_SHA256("round." + payloadB64, TALASIN_SESSION_SECRET)
export function signRoundToken(g: GameType, data: object, ttlSec: number): string;
export function verifyRoundToken(token: string, g: GameType): { uid: string; data: T } | null;
```

- Reuses `TALASIN_SESSION_SECRET` with the `"round."` domain-separation prefix (so a
  round token can never verify as a session token and vice versa). Zero new env vars.
- TTL: 30 min (n-back), 10 min (syllogism). Expired → route returns 410 `round_expired`.
- **Tokens are signed, not encrypted** — the payload is base64-readable by the client.
  Therefore the payload must never contain anything the client shouldn't see *that it
  doesn't already see in the round itself* (n-back: the seed regenerates the same trial
  list the client renders anyway; syllogism: `form_id`/term indices, from which validity
  is only recoverable by reading the app's own source). See anti-cheat stance, §8.
- **Replay guard:** `uid` is stored as `detail.round_uid`; the partial unique index
  (§2.1) makes a second insert fail → route returns 409 `already_scored`.

### 3.4 Game 2 — Dual N-back (`lib/games/nback/`)

Working-memory game. A stream of trials; each trial shows a **position** (3×3 grid cell,
0–8) and a **letter** (spoken via `SpeechSynthesis` and shown as text — "audio-or-letter";
the audio toggle is purely presentational). The user hits "Position match" and/or
"Letter match" whenever the current stimulus equals the one N steps back.

**Round generation (server-seeded, deterministic):**

```ts
// engine.ts — all pure, unit-testable
export interface NBackTrial { pos: number; letter: string }  // letter ∈ C H K L Q R S T
export function generateSequence(seed: number, n: number): NBackTrial[];
export function groundTruth(trials: NBackTrial[], n: number): { posMatch: boolean[]; letterMatch: boolean[] };
export function scoreSession(truth, responses): NBackScore;      // see formula below
export function nextLevel(lastN: number, lastScore: number): number;
```

- Sequence: `n` lead-in trials + **20 scoreable trials**. The generator plants exactly
  **6 position matches, 6 letter matches** (≈2 of them dual) among the scoreable trials,
  rest random-non-matching — guarantees no division-by-zero and comparable difficulty
  across sessions. PRNG: `mulberry32(seedInt)` where `seedInt` = first 4 bytes of
  `sha256(uid)`; the server derives `seedInt` identically at answer time from the token.
- `GET /api/game/next?type=nback`: server picks `n` from progression (below), generates
  the sequence, returns it **plus** the token `{ data: { n } , uid }` (the seed is the
  uid hash — nothing else needed). The client necessarily receives the full trial list
  (it has to render it); see §8 for what that means for cheating.
- Pacing: `trial_ms: 2500` is included in the round payload (single tunable constant in
  `engine.ts`) so server and client agree.

**Scoring (normalized 0–100):** per modality, with `m = 6` planted matches,
`h` = hits (pressed on a match), `f` = false alarms (pressed on a non-match):

```
acc_modality = clamp((h − f) / m, 0, 1)
score        = round(100 × (acc_position + acc_letter) / 2)
```

Simple, monotone, cheat-resistant to "press every trial" (false alarms cancel hits),
and it lives on the same 0–100 axis as every other trend.

**N-level progression:** start at N=2. At round issuance the server reads the most
recent n-back attempt (`game_attempts` where `game_type='nback'`, `order created_at desc
limit 1`) and applies: `score ≥ 80 → n+1 (cap 5)`, `score < 50 → n−1 (floor 2)`, else
same n. One query, no state table.

**Answer flow:** client POSTs the token + raw per-trial booleans (`responses.position[20]`,
`responses.letter[20]`). Server verifies token, regenerates ground truth from the seed,
scores, inserts the attempt (`game_type='nback'`, `score`, `detail` per §2.1, `xp` per §6,
`is_correct=null`, `round_id/chosen_key/fallacy_key=null`), returns score + breakdown +
`next_n`.

### 3.5 Game 3 — Syllogism sprint (`lib/games/syllogism/`)

Quick-fire deductive logic: two premises + a conclusion → "Follows" / "Doesn't follow".
**Template-based local generator. Zero Gemini. Deterministic validity.**

**Template bank (`templates.ts`, pure data):**

```ts
export interface SyllogismForm {
  id: string;                 // 'barbara', 'affirm_consequent', ...
  valid: boolean;
  phrasings: [Phrasing, Phrasing];   // 2 surface renderings per form
  explanation: string;        // 1-2 sentence teach-back, written once per form
}
type Phrasing = { premises: [string, string]; conclusion: string };
// Placeholders {A} {B} {C} substituted from a term triple.

export const FORMS: SyllogismForm[];          // 24 forms: 12 valid, 12 invalid
export const TERM_TRIPLES: [string,string,string][];  // 60 themed triples
```

- **12 valid forms:** Barbara, Celarent, Darii, Ferio, modus ponens, modus tollens,
  hypothetical syllogism, disjunctive syllogism, contraposition, "no A are B / some C
  are A ⊢ some C are not B" (Ferio variant), conversion of E, conversion of I.
- **12 invalid forms:** affirming the consequent, denying the antecedent, undistributed
  middle, illicit major, illicit minor, exclusive premises, affirmative conclusion from
  a negative premise, existential fallacy, illicit conversion of A, illicit conversion
  of O, affirming a disjunct, conclusion swaps "some" for "all".
- **60 term triples** across domains (work/automation, cooking, animals, sports, money,
  plus ~10 deliberately implausible triples — belief-bias resistance: validity must be
  judged on form, not plausibility).
- Each form carries a fixed `explanation` (why it follows / where the move breaks) —
  the game teaches like the fallacy game does, with **zero AI content**.

**Variation math (repeat avoidance):** 24 forms × 60 triples × 2 phrasings =
**2,880 distinct rounds**. At a heavy 15 rounds/day that is >6 months before exhaustion.
Engine additionally excludes exact combos seen recently: one query for the last 300
syllogism attempts' `detail->>'terms_hash'` (hash of `form_id|termIdx|phrasing`), filter
in memory, random pick from the remainder. One query, no cron, no new table.

**Round/answer:** `next()` returns `{ premises: [s1, s2], conclusion, token }` — validity
is **not** in the payload; it's re-derived server-side from `form_id` in the token.
`answer()` verifies the token, computes `is_correct = (answer === 'follows') === form.valid`,
inserts (`game_type='syllogism'`, `score = is_correct ? 100 : 0`, `detail`, `xp`), returns
`{ is_correct, valid, explanation }`. `answered_ms` is recorded for future speed stats;
score stays binary so the trend line is a plain accuracy %. "Sprint" (60-second run of
as many as possible) is purely client presentation — each answer is still one attempt row.

### 3.6 Spaced repetition for fallacies (weak types resurface)

`lib/game.ts # getNextRound` currently picks uniformly at random from unseen active
rounds. v1 makes the pick **weighted by per-fallacy error rate**:

1. One additional query: `game_attempts.select('fallacy_key,is_correct')
   .eq('game_type','fallacy').order('created_at', {ascending:false}).limit(200)` —
   recency-weighted window, cheap.
2. Per-type error rate with Laplace smoothing (types with few attempts drift toward a
   0.3 prior): `err(k) = (wrong_k + 1.5) / (n_k + 5)`.
3. Round weight = `1 + 3 × err(round.fallacy_key)` → a type you always miss is ~4× more
   likely to be drawn than one you always get right. Weighted pick via a pure
   `weightedPick(items, weights, rand)` helper (unit-tested).

Same-day no-repeat and session `exclude` behavior are unchanged. One query added, no
cron, no schema. **Test impact:** `tests/lib/game.test.ts` mocks the Supabase chain —
mocks gain the extra query (called out in §9).

---

## 4. API contracts

### 4.1 `GET /api/game/next?type=<fallacy|nback|syllogism>` (generalized, one route)

One polymorphic route (not per-game routes): the registry makes dispatch one line, and
back-compat is exact — `type` **defaults to `fallacy`** and the fallacy response is
byte-identical to today (`{ round: {id, argument_text, choices, difficulty} }` /
`{ round: null, reason: "exhausted" }`), so existing tests and the existing client keep
working. Unknown `type` → 400 `{ error: "unknown game type" }`.

New shapes:

```jsonc
// type=nback
{ "round": {
    "game_type": "nback", "n": 2, "trial_ms": 2500,
    "trials": [ { "pos": 4, "letter": "K" }, ... ],   // n lead-in + 20 scoreable
    "token": "<signed>"
} }
// type=syllogism
{ "round": {
    "game_type": "syllogism",
    "premises": ["All workflow builders are toolmakers.", "All toolmakers are problem-solvers."],
    "conclusion": "All workflow builders are problem-solvers.",
    "token": "<signed>"
} }
```

### 4.2 `POST /api/game/answer` (generalized, discriminated body)

Body is a Zod discriminated union on optional `game_type` (absent → `'fallacy'`,
preserving today's schema exactly):

```jsonc
// fallacy (unchanged): { "round_id": uuid, "chosen_key": string, "answered_ms"?: n }
// nback:     { "game_type": "nback", "token": string,
//              "responses": { "position": boolean[20], "letter": boolean[20] } }
// syllogism: { "game_type": "syllogism", "token": string,
//              "answer": "follows" | "does_not_follow", "answered_ms"?: n }
```

Responses — existing fallacy fields unchanged, plus **additive** gamification fields on
all three (from `afterActivity()`, §6):

```jsonc
// fallacy: { is_correct, correct_key, explanation, streak,
//            xp_awarded, xp_total, level, new_achievements: [{key,name}] }
// nback:   { score, n, next_n,
//            position: {hits, misses, false_alarms}, letter: {hits, misses, false_alarms},
//            streak, xp_awarded, xp_total, level, new_achievements }
// syllogism: { is_correct, valid, explanation, streak,
//              xp_awarded, xp_total, level, new_achievements }
```

Errors: 400 invalid body/unknown type · 404 round not found (fallacy) · 410
`round_expired` (bad/expired token) · 409 `already_scored` (round_uid replay).

### 4.3 `POST /api/interview/feedback` — v2 (still exactly one Gemini call)

Request unchanged (multipart `audio`, `duration_sec`, `prompt_id`). Server now:

1. Looks up the prompt's `category`; passes it to `analyzeInterviewAudio(...)`
   (new 5th param `category: PromptCategory | null`).
2. `category === 'behavioral'` → the call uses the **STAR variant** schema/prompt;
   otherwise the existing light beginning/middle/end heuristic — a pitch is never
   STAR-scored. One call either way; we always know which schema we requested, so we
   Zod-parse with that exact variant (no union guessing).
3. Fetches the **previous comparable attempt** for the delta strip: most recent prior
   attempt on the *same prompt*; if none, most recent prior in the *same category*;
   else `null`.

Response — all existing fields unchanged, plus additive:

```jsonc
{
  // ...existing fields...,
  "star": { "situation": true, "task": true, "action": true, "result": false } | null,
  "structure_score": 78 | null,          // null for non-behavioral
  "previous": {                           // null on first comparable attempt
    "attempt_id": "...", "created_at": "...",
    "overall_delivery_score": 71, "clarity_score": 74,
    "filler_per_min": 3.2, "words_per_minute": 141
  } | null,
  "xp_awarded": 50, "xp_total": 4310, "level": 6, "new_achievements": []
}
```

### 4.4 Gemini schema delta (`lib/gemini/schemas.ts`, `prompts.ts`, `client.ts`)

Add a STAR variant alongside the existing voice schema (existing exports untouched):

```ts
// schemas.ts — NEW (additive)
export const voiceStarModelSchema = voiceModelSchema
  .omit({ structure_assessment: true })
  .extend({
    structure_assessment: z.object({
      has_situation: z.boolean(),
      has_task:      z.boolean(),
      has_action:    z.boolean(),
      has_result:    z.boolean(),
      structure_score: z.number().int().min(0).max(100),
      note: z.string(),
    }),
  });
export const VOICE_STAR_RESPONSE_SCHEMA = { /* mirrored Type.* responseSchema */ };
```

`prompts.ts`: `VOICE_SYSTEM_PROMPT` stays; a new `VOICE_STAR_RUBRIC` block is appended
for behavioral calls — replaces the "light beginning/middle/end" instruction with: mark
each of Situation/Task/Action/Result present only if genuinely articulated (Situation =
concrete context; Task = the speaker's specific responsibility; Action = what *they*
did, first person; Result = a concrete outcome, ideally quantified); `structure_score`
weighs presence + ordering + proportion (Action should dominate; a missing Result caps
the score at 70).

`client.ts`: `analyzeInterviewAudio` gains `category` and maps the STAR variant into
`InterviewFeedback` (additive fields `star: {…} | null`, `structure_score: number | null`;
for the light variant it fills them with `null` — `structure`/`structure_note` keep
working exactly as today). `insertInterviewAttempt` writes the five new columns + `xp`.

### 4.5 Interview history + personal bests (RSC-first, no new API route)

`lib/interview.ts` additions:

```ts
export interface AttemptListItem {
  id: string; created_at: string; local_day: string;
  prompt_text: string | null; category: string | null;
  overall_delivery_score: number | null; clarity_score: number | null;
  filler_count: number; duration_sec: number | null;     // filler/min derived in UI
  words_per_minute: number | null; structure_score: number | null;
  star: { situation: boolean; task: boolean; action: boolean; result: boolean } | null;
  transcript: string;
}
export function listAttempts(opts: { page: number; pageSize?: number; category?: string })
  : Promise<{ items: AttemptListItem[]; total: number }>;      // range() pagination + prompt join

export interface PersonalBests {
  best_delivery: { value: number; attempt_id: string; local_day: string } | null;
  best_clarity:  { ... } | null;
  best_filler_per_min: { ... } | null;   // MIN, only attempts with duration_sec >= 30
  best_structure_score: { ... } | null;  // behavioral only
}
export function getPersonalBests(): Promise<PersonalBests>;
export function getPreviousComparableAttempt(promptId: string | null, category: string | null)
  : Promise<PreviousAttempt | null>;     // same-prompt → same-category → null
```

Pages: `app/interview/history/page.tsx` (RSC; `?page=N&category=` searchParams;
personal-bests card up top; rows expandable via a tiny `TranscriptToggle` client
component or plain `<details>`). Each row has "Retry this prompt" → `/interview?prompt=<id>`.

**Retry same prompt:** `app/interview/page.tsx` reads `searchParams.prompt` and, when
valid, passes `initialPromptId` to `RecorderClient` (that prompt goes first instead of
the shuffle). The feedback screen gains a "Retry this prompt" button — client-only:
resets the recorder *without* rotating the prompt.

Category UX: chips on `/interview` (`All · Behavioral · Technical explainer · Elevator
pitch · Negotiation`) filtering the already-loaded prompt list client-side (24 rows —
no refetch). Display-label map lives in a shared `lib/interviewCategories.ts` (plain
constants, importable by client components).

### 4.6 Auth — durable login limiter (contract unchanged)

`POST /api/auth/login` keeps its exact request/response contract (400/401/429/500 +
cookie on 200). Internals move to `lib/loginLimiter.ts`:

```ts
export const LOGIN_WINDOW_MIN = 15;
export const LOGIN_MAX_FAILS  = 10;
export function checkLoginAllowed(ip: string): Promise<boolean>;  // prune + count window fails
export function recordLoginAttempt(ip: string, success: boolean): Promise<void>;
```

Flow per request: prune old rows → count failures for `ip` in the window → ≥ max → 429
before touching scrypt (cheap DoS shield for the KDF) → verify → insert attempt row.
**Fail-open:** if Supabase is unreachable the limiter logs and allows the attempt to
proceed to scrypt verification (availability for the single legit user; the passphrase
is the real gate). Stated trade-off in §7.

### 4.7 Admin top-up panel

- `app/admin/page.tsx` (RSC, `requireSession()` like every page; linked from Nav's
  overflow or footer, not a main tab). Server-renders **pool status** via a new
  `lib/game.ts # getPoolStatus()` — counts of `fallacy_rounds` by `status` and
  `difficulty`, plus how many active rounds remain unseen today.
- `app/admin/TopupPanel.tsx` (client): count (1–50), optional difficulty, optional
  fallacy-key multi-select, and a **password-type field for the admin token** —
  held in component state only, **never persisted** (no localStorage, no cookie, no
  sessionStorage), POSTed as the `x-talasin-admin` header to the **existing**
  `/api/game/topup` (route unchanged). Renders the
  `{requested, generated, inserted, skipped_duplicates, needs_review, batch_id}` summary.
- Trade-off (stated): typing the token per use preserves its "second factor" property —
  a stolen session cookie alone still can't burn Gemini quota. Persisting it client-side
  (XSS-stealable) or server-side behind the session (collapses two factors into one)
  were both rejected. Cost: ~10 keystrokes per top-up, a few times a month.

### 4.8 `GET /api/stats` — extended `Stats` (additive)

`lib/stats.ts # getStats()` keeps every existing field and adds:

```jsonc
{
  // existing: streak, best_streak, game{total,correct,accuracy,trend,by_fallacy}, interview{...}
  "games": {
    "nback":     { "total": 14, "current_n": 3,
                   "trend": [ { "local_day": "...", "avg_score": 62, "max_n": 3, "count": 2 } ] },
    "syllogism": { "total": 120,
                   "trend": [ { "local_day": "...", "accuracy": 0.85, "count": 12 } ] }
  },
  "xp": { "total": 4310, "level": 6, "into_level": 810, "for_next": 1300 },
  "weekly": {          // rolling last-7-local-days vs the 7 before that
    "this":  { "activities": 34, "avg_delivery": 78, "avg_filler_per_min": 2.1, "game_accuracy": 0.81 },
    "last":  { "activities": 21, "avg_delivery": 74, "avg_filler_per_min": 2.9, "game_accuracy": 0.77 }
  },
  "achievements": [ { "key": "streak_7", "name": "One week sharp", "unlocked_at": "..." } ],
  "daily_goal": { "game_done": true, "interview_done": false }
}
```

**Behavior fix required by multi-game (called out per constraints):** the two existing
game queries in `getStats()` (`game_attempts` full read; recent-30 trend) must add
`.eq("game_type", "fallacy")` — otherwise n-back/syllogism rows would pollute "Game
accuracy" and "Accuracy by fallacy". This is the one Wave B edit to `lib/stats.ts`
(2 lines); the full extension above is Wave C. Rolling-7-day windows (not ISO weeks)
were chosen to avoid week-boundary edge cases; computed in TS from `local_day`.

---

## 5. Gamification

### 5.1 XP + levels (`lib/xp.ts`)

**Decision: XP is computed at write time and stored on the attempt row** (`xp smallint`
on both attempt tables), with a one-time idempotent backfill for pre-v1 rows (§2.1,
§2.3). Total = sum of the `xp` columns.

- Why not read-time derivation: fallacy XP depends on round difficulty, which lives on
  `fallacy_rounds` — pure read-time XP would put a join in every dashboard read forever.
- Why not a separate ledger table: a ledger can drift from the attempts it mirrors and
  needs its own idempotency keys; a column on the source-of-truth row cannot drift.
- Trade-off: changing XP rules later applies to new rows only. Acceptable — XP is
  motivation, not accounting.
- Totals are summed in TS from `select('xp')` reads (consistent with existing
  full-table-read patterns in `stats.ts`; switch to a SQL RPC if rows ever exceed ~20k).

Amounts (constants in `lib/xp.ts`, one place):

| Activity | XP |
| --- | --- |
| Fallacy round | `10 + (correct ? 5 : 0) + 5 × (difficulty − 1)` → 10–25 (difficulty is CHECK-capped at 3) |
| Syllogism round | `5 + (correct ? 5 : 0)` → 5–10 (quick-fire, ~10 s each) |
| N-back session | `25 + 10 × (n − 2) + scoreBonus` (score ≥ 80 → +15, ≥ 60 → +10, ≥ 40 → +5) → 25–70 |
| Interview attempt | flat `50` (highest-friction activity) |

Level curve — one pure function, quadratic thresholds (fast early levels, slowing later):

```
threshold(L) = 100 × (L − 1)²          // L2=100, L3=400, L5=1600, L10=8100
level(totalXp) = floor(sqrt(totalXp / 100)) + 1
```

At a realistic ~250 XP/day: level 5 in ~1 week, level 10 in ~1 month. `levelFromXp()`
returns `{ level, into_level, for_next }` for the progress bar.

### 5.2 Achievements (`lib/achievements.ts` + `achievements` table)

Catalog in code; unlocks in DB. Twelve, tied to Rai's actual goals:

| key | name | predicate (server-checked) |
| --- | --- | --- |
| `first_interview` | First rep | ≥1 interview attempt |
| `streak_7` | One week sharp | current streak ≥ 7 |
| `streak_30` | Habit formed | current streak ≥ 30 |
| `filler_under_2` | Filler tamed | an attempt with `duration_sec ≥ 60` and filler/min < 2.0 |
| `delivery_90` | Broadcast ready | `overall_delivery_score ≥ 90` |
| `star_complete` | Full STAR | behavioral attempt with all four STAR flags true |
| `all_categories` | Range | ≥1 attempt in each of the 4 prompt categories |
| `fallacy_dozen` | Fallacy master | all 12 fallacy types: ≥5 attempts AND ≥80% accuracy each |
| `nback_3` | Working memory 3 | complete an N=3 session with score ≥ 60 |
| `rounds_100` | Century | 100 total game attempts (any type) |
| `syllogism_20` | Logic sprinter | 20 correct syllogisms in one `local_day` |
| `level_5` | Leveled up | reach level 5 |

**Evaluation strategy:** server-side, inside `afterActivity()` (§5.4), immediately after
each recorded activity. A static trigger map limits work per activity (interview attempt
→ check the 5 interview keys + streak/level keys; fallacy answer → `fallacy_dozen`,
`rounds_100`, streak/level; etc.). Already-unlocked keys (one `select key from
achievements`) are skipped; each remaining predicate costs ≤1 query. Unlocks insert with
`on conflict (key) do nothing` — idempotent under double-submits.

### 5.3 Daily goal

Target (constants in `lib/progression.ts`): **≥1 game round AND ≥1 interview attempt
per local day** — one activity per pillar, matching the streak's spirit but stricter.
Data source: today's `daily_activity` row (`game_count ≥ 1`, `interview_count ≥ 1`) —
**zero new schema**. Rendered on home as a two-segment ring (pure inline SVG in the
RSC — no client component needed) + a two-item checklist linking to `/game` and
`/interview`. No dark patterns: a missed goal shows a neutral empty ring, no guilt copy,
no notifications.

### 5.4 `lib/progression.ts # afterActivity()` — the single post-activity hook

```ts
export interface ActivityResult {
  streak: number;
  xpAwarded: number; xpTotal: number; level: number;
  newAchievements: { key: string; name: string }[];
}
export function afterActivity(ctx: {
  pillar: "game" | "interview";
  gameType?: GameType;
  xpAwarded: number;                  // already written on the attempt row
  attemptFacts: Record<string, unknown>; // what predicates need (scores, flags, category…)
}): Promise<ActivityResult>;
```

Internally: `recordActivityAndGetStreak(pillar)` (existing, unchanged) → XP totals
(two `select('xp')` sums) → achievement evaluation (Wave B ships this returning
`newAchievements: []`; Wave C fills it in — so routes are written once, in one wave,
and never touched again). All answer/feedback routes call this instead of calling
`recordActivityAndGetStreak` directly.

---

## 6. UI / page structure

```
app/
  page.tsx                     home v2: level/XP bar, daily-goal ring, achievements strip,
                               game+interview cards (all RSC; ring is inline SVG)
  game/
    page.tsx                   NEW: game hub — cards from listGameMeta() (RSC)
    fallacy/page.tsx           MOVED from app/game/page.tsx (content unchanged)
    fallacy/GameClient.tsx     MOVED from app/game/GameClient.tsx (fetches now pass type)
    nback/page.tsx             RSC shell: requireSession, fetch first round server-side
    nback/NBackClient.tsx      client: renders trials on a timer, SpeechSynthesis letters,
                               two match buttons, POSTs responses+token
    syllogism/page.tsx         RSC shell
    syllogism/SyllogismClient.tsx  client: premise card, Follows / Doesn't follow,
                               sprint timer (presentational), reveal + explanation
  interview/
    page.tsx                   + category chips, ?prompt= / ?category= searchParams
    RecorderClient.tsx         + initialPromptId, "Retry this prompt", delta strip data
    FeedbackView.tsx           + STAR flags row (behavioral), structure score, delta strip
    history/page.tsx           NEW: RSC list + personal bests + pagination
    history/TranscriptToggle.tsx  NEW: tiny client expand/collapse
  progress/
    page.tsx                   + weekly insight card, achievements strip, XP header
    DashboardCharts.tsx        + per-game-type trend selector (tabs: Fallacy / N-back /
                               Syllogism), reusing the existing Recharts card pattern
  admin/
    page.tsx                   NEW: RSC pool status + <TopupPanel/>
    TopupPanel.tsx             NEW: client form, token typed per use (never persisted)
```

Nav: "Game" keeps pointing at `/game` (now the hub). Home's "Spot the fallacy" card
becomes a "Brain games" card → `/game`. `proxy.ts` needs no change (same cookie gate
covers all new paths). Service worker: no change (network-first for pages already;
API responses still never cached).

---

## 7. Key decisions

**Registry = server-side dispatch table; UI mapped by folder convention.**
Rationale: `lib/` is `server-only`; a registry that imported client components would
break that. Server half (round production, scoring, Zod body) lives in
`lib/games/<id>/`; UI lives in `app/game/<id>/`; the hub renders from serializable
`GameMeta` only. Trade-off: "one-folder job" is really two folders + one registry line.
Alternative: a full-stack plugin object with a component reference — rejected, it would
force `"use client"` boundaries into lib and drag client code into route handlers.

**One polymorphic route pair (`/api/game/next` + `/api/game/answer`), not per-game routes.**
Rationale: exact back-compat via `type`/`game_type` defaults (existing client + tests
untouched), and game #4 needs zero new routes. Trade-off: a discriminated-union body is
mildly uglier than dedicated schemas. Alternative: `/api/game/<type>/…` — switch if any
game ever needs a wildly different transport (e.g. websockets).

**Single `game_attempts` table + `game_type` + `detail jsonb`, not per-game tables.**
Rationale: XP, achievements, daily counts, and streak all read one append-only log;
`detail` absorbs per-game variance; new game types are data, not DDL. Trade-off: weaker
typing on `detail` (mitigated by Zod at write time + a shape CHECK for fallacy rows).
Alternative: per-game attempt tables (RUNBOOK's earlier sketch) — rejected: UNION-heavy
reads and a migration per new game.

**N-back anti-cheat: server-seeded rounds, HMAC round tokens, raw-response scoring —
an explicitly pragmatic compromise.** The client must receive the full stimulus stream
to render it, so a scripted client could always play perfectly; that is inherent to any
client-rendered reaction game. What we DO prevent: score forgery (client submits raw
per-trial booleans; the server recomputes the score from ground truth it re-derives from
the signed token), tampering (HMAC), and replay (`round_uid` unique index → 409). For a
single-user self-improvement app with no leaderboard, defending against the owner
scripting against himself is not a requirement. Alternative (rejected): trusting a
client-computed summary score — breaks the server-side-validation invariant for no
savings. Fallacy and syllogism remain fully server-truth (answer key never leaves the
server before the answer).

**Syllogism content: local template bank, zero Gemini.** 24 forms × 60 triples × 2
phrasings = 2,880 rounds (>6 months at 15/day) with deterministic validity and
hand-written explanations — better correctness than generated logic content (an LLM
mislabeling validity would poison the game), and zero quota. Trade-off: authoring ~24
forms + 60 triples is a few hours of careful editorial work; the invalid forms must be
reviewed for genuine invalidity. Alternative: Gemini batch generation like fallacies —
rejected: validity correctness is exactly what LLMs get subtly wrong, and quota isn't
needed here.

**XP written on the attempt row at insert time (+ one-time backfill), not read-time
derivation, not a ledger table.** See §5.1. Existing history earns XP retroactively via
the backfill — Rai's ~existing data counts from day one.

**Login limiter: `login_attempts` table, fail-open, opportunistic pruning.**
Rationale: durable across serverless lambdas (the security review's gap), no cron, no
new infra (Vercel KV rejected — new dependency for one counter). Fail-open on DB error
keeps the single legit user out of a lockout when Supabase free tier is waking up; the
scrypt-verified passphrase remains the actual gate, and the pre-KDF window check still
shields compute in the normal path. Trade-off: a determined attacker who can *also*
take down Supabase gets unlimited tries — accepted for this threat model.

**Admin token typed per use in the panel, never persisted.** See §4.7.

**STAR scoring only for behavioral prompts, selected server-side by prompt category,
one Gemini call either way.** Rationale: a pitch or negotiation answer scored against
STAR would produce garbage trend data; branching the response schema (not adding a
second call) keeps quota flat. Trade-off: two voice schemas to maintain; mitigated by
deriving the STAR Zod schema from the base via `.omit().extend()`.

---

## 8. Failure & scaling considerations

- **Round-token failures:** expired → 410 (client fetches a fresh round); tampered →
  410 (verify fails closed); replayed → 409 from the unique index (client treats as
  already-scored, moves on). Token verification failures are logged with the game type,
  never the token contents.
- **Idempotency:** achievements unlock via PK + `on conflict do nothing`; XP backfills
  guarded (`xp = 0` / `score is null`); attempts append-only as before; a double-submit
  of a token round is blocked by the replay index (unlike fallacy, where a double insert
  is harmless day-granular noise — unchanged behavior).
- **Stats read growth:** `getStats()` full-table reads are fine to ~10–20k rows (single
  user ≈ years). Escape hatch documented: move sums/aggregates to one Postgres RPC when
  reads exceed that. New `(game_type, local_day)` index keeps per-game filters cheap.
- **Gemini posture unchanged:** games add zero calls; interview stays 1 call/attempt
  with the existing 429/IndexedDB stash path; STAR variant adds ~40 output tokens.
  Worst-case day is still ≈23 requests vs the ~250 RPD floor (AI_DESIGN §3).
- **Supabase-down during login:** limiter fails open (logged `[auth] limiter degraded`),
  scrypt still gates. During gameplay: routes already 500 cleanly; token rounds mean
  n-back/syllogism can even be *served* without DB reads (only scoring writes need it).
- **SpeechSynthesis availability:** n-back letters are always rendered visually; audio
  is best-effort (feature-detected). No fallback complexity.
- **Observability:** log lines per new seam — `[game/answer] type=nback score=… n=…`,
  `[progression] unlocked=…`, `[auth] limiter …`, `[admin/topup] …` (existing topup
  logging reused). No transcripts, no tokens, no audio in logs (unchanged rule).
- **Clock/timezone:** all new day math reuses `todayLocal()` / `local_day` — no client
  clocks trusted anywhere new.

---

## 9. Test impact (the 219 must keep passing — what legitimately changes)

New pure modules get new test files (n-back engine determinism/scoring/progression,
syllogism validity table — assert every form's `valid` flag against hand-checked truth,
token sign/verify/expiry/tamper, `weightedPick`, `levelFromXp`, limiter logic,
achievements predicates, STAR schema parsing).

Legitimate changes to existing tests (update, don't delete):

| File | Why it changes |
| --- | --- |
| `tests/lib/game.test.ts` | `getNextRound` gains the per-fallacy-accuracy query (mock chain +1); `recordAnswer` insert payload gains `game_type/score/xp/detail` (assert the new fields) |
| `tests/lib/stats.test.ts` | game queries gain `.eq("game_type","fallacy")` (Wave B); `Stats` gains additive fields (Wave C) |
| `tests/routes/game.test.ts` | answer response gains additive gamification fields — update any exact-body (`toEqual`) assertions to `toMatchObject` or extend expected bodies; add nback/syllogism cases |
| `tests/routes/auth-login.test.ts` | in-memory limiter → mocked `login_attempts` table; same status-code contract asserted |
| `tests/routes/interview-feedback.test.ts` | additive response fields; `analyzeInterviewAudio` gains the `category` param |
| `tests/lib/gemini-client.parsing.test.ts` | add STAR-variant parse cases (existing cases unchanged) |

Everything else (`session`, `day`, `hash`, `env`, `streak`, `streak-db`, `gemini-client.wpm`,
`stats-and-logout`, `game-topup`, `cron-topup`) is untouched by design.

---

## 10. Build sequence — two waves, minimal file overlap

Waves are sequential (B ships and its tests pass before C starts). The seam: **Wave B
owns everything under `app/game/`, `app/api/game/`, `lib/games/`, `lib/game.ts`, and the
ENTIRE v1 `schema.sql` delta (including Wave C's tables/seeds — they sit inert until C
builds on them). Wave C owns interview, gamification UI, dashboard, admin, auth.** The
only files touched by both waves, by design: `lib/progression.ts` (B ships it with an
achievements stub returning `[]`; C fills the stub + adds `lib/achievements.ts`) and
`lib/stats.ts` (B: 2-line fallacy filter; C: full extension). No route file is edited
by both waves.

### Wave B — game registry, two new games, schema (est. the bigger wave)

1. **`schema.sql`** — append the complete §2 delta block (game_attempts generalization
   + backfills + indexes, interview_prompts CHECK + 12 seeds, interview_attempts
   columns + backfill, `achievements`, `login_attempts`, RLS enable/force on new
   tables). Verify by running twice against a copy of the real DB.
2. **`lib/supabase/types.ts`** — full v1 row-type update (§2.7).
3. **`lib/xp.ts`** (new) — XP constants + `levelFromXp()` + tests.
4. **`lib/games/token.ts`** (new) — sign/verify with domain separation + tests.
5. **`lib/games/nback/engine.ts`** (new) — PRNG, `generateSequence`, `groundTruth`,
   `scoreSession`, `nextLevel` + tests (determinism: same seed ⇒ same sequence).
6. **`lib/games/syllogism/templates.ts` + `engine.ts`** (new) — 24 forms, 60 triples,
   2 phrasings, explanations; validity-table test asserting every form.
7. **`lib/games/registry.ts`, `types.ts`, `fallacy.ts`, `nback/index.ts`,
   `syllogism/index.ts`** (new) — GameDefinitions; nback/syllogism `answer()` writes
   attempts (game_type/score/detail/xp, replay-guard handling).
8. **`lib/game.ts`** — weighted (spaced-repetition) selection in `getNextRound` +
   `weightedPick` helper; `recordAnswer` writes `game_type:'fallacy'`, `score`, `xp`
   (difficulty read in the same round fetch); add `getPoolStatus()` (consumed by Wave C
   admin page). Update `tests/lib/game.test.ts`.
9. **`lib/progression.ts`** (new) — `afterActivity()` with streak + XP totals +
   achievements stub (`[]`); `getDailyGoal()`.
10. **`app/api/game/next/route.ts`** — `type` param + registry dispatch (fallacy default,
    byte-identical legacy response). **`app/api/game/answer/route.ts`** — discriminated
    union body, dispatch, `afterActivity()` call, additive response fields, 409/410
    mappings. Update `tests/routes/game.test.ts` (+ new nback/syllogism route cases).
11. **`lib/stats.ts`** — the 2-line `.eq("game_type","fallacy")` fix; update
    `tests/lib/stats.test.ts` mocks.
12. **`app/game/page.tsx`** → hub (RSC from `listGameMeta()`); move fallacy UI to
    **`app/game/fallacy/{page,GameClient}.tsx`**; new
    **`app/game/nback/{page,NBackClient}.tsx`** and
    **`app/game/syllogism/{page,SyllogismClient}.tsx`**.
13. Full suite green; manual pass: play all three games, re-run `schema.sql`, confirm
    legacy fallacy client behavior unchanged.

### Wave C — interview v2, gamification surfaces, dashboard v2, ops

1. **`lib/gemini/schemas.ts`** — `voiceStarModelSchema` + `VOICE_STAR_RESPONSE_SCHEMA`
   (additive). **`lib/gemini/prompts.ts`** — STAR rubric block. **`lib/gemini/client.ts`**
   — `category` param, variant selection, `star`/`structure_score` in
   `InterviewFeedback`. Update `tests/lib/gemini-client.parsing.test.ts`.
2. **`lib/interviewCategories.ts`** (new) — category keys + display labels (client-safe).
3. **`lib/interview.ts`** — `insertInterviewAttempt` writes STAR cols + xp;
   `listAttempts`, `getPersonalBests`, `getPreviousComparableAttempt`.
4. **`app/api/interview/feedback/route.ts`** — category lookup, STAR path, `previous`
   delta payload, `afterActivity()` call, additive response fields. Update
   `tests/routes/interview-feedback.test.ts`.
5. **`lib/achievements.ts`** (new) — catalog + trigger map + predicates + tests; fill
   the stub in **`lib/progression.ts`** (evaluation + `on conflict do nothing` insert).
6. **`lib/loginLimiter.ts`** (new) + **`app/api/auth/login/route.ts`** — swap the
   in-memory Map for the table-backed check (same HTTP contract, fail-open). Rewrite
   `tests/routes/auth-login.test.ts` against the mocked table.
7. **`lib/stats.ts`** — full extension: `games.nback/syllogism` trends, `xp`, `weekly`
   (rolling 7d), `achievements`, `daily_goal`. Update `tests/lib/stats.test.ts`.
8. **`app/interview/page.tsx`** (chips, `?prompt=`/`?category=`),
   **`RecorderClient.tsx`** (initialPromptId, retry button),
   **`FeedbackView.tsx`** (STAR row, structure score, "vs last attempt" delta strip),
   **`app/interview/history/{page,TranscriptToggle}.tsx`** (new).
9. **`app/page.tsx`** — level/XP header, daily-goal ring (inline SVG), achievements
   strip, brain-games card. **`app/progress/page.tsx` + `DashboardCharts.tsx`** —
   weekly insight card, per-game trend selector tabs, achievements strip.
10. **`app/admin/{page,TopupPanel}.tsx`** (new) — pool status + per-use-token top-up form
    (POSTs to the existing `/api/game/topup`).
11. **Docs:** update `README.md` (pillars/status/test count), `RUNBOOK.md` (the top-up
    button now exists — resolve the documented discrepancy; new-game recipe now points
    at `lib/games/`), `SETUP.md`/`DEPLOY.md` only if wording drifts (no new env vars).
12. Full suite green; manual pass: behavioral vs pitch scoring paths, history/bests,
    achievements unlock, daily ring, admin top-up with wrong + right token, login
    lockout after 10 fails.
