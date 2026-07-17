# Talasin v2 — Games #4 and #5: Number Sequence + Better Bet

**Status:** design for one build session. Verified against the live v1 code
(`lib/games/*`, `app/game/*`, `lib/xp.ts`, `lib/achievements.ts`, `lib/stats.ts`,
`schema.sql`, `app/api/game/{next,answer}/route.ts`) on 2026-07-04.

Hard constraints (all confirmed feasible against the code):

- **ZERO schema changes.** `game_attempts.game_type` is open `text` (no enum
  CHECK), `detail jsonb` absorbs per-game payloads, and the partial unique index
  `game_attempts_round_uid_key` on `detail->>'round_uid'` is the replay guard.
  Both games are token-served stateless rounds — nothing new to migrate.
- **ZERO new Gemini calls, ZERO new env vars.** Both games are pure-TypeScript
  local generators (syllogism pattern). Round tokens reuse
  `TALASIN_SESSION_SECRET` via the existing `signRoundToken`/`verifyRoundToken`
  with the `"round."` domain prefix.
- **Additive only.** No existing game's behavior, route contract, or test
  changes semantics. The only edited files gain lines; none change meaning.

---

## 1. Overview

Two new games plug into the existing registry exactly per the RUNBOOK "Adding
game #4" recipe. **Number Sequence** (`sequence`) is pattern induction: 4–5
terms of a numeric sequence, pick the next term from 4 options; rounds are
composed from a local **family bank** (13 families × parameter ranges ≈ 11,000
distinct rounds) with rule-based distractors. **Better Bet** (`betterbet`) is
expected-value judgment: two concrete peso-framed options, pick the higher-EV
one or "about equal"; rounds come from a **12-template scenario bank** with
exact integer EV math and a deterministic tolerance classifier. Both follow the
syllogism model: ground truth never leaves the server pre-answer, the signed
token carries the round's identity, `answer()` re-derives everything
server-side, scores 0/100, writes one `game_attempts` row, and flows through
`afterActivity()` untouched.

```
app/game/page.tsx (hub) ──► cards auto-added via listGameMeta()
        │
        ├─ /game/sequence   SequenceClient ──┐
        └─ /game/betterbet  BetterBetClient ─┤
                                             ▼
              GET /api/game/next?type=X   POST /api/game/answer   (routes UNCHANGED)
                                             │
                              lib/games/registry.ts  (+2 entries)
                                ├─ sequence/  families.ts  engine.ts  index.ts
                                ├─ betterbet/ templates.ts engine.ts  index.ts
                                └─ (fallacy / nback / syllogism unchanged)
                                             │
                    HMAC round token (lib/games/token.ts, unchanged)
                    replay guard: detail.round_uid partial unique index
                                             ▼
                    game_attempts (game_type='sequence'|'betterbet',
                    score 0/100, detail jsonb, xp) — ZERO schema changes
```

---

## 2. Data model — zero DDL, documented `detail` shapes

No `schema.sql` edit. The two new rows extend the DESIGN_V1 §2.1 `detail`
table (Zod-validated app-side before insert, as today):

| game_type | detail |
| --- | --- |
| `sequence` | `{ round_uid, family, difficulty, params_hash, chosen_index }` |
| `betterbet` | `{ round_uid, template, tier, params_hash, answer_class, chosen }` |

- `round_uid` = the token uid → caught by the existing partial unique index
  (second insert → PG `23505` → `AlreadyScoredError` → 409). Identical to
  n-back/syllogism.
- `params_hash` = `sha256("{id}|{p.join(",")}").hex.slice(0,16)` (same shape as
  syllogism's `terms_hash`) — feeds recent-repeat exclusion and future stats.
- Both games write `is_correct` (boolean) + `score` (100/0) + `answered_ms` +
  `local_day` + `xp`, with `round_id/chosen_key/fallacy_key = null` — exactly
  the syllogism insert shape (`lib/games/syllogism/index.ts` is the template).
- `lib/supabase/types.ts`: **no change** (`GameAttempt.game_type` is `string`).

Because `is_correct` is non-null, both games automatically join the existing
weekly `game_accuracy` aggregate in `lib/stats.ts` (it reads all game rows and
filters `is_correct != null`) — by design, zero edits needed there.

---

## 3. Registry integration & contracts

### 3.1 Type + registry deltas (2 small edits)

```ts
// lib/games/types.ts — widen the union (only edit in this file)
export type GameType = "fallacy" | "nback" | "syllogism" | "sequence" | "betterbet";

// lib/games/registry.ts — two imports + two entries
export const GAMES: Record<GameType, GameDefinition> = {
  fallacy: fallacyGame,
  nback: nbackGame,
  syllogism: syllogismGame,
  sequence: sequenceGame,     // NEW
  betterbet: betterBetGame,   // NEW
};
```

`GameMeta` for the hub cards (rendered automatically by `listGameMeta()` — no
hub code change):

| id | name | tagline | href | pillarLabel |
| --- | --- | --- | --- | --- |
| `sequence` | Number sequence | Four terms in, one term out — find the rule before you pick. | `/game/sequence` | Sequence |
| `betterbet` | Better bet | Two offers, real pesos. Which has the higher expected value? | `/game/betterbet` | Better bet |

### 3.2 API contracts (routes untouched — registry dispatch only)

`GET /api/game/next?type=sequence`:

```jsonc
{ "round": {
    "game_type": "sequence",
    "terms": [7, 12, 17, 22],          // 4 or 5 shown terms (family-defined)
    "options": [29, 27, 26, 28],       // 4 shuffled choices, EXACTLY one correct
    "difficulty": 1,                    // 1..3 (display pill, like fallacy)
    "token": "<signed>"                 // NO correct answer, NO explanation
} }
```

`GET /api/game/next?type=betterbet`:

```jsonc
{ "round": {
    "game_type": "betterbet",
    "scenario": "An office raffle ticket gives a 4% chance at ₱12,500. A coworker offers to buy your ticket.",
    "option_a": "Keep the ticket (4% chance at ₱12,500)",
    "option_b": "Sell it for ₱610 cash",
    "tier": 1,
    "token": "<signed>"                 // NO EVs, NO class, NO explanation
} }
```

`POST /api/game/answer` — two new arms of the existing discriminated body
(each game's `answerBody` Zod schema; the route already dispatches via
`game.answerBody`):

```jsonc
// sequence:  { "game_type": "sequence",  "token": string, "choice": 0|1|2|3, "answered_ms"?: n }
// betterbet: { "game_type": "betterbet", "token": string, "choice": "a"|"b"|"equal", "answered_ms"?: n }
```

Responses (per-game reveal merged with the standard `afterActivity()` fields,
exactly like syllogism):

```jsonc
// sequence:
{ "is_correct": true, "correct_value": 27, "correct_index": 1,
  "explanation": "Add 5 each step: 22 + 5 = 27.", "difficulty": 1, "family": "arith_up",
  "streak": 4, "xp_awarded": 15, "xp_total": 5210, "level": 7, "new_achievements": [] }

// betterbet:
{ "is_correct": false, "correct": "b",
  "ev_a": 500, "ev_b": 610,            // pesos, 2-dp numbers
  "explanation": "A: 4% × ₱12,500 = ₱500 expected. B: sure ₱610. B is higher by ₱110 (+22%). A rare big win usually isn't worth more than its probability-weighted value.",
  "tier": 1,
  "streak": 4, "xp_awarded": 10, "xp_total": 5205, "level": 7, "new_achievements": [] }
```

Errors — byte-identical semantics to the existing token games:

- 400 invalid body / unknown type (route already handles)
- 410 `round_expired` — `verifyRoundToken` returns null (bad sig / expired /
  wrong game) **or** token data fails validation (unknown family/template id,
  params out of sanity bounds) → throw `RoundExpiredError` (syllogism precedent
  for a token minted pre-rename)
- 409 `already_scored` — insert hits `23505` on `detail->>'round_uid'` → throw
  `AlreadyScoredError`
- `next()` **never returns null** for either game (stateless generators can't
  exhaust) — the `{ round: null, reason: "exhausted" }` branch stays
  fallacy-only. The `exclude` opt is accepted and ignored (n-back/syllogism
  precedent; repeat avoidance is server-side, §4.4).

### 3.3 Token payloads + anti-cheat stance (explicit)

Token TTL: **10 min** for both (single-decision rounds; syllogism precedent).

```ts
// sequence token data
{ f: "quadratic", p: [4, 3, 2] }        // family id + canonical param array
// betterbet token data
{ tpl: "raffle_vs_cash", p: [400, 12500, 610] }  // template id + canonical params (incl. solved knob)
```

**What the token leaks (accepted, single-user posture — DESIGN_V1 §8):** the
payload is base64-readable, so the client can see the family/template id and
raw parameters. Recovering the correct answer from them requires re-implementing
(or reading) the app's own generator source — the same stance already
documented for syllogism's `form_id`. The client **never** receives the correct
option value/index, the EVs, the answer class, or the explanation before
answering; the server re-derives all of it at answer time from `(id, p)` plus
the option shuffle from `seedFromUid(uid)` (n-back's helper, reused). There is
no leaderboard and one user; defending the owner scripting against himself is
explicitly not a requirement.

Why explicit params in the token instead of pure uid-seed derivation (n-back
style): `next()` excludes recently-seen rounds via a DB read (§4.4), so the
accepted pick can't be a pure function of the uid. Carrying the round identity
in the signed token (syllogism style: `{form_id, triple, phrasing}`) keeps
`answer()` deterministic without re-running the exclusion query.

---

## 4. Game 1 — Number Sequence (`lib/games/sequence/`)

Files: `families.ts` (pure data + per-family logic), `engine.ts` (pure:
compose, distractors, shuffle, pick, hash, difficulty rule), `index.ts`
(GameDefinition, server-only).

### 4.1 Family bank — taxonomy, ramp, combinatorics

Each family declares: `id`, `difficulty` (1–3), `shown` (terms displayed),
`params` (canonical order + integer ranges), `terms(p)` (generates shown terms
+ the correct next term), `distractors(terms, correct, p)` (priority-ordered
rule-based candidates), `explain(p, terms, correct)` (deterministic string).

| # | id | diff | shown | rule (next term) | canonical params `p` + ranges | pool |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `arith_up` | 1 | 4 | tₙ₊₁ = tₙ + s | `[a, s]`, a∈[2,30], s∈[2,9] | 232 |
| 2 | `arith_down` | 1 | 4 | tₙ₊₁ = tₙ − s | `[a, s]`, a∈[40,120], s∈[2,9] | 648 |
| 3 | `geom` | 1 | 4 | tₙ₊₁ = tₙ · r | `[a, r]`, a∈[1,12], r∈{2,3,4}, constraint a·r⁴ ≤ 1600 (r=4 ⇒ a≤6) | 30 |
| 4 | `quadratic` | 2 | 5 | Δᵢ = d + k·(i−1); tₙ₊₁ = tₙ + Δₙ | `[a, d, k]`, a∈[1,20], d∈[2,7], k∈[1,4] | 480 |
| 5 | `alt_add_sub` | 2 | 5 | alternate +p, −q (next op after 5 shown = +p) | `[a, p, q]`, a∈[10,40], p∈[5,12], q∈[1,4] (p>q always) | 992 |
| 6 | `interleave` | 2 | 5 | two arithmetic threads; shown = a1, a2, a1+d1, a2+d2, a1+2d1; answer = a2+2d2 | `[a1, d1, a2, d2]`, a1,a2∈[1,20], d1,d2∈[2,6], d1≠d2 | 8,000 |
| 7 | `affine` | 2 | 4 | tₙ₊₁ = m·tₙ + c | `[a, m, c]`, a∈[1,8], m∈{2,3}, c∈[1,6] | 96 |
| 8 | `squares` | 3 | 5 | (n+1)² + c | `[n0, c]`, n0∈[1,10], c∈[−5,5] | 110 |
| 9 | `cubes` | 3 | 4 | (n+1)³ + c | `[n0, c]`, n0∈[1,7], c∈[−3,3] | 49 |
| 10 | `primes` | 3 | 5 | next consecutive prime + c | `[s, c]`, s∈[1,25] (start index), c∈{−1,0,1}; prime table to index 30 (113) | 75 |
| 11 | `fib_like` | 3 | 5 | tₙ₊₁ = tₙ + tₙ₋₁ | `[a, b]`, a,b∈[1,12] | 144 |
| 12 | `triangular` | 3 | 5 | T(n+1) + c, T(n)=n(n+1)/2 | `[n0, c]`, n0∈[1,10], c∈[−5,5] | 110 |
| 13 | `double_add` | 3 | 5 | tₙ₊₁ = 2·tₙ + k | `[a, k]`, a∈[2,15], k∈[1,8] | 112 |

**Pools: D1 = 910, D2 = 9,568, D3 = 600 → 11,078 distinct rounds** (like
syllogism's "24 × 60 × 2 = 2,880" claim, asserted in tests). All term values
and answers stay within |v| ≤ 20,000 by construction (asserted by a full-pool
sweep test).

**Repeat-rarity math:** the recent-exclusion window (§4.4, last 300 sequence
attempts' `params_hash`) makes an exact repeat *structurally impossible within
the last 300 rounds* — 30 days at a heavy 10 rounds/day. Beyond the window:
mixed-difficulty play draws from ~11k rounds → expected first exact repeat
well past 3 months. Worst case is camping at difficulty 3 (600-round pool):
full-pool cycle ≥ 60 days at 10/day, so any specific D3 round recurs at most
every ~2 months — acceptable for arithmetic puzzles (unlike worded content,
"squares starting at 7²" isn't memorable). D1's small `geom` pool (30) is
transient: the adaptive ramp (§4.5) moves a competent player off D1 within
days.

### 4.2 Round generation (deterministic from `(family, p, uid)`)

`next()` (in `index.ts`):

1. One query: `game_attempts.select("is_correct, detail").eq("game_type","sequence").order("created_at", desc).limit(300)`.
   From it derive **both** the recent `params_hash` set and (first 5 rows) the
   difficulty inputs — one query total, mirroring syllogism's `recentHashes()`
   + n-back's `currentN()` in a single read.
2. `pickRound(difficulty, recentHashes, rand)` (engine, pure): up to
   `MAX_PICK_TRIES = 80` rejection-sampling tries — pick a family uniformly
   among that difficulty's families, sample each param uniformly in range
   (re-draw on constraint violations like `d1===d2`), compute `params_hash`,
   accept the first not in the recent set; after 80 tries accept a repeat
   (syllogism's exact fallback stance — the pool can't exhaust, only be
   briefly unlucky).
3. `uid = randomUUID()`; `options = shuffle([correct, d1, d2, d3], mulberry32(seedFromUid(uid)))`
   — reuses n-back's `mulberry32` + `seedFromUid` so `answer()` reproduces the
   identical order.
4. `token = signRoundToken("sequence", { f, p }, 600, uid)`.
5. Return `{ game_type, terms, options, difficulty, token }`.

`answer()`:

1. Zod-parse body; `verifyRoundToken(token, "sequence")` — null → `RoundExpiredError`.
2. Validate token data: known family id; `p.length` matches; every param an
   integer within **sanity bounds** (the declared range) — fail →
   `RoundExpiredError` (mirrors syllogism's triple/phrasing validation).
3. Recompose: `terms`, `correct`, `distractors`, `options` (same shuffle from
   `seedFromUid(uid)`). `isCorrect = options[choice] === correct`.
4. Insert the attempt row (shape per §2); `23505` → `AlreadyScoredError`.
5. Return `{ reveal: { is_correct, correct_value, correct_index, explanation, difficulty, family }, isCorrect, score, xpAwarded }`.

### 4.3 Distractors — plausible rule mistakes, never noise

Per-family priority-ordered candidates (Δlast = last shown gap, Δprev = the
gap before it):

| family class | candidate rules (in order) — each a real mistake |
| --- | --- |
| `arith_up` / `arith_down` | prev + (s∓1) ("off-by-one on the difference", both signs → correct±1), prev + 2s (applied the step twice), prev − s (sign slip) |
| `geom` | prev·(r+1), prev·(r−1) (mis-read ratio; r=2 gives `prev` → filtered as a shown term), prev·r ± r, prev + r (treated ratio as a difference) |
| `quadratic`, `squares`, `cubes`, `triangular` | prev + Δlast ("applied the previous delta again" — THE canonical mistake), prev + Δlast + u, correct ± u where u = Δlast − Δprev (the second-order increment, ≥1) |
| `alt_add_sub` | prev − q (applied the wrong alternating op), prev + p − q (collapsed both ops), prev + q (sign slip on the wrong op) |
| `interleave` | lastShown + d1 (continued the WRONG thread), correct + (d1 − d2) (used the other thread's step), correct ± 1 |
| `affine`, `double_add` | m·prev (forgot +c), m·prev + 2c (doubled the constant), (m+1)·prev + c (off-by-one on the multiplier) |
| `primes` | prev + Δlast (assumed the gap repeats), correct ± 2 (composite neighbors that "look prime-ish") |
| `fib_like` | 2·t₅ − t₄ (arithmetic continuation of the last gap), 2·t₅ (doubled instead of summed), correct ± 1 |

**Hard guarantees** (engine-enforced, test-swept across all 11,078 rounds):

- Candidates are filtered: `≠ correct`, `∉ shown terms`, pairwise distinct,
  integer.
- If fewer than 3 survive, a **deterministic fallback ladder** fills:
  `correct + j·u, correct − j·u` for j = 1, 2, 3… with `u = max(1, |Δlast|)`,
  skipping already-used/shown values — always terminates, always yields exactly
  3 distinct wrong options.
- Final round invariant: `options.length === 4`, all distinct, contains
  `correct` exactly once.

### 4.4 Repeat avoidance

Identical mechanism to syllogism: `detail.params_hash` stored per attempt; the
`next()` query's last-300 hash set excludes exact combos. No cron, no table.

### 4.5 Difficulty ramp (adaptive, one shared pure helper)

New tiny pure module `lib/games/adaptive.ts` used by both games:

```ts
/** ≥4/5 recent correct → level+1 (cap), ≤2/5 → level−1 (floor), else hold.
 *  Fewer than 5 recent attempts → hold. First ever → min. */
export function nextAdaptiveLevel(
  last: number, recentCorrect: boolean[], min: number, max: number,
): number;
```

For sequence: `min=1, max=3`; `last` = most recent attempt's
`detail.difficulty` (default 1); `recentCorrect` = `is_correct` of the 5 most
recent sequence attempts (from the §4.2 query). Mirrors n-back's `nextLevel`
philosophy (single cheap read, deliberately simple; the 5-window mixing
difficulties right after a promotion is accepted noise — same class of noise
as n-back's single-row rule).

**Session shape decision:** one round at a time (fetch → answer → reveal →
next), with a **presentational daily set of 10** — a client-side counter
("Round 3 of 10") ending in a set-summary card, exactly like syllogism's
60-second sprint is presentational. The server never blocks play (no
per-day cap query); every answer is one attempt row. **No per-round time
budget** — fallacy and syllogism have none; `answered_ms` is recorded for
future speed stats and the 10-min token TTL is the soft bound. (Decision
rationale in §8.)

### 4.6 Scoring + XP

- `score = isCorrect ? 100 : 0`; `is_correct` boolean — plots on the existing
  0–100 axes and joins the weekly accuracy aggregate automatically.
- `lib/xp.ts` (additive):

```ts
/** Sequence round: same shape as fallacy — 10 base + 5 correct + 5·(difficulty−1) → 10–25. */
export function sequenceXp(isCorrect: boolean, difficulty: number): number {
  const d = Number.isFinite(difficulty) ? Math.min(3, Math.max(1, difficulty)) : 1;
  return 10 + (isCorrect ? 5 : 0) + 5 * (d - 1);
}
```

Consistent with DESIGN_V1 §5.1: harder + slower than syllogism (5–10),
comparable cognitive load to a fallacy round (10–25).

---

## 5. Game 2 — Better Bet (`lib/games/betterbet/`)

Files: `templates.ts` (pure data: 12 templates), `engine.ts` (pure: EV math,
classifier, class-targeted construction, scenario/explanation builders, pick,
hash), `index.ts` (GameDefinition, server-only).

### 5.1 Exact EV math — integer basis points, no floats

All probabilities are **integer basis points** (`p_bp`, 100 bp = 1%); all
payoffs/costs are **integer pesos**. EV is computed in integer
`EV_bp = Σ payoff_pesos × p_bp` units (a sure amount Y contributes
`Y × 10_000`; a cost subtracts the same way). Display pesos =
`EV_bp / 10_000`. All comparisons are exact integer arithmetic — no float
tolerance bugs by construction.

**Classifier (the single source of ground truth):**

```ts
export type BetClass = "a" | "b" | "equal";
export function classify(evA: number, evB: number): BetClass {
  const m = Math.max(Math.abs(evA), Math.abs(evB));
  if (m === 0) return "equal";
  if (20 * Math.abs(evA - evB) < m) return "equal"; // |ΔEV|/max < 0.05
  return evA > evB ? "a" : "b";
}
```

Tolerance rule, stated precisely: **"about equal" ⟺ |EVa − EVb| / max(|EVa|,
|EVb|) < 0.05** (both-zero → equal). "Better" = strictly higher EV — for the
negative-EV templates (insurance/warranty) that means the smaller expected
loss, which the explanation spells out.

**Dead-zone guarantee:** the generator only emits rounds with relative gap
**< 0.03** (equal-class) or **> 0.10** (clear-class) — integer checks
`100·|Δ| < 3·m` and `10·|Δ| > m`. The classifier's 0.05 threshold sits inside
the untouched band, so peso rounding can never flip a round's class and every
emitted round is unambiguous. Tests sweep for zero dead-zone emissions.

### 5.2 Template bank — 12 templates, 3 tiers, canonical params

Each template declares: `id`, `tier`, `params` (canonical order, ranges,
sampling grids), the **solved knob** (always a *peso payoff*, never a
probability — so EV granularity per knob step is ≤ ₱1-equivalent and every
class band is reachable exactly), `evA(p)`/`evB(p)` (integer `EV_bp`),
`scenario(p)`/`optionA(p)`/`optionB(p)` text builders, and a fixed one-line
`insight` teach-back appended to the numeric reveal (syllogism's
per-form-explanation pattern).

| # | id | tier | scenario sketch (peso-framed, locale-light) | canonical `p` (free params → ranges/grids; **knob** solved) | EV formulas (EV_bp) | free-param combos |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `raffle_vs_cash` | 1 | Office raffle ticket: p% chance at ₱X. Coworker offers ₱**Y** for it. | `[p_bp, X, Y]` — p∈[200,1000] step 100; X∈[2000,20000] step 500; **Y** | A = X·p_bp; B = Y·10⁴ | 333 |
| 2 | `coinflip_or_sure` | 1 | Client settles a dispute: coin flip for ₱X or take ₱**Y** now. | `[X, Y]` — X∈[1000,10000] step 200; **Y** | A = X·5000; B = Y·10⁴ | 46 |
| 3 | `gig_approval` | 1 | Gig pays ₱G but only if the client approves (p%). Other gig pays ₱**Y** flat. | `[p_bp, G, Y]` — p∈[4000,9000] step 500; G∈[1500,12000] step 500; **Y** | A = G·p_bp; B = Y·10⁴ | 242 |
| 4 | `bulk_sale` | 1 | Sell m items at ₱r profit each (sure), or p% chance a reseller takes the lot for ₱**Y**. | `[m, r, p_bp, Y]` — m∈[10,40] step 5; r∈[20,150] step 10; p∈[3000,8000] step 500; **Y** | A = m·r·10⁴; B = Y·p_bp | 1,078 |
| 5 | `discount_vs_cashback` | 2 | ₱P gadget: d% off today, or list price with ₱**C** cashback that posts p% of the time. | `[P, d_bp, p_bp, C]` — P∈[3000,30000] step 1000; d∈[500,1500] step 100; p∈[5000,9500] step 500; **C** | A = P·d_bp; B = C·p_bp | 3,080 |
| 6 | `two_raffles` | 2 | Raffle A: p1% at ₱X1. Raffle B: p2% at ₱**X2**. Same ticket price. | `[p1, X1, p2, X2]` — p1,p2∈[500,3000] step 100; X1∈[1000,15000] step 500; **X2** | A = X1·p1; B = X2·p2 | 19,604 |
| 7 | `mixed_bonus` | 2 | Bonus plan A: flat ₱X. Plan B: p% of ₱**H**, otherwise ₱L. | `[X, p_bp, L, H]` — X∈[2000,10000] step 500; p∈[2000,6000] step 500; L∈[200,1500] step 100; **H** | A = X·10⁴; B = H·p_bp + L·(10⁴−p_bp) | 2,142 |
| 8 | `sell_now_or_wait` | 2 | Sell the old phone for ₱X today, or wait: p% a buyer pays ₱**H**, else offload at ₱L (L = 60% of X, rounded to ₱100). | `[X, p_bp, H]` — X∈[3000,15000] step 500; p∈[3000,7000] step 500; L derived; **H** | A = X·10⁴; B = H·p_bp + L·(10⁴−p_bp) | 225 |
| 9 | `gadget_insurance` | 3 | ₱V phone, p% chance you break it this year. Protection plan: ₱**F**. | `[V, p_bp, F]` — V∈[15000,60000] step 5000; p∈[300,1200] step 100; **F** | A(plan) = −F·10⁴; B(skip) = −V·p_bp | 100 |
| 10 | `long_shot` | 3 | ₱c in hand. Scratch card costs exactly ₱c: 1-in-k chance of ₱**J**, else nothing. | `[c, k, J]` — c∈[20,100] step 10; k∈{50,100,200,500}; **J** (grid ₱25/₱500) | A(card) = J·(10⁴/k); B(keep) = c·10⁴ | 36 |
| 11 | `pipeline_deal` | 3 | Prospect: p1% they book a call; then p2% they sign a ₱X package. Or a guaranteed ₱**Y** gig this week. | `[p1, p2, X, Y]` — p1∈[3000,7000] step 500; p2∈[2000,6000] step 500; X∈[20000,80000] step 5000; **Y** | A = X·(p1·p2/10⁴) (integer: steps of 500 ⇒ p1·p2/10⁴ ∈ ℤ); B = Y·10⁴ | 1,053 |
| 12 | `extended_warranty` | 3 | ₱V appliance. Extended warranty ₱**F**; p% chance of a failure costing ₱R to repair. | `[V, p_bp, R, F]` — V∈[20000,60000] step 5000 (context only); p∈[1000,3000] step 100; R∈[3000,15000] step 500; **F** | A(warranty) = −F·10⁴; B(skip) = −R·p_bp | 4,725 |

Tier ramp intent: **T1** = single multiply vs a sure amount, wide gaps.
**T2** = closer EVs, percentages, two-outcome options. **T3** = compound
probability, negative-EV comparisons, and the classic framing traps
(small-probability-large-payoff, insurance sold above expected loss).

**Combinatorics:** ~32,700 free-parameter combinations, × 3 answer classes ×
the solved knob's per-class value spread ⇒ **well over 100,000 distinct
rounds**; `params_hash` includes the knob, and the 300-hash exclusion window
makes within-month exact repeats structurally impossible. The same *template
text* recurs every ~4 rounds within a tier (4 templates/tier, uniform pick) —
expected and fine: the numbers are the game. Small-pool templates
(`long_shot` 36, `gadget_insurance` 100 free combos) still vary via the knob
and class, so exact repeats stay rare.

### 5.3 Class-targeted generation (all three answers genuinely occur)

`generateRound(tier, rand)` (engine, pure — `rand` is the seeded PRNG stream):

1. Pick a template uniformly within the tier.
2. Pick the **target class** from the seed with fixed weights:
   **A 40% / B 40% / equal 20%** (`r < .4 → a`, `< .8 → b`, else `equal`) —
   "about equal" is a real, frequent outcome, never a decoy.
3. Sample the free params on their grids; compute `evA` (or the reference
   side's EV).
4. Solve the knob for a target EV ratio drawn from the class band
   (`u = rand()` mapped into the band):
   - `equal`: `evB_target = evA·(1+u)`, u ∈ [−0.03, +0.03]
   - other side better: |gap| band u ∈ [0.15, 0.50]; for **negative** reference
     EVs the multiplier is mirrored so "better" always means *higher* (less
     negative) EV.
5. Round the knob to its **grid**: clear classes → natural grid (₱50; `long_shot`
   ₱500); equal class → **₱1 (no rounding)** so the ±3% band is always hittable
   (knob is a payoff ⇒ EV granularity per ₱1 step ≤ ₱1-equivalent, and every
   template's |EV| ≥ ₱40).
6. **Dead-zone check** (integer): if the rounded round lands in
   0.03 ≤ relDiff ≤ 0.10, nudge the knob one grid step toward the target class
   and re-check (≤ 40 steps; final fallback drops the grid to ₱1). Then set
   `answer_class = classify(evA, evB)` — the classifier output is always the
   ground truth, whatever the generation target was.

`next()` mirrors sequence §4.2: one query (last 300 betterbet attempts →
recent `params_hash` set + first-5 `is_correct` for the tier rule
`nextAdaptiveLevel(lastTier, recent5, 1, 3)`), pick with rejection sampling
(80 tries), sign `{ tpl, p }` into the token, return scenario + option texts +
tier + token. `answer()` re-validates `(tpl, p)` (known id, integer params in
sanity bounds — knob validated against generous bounds [1, 10⁶], not the
sampling grid), recomputes `evA/evB/classify`, `isCorrect = choice === class`,
inserts, returns the reveal.

### 5.4 Reveal — deterministic EV teach-back

`explain(template, p, evA, evB, cls)` builds the string from parts:

- Per-option breakdown, always showing the math:
  `"A: 4% × ₱12,500 = ₱500 expected."` /
  `"B: 35% × ₱6,200 + 65% × ₱900 = ₱2,755 expected."` /
  negative-EV framing: `"Skip: 8% × ₱45,000 = ₱3,600 expected loss."`
- Verdict: `"B is higher by ₱110 (+22%)."` or
  `"Within 5% of each other — effectively equal; pick on risk preference, not math."`
- The template's fixed `insight` line (e.g. `long_shot`: "A huge prize can't
  rescue a tiny probability — multiply before you feel."; `gadget_insurance`:
  "Insurance is an EV comparison too: certain cost vs probability × loss.").

Peso formatting helper (pure, in engine): thousands-separated `₱12,500`;
probabilities shown as `4%` / `0.5%` / `1 in 200` per template.

### 5.5 Scoring + XP

- `score = isCorrect ? 100 : 0`, `is_correct` boolean (same as sequence).
- `lib/xp.ts` (additive), same convention as fallacy/sequence:

```ts
/** Better Bet round: 10 base + 5 correct + 5·(tier−1) → 10–25. */
export function betterBetXp(isCorrect: boolean, tier: number): number {
  const t = Number.isFinite(tier) ? Math.min(3, Math.max(1, tier)) : 1;
  return 10 + (isCorrect ? 5 : 0) + 5 * (t - 1);
}
```

---

## 6. UI spec

```
app/game/
  sequence/
    page.tsx             RSC shell — copy of app/game/syllogism/page.tsx:
                         requireSession → redirect /gate; initialRound via
                         GAMES.sequence.next({exclude: []}); loadError fallback card
    SequenceClient.tsx   "use client" play component
  betterbet/
    page.tsx             RSC shell, same pattern
    BetterBetClient.tsx  "use client" play component
```

Both clients follow `SyllogismClient.tsx` verbatim in structure: state
(`round/result/submitting/loadingNext/error/streak`), `fetchNext()` against
`/api/game/next?type=<id>` with 401 → `window.location.href = "/gate"`,
`submit()` POSTing `/api/game/answer` with `answered_ms` from a
`startedAtRef`, **409/410 → silently `fetchNext()`**, reveal state swap, and
the same CSS vars (`--surface`, `--border`, `--accent-strong`, `--danger`,
`--muted`) and button/card classes. Mobile-first single column; the bottom
tab bar / `Nav` is **unchanged** (both games live under `/game`, reached from
the hub whose cards appear automatically via `listGameMeta()`). `proxy.ts`
and the service worker need no change (same cookie gate, API never cached).

**SequenceClient specifics:**

- Header row: difficulty pill (`Difficulty 2`), presentational set counter
  (`Round 3/10`), running `streak` from answers.
- Terms rendered large, tabular-nums, comma-separated with a trailing `?`
  (`7, 12, 17, 22, ?`).
- Options: 2×2 grid of buttons (numbers, tabular-nums).
- Reveal: green/red card (syllogism styling) — "Correct." / "Not quite. The
  next term is **27**." + `explanation`; "Next round" button.
- After 10 answers: set-summary card (`8/10 this set`) with "Play more"
  reset — pure client state, mirrors the sprint-over card.

**BetterBetClient specifics:**

- Scenario paragraph card; below it two full-width option cards labeled
  **A** / **B** with the option text, then a slimmer third button
  "About equal (within 5%)".
- Reveal: green/red card showing the EV breakdown lines + verdict + insight
  (from `explanation`), the correct choice highlighted; "Next round". Same
  set-of-10 presentational counter.

---

## 7. Stats, achievements, daily flow

### 7.1 `lib/stats.ts` — minimal additive delta (spec'd, not zero)

Zero changes needed for: streak, XP totals (`getXpTotal` reads all rows),
weekly windows (already game_type-agnostic; both new games' `is_correct`
booleans join `game_accuracy` automatically), daily goal, fallacy scoping
(already filtered by `.eq("game_type","fallacy")`).

Additive delta for the per-game trend selector (both games are binary-scored →
reuse the syllogism trend shape):

```ts
// Stats.games gains (SyllogismTrendPoint reused; alias if preferred):
sequence:  { total: number; trend: SyllogismTrendPoint[] };
betterbet: { total: number; trend: SyllogismTrendPoint[] };
```

Implementation: copy the existing syllogism block twice (query
`is_correct, local_day, created_at` with `{count:"exact"}`, `.eq("game_type", <id>)`,
`.limit(TREND_ATTEMPTS)`, group by `local_day` → accuracy). Two queries added
to `getStats()` — same cost class as the existing per-game blocks.

`app/progress/DashboardCharts.tsx`: add `"sequence"` and `"betterbet"` to the
`GameTab` union + `GAME_TABS`, two `gameCardMeta` entries
("Sequence accuracy" / "Better Bet accuracy", empty-state copy), and map their
trends through the **existing AreaChart accuracy branch** (they render exactly
like the syllogism tab). No new chart types.

### 7.2 Achievements — 2 additive catalog entries

`lib/achievements.ts` deltas (pattern-exact):

```ts
// ACHIEVEMENTS catalog (+2):
{ key: "sequence_d3",  name: "Pattern seer",  description: "Solve a difficulty-3 number sequence." },
{ key: "betterbet_10", name: "Sharp bettor",  description: "Get 10 Better Bet calls right." },

// PER_GAME_KEYS (+2):
sequence: "sequence_d3",
betterbet: "betterbet_10",

// PREDICATES (+2):
sequence_d3: (ctx) =>            // facts-only (reveal carries is_correct + difficulty)
  ctx.attemptFacts.is_correct === true &&
  (factNumber(ctx.attemptFacts, "difficulty") ?? 0) >= 3,
betterbet_10: () => tenBetterBetsCorrect(),  // ONE head-count query, mirrors
// twentySyllogismsToday(): count game_attempts where game_type='betterbet'
// and is_correct=true (no local_day filter), >= 10. The just-inserted row is
// already counted (insert precedes afterActivity), same as syllogism_20.
```

Both respect the "facts-only or ≤1 query" rule. `attemptFacts` is the reveal
payload (per `app/api/game/answer/route.ts`), which is why the sequence reveal
includes `difficulty` and both include `is_correct`.

### 7.3 Daily-set & streak behavior — zero changes, confirmed

- Both games' `answer()` flows through the answer route's existing
  `afterActivity({ pillar: "game", gameType, ... })` call →
  `recordActivityAndGetStreak("game")` increments `daily_activity.game_count`
  and keeps the streak/daily-goal semantics — **no code change** (RUNBOOK
  "Adding game #4" step 4, verified against `lib/progression.ts`).
- Rounds per day: **unlimited server-side; a presentational set of 10**
  client-side per game (§4.5/§6) — consistent with syllogism (presentational
  sprint) and n-back (unlimited sessions). Fallacy's *hard* daily set exists
  only because its rounds are finite DB content; these generators are not.

---

## 8. Key decisions

**Syllogism-style explicit round identity in the token (`{f,p}` / `{tpl,p}`),
not n-back-style pure-seed derivation.**
Rationale: `next()` excludes recently-seen combos via a DB read, so the pick
isn't a pure function of the uid; signing the identity keeps `answer()` a pure
recompute. · Trade-off: token payload is a few bytes bigger and leaks the
params (readable base64) — accepted, same stance as syllogism's `form_id`;
answer recovery still requires the app's source. · Alternative: token carries
`{difficulty, k}` where k = index in the seeded candidate stream — smaller
leak surface, but re-deriving "the k-th accepted candidate" couples answer-time
code to pick-time iteration order; rejected for fragility.

**One round at a time, unlimited server-side, presentational set of 10.**
Rationale: matches the deployed flow of the two existing token games; a
server-enforced daily cap would add a per-`next()` count query and an
"exhausted" state for content that cannot exhaust, in a single-user app with
no abuse vector. · Trade-off: "daily set" is honor-system framing, resets on
reload. · Alternative (runner-up): server-enforced 10/day via one
`(game_type, local_day)` count returning `{round:null, reason:"exhausted"}` —
switch if a real pacing requirement ever appears (e.g. shared/multi-user).

**Adaptive difficulty from the last 5 attempts (shared `nextAdaptiveLevel`),
not fixed rotation or per-difficulty mastery tracking.**
Rationale: mirrors n-back's proven one-query progression; keeps both games at
the edge of ability with zero state tables. · Trade-off: the 5-window mixes
difficulties right after a promotion (noisy, self-correcting). · Alternative:
windows filtered to the current level — more precise, more code + a bigger
read; revisit if the ramp feels jumpy in practice.

**Better Bet EVs in integer basis-point units with a payoff-only solved knob.**
Rationale: exact integer classification (no float epsilon bugs), and a peso
knob gives ≤₱1-equivalent EV granularity so every class band — including the
±3% "equal" band — is constructively reachable for all templates. ·
Trade-off: probabilities are constrained to grids (bp steps) and `1-in-k`
values that divide 10⁴. · Alternative: float EVs with an epsilon — rejected;
the dead-zone guarantee (§5.1) would become probabilistic instead of provable.

**Generation targets a class; the classifier remains sole ground truth.**
Rationale: guarantees all three answers occur at controlled frequency
(40/40/20) while keeping scoring independent of generation (a bug in the
nudge loop can shift class frequencies, never correctness). · Trade-off:
rejection/nudge logic is the most intricate code in the feature (~40 lines,
fully unit-tested). · Alternative: sample both options independently and
accept whatever class falls out — rejected: "equal" would almost never occur,
making the third button a trap.

**Distractors from named mistake rules + deterministic fallback ladder.**
Rationale: wrong options must teach (each encodes a real induction error);
random noise makes elimination trivial. · Trade-off: per-family rule authoring
(~an hour, tables in §4.3). · Alternative: pure ±jitter distractors —
rejected, defeats the game's purpose.

---

## 9. Failure & scaling considerations

- **Token failures:** identical to v1 — tampered/expired/wrong-game → 410
  (client silently fetches fresh); invalid family/template/params in a
  verified token → 410 (fails closed, covers renamed ids after a deploy);
  replay → 409 from the unique index (client moves on). Never log token
  contents; log lines follow the existing seam format:
  `[game/answer] type=sequence score=100` (already emitted by the route for
  non-fallacy games — zero route changes).
- **Idempotency:** attempts append-only; double-submit blocked by
  `round_uid`; achievements unlock via upsert-ignore (existing path);
  XP written once on the attempt row.
- **DB-down behavior:** `next()` for both games needs one read (recent hashes
  + adaptive level) — on Supabase failure the route 500s cleanly like
  syllogism's `recentHashes` failure does today. Acceptable; do NOT fail open
  to an unexcluded pick (keeps behavior predictable and the code one path).
- **Determinism drift:** the only cross-request contract is
  `(id, p, uid) → identical round` between `next()` and `answer()`. Guarded
  by pure engines + determinism tests; a deploy *between* next and answer can
  at worst 410 a live round (family renamed/range narrowed) — same accepted
  blast radius as syllogism.
- **Value overflow / degenerate rounds:** family constraints cap all sequence
  values at |v| ≤ 20,000 (test-swept over the full 11,078-round pool);
  betterbet EV_bp maxes ≈ 80,000·10⁴ ≪ 2⁵³ (safe integers).
- **PostgREST 1000-row cap:** the new `next()` reads are `.limit(300)`/
  `.limit(5)` — unaffected. The known long-horizon `getXpTotal()` truncation
  (RUNBOOK "Common failures") is unchanged by this feature.
- **Growth:** two more `getStats()` queries (indexed by
  `game_attempts_type_day_idx`); everything else rides existing paths. No new
  cron, no new infra.

---

## 10. Test plan (mirrors `tests/lib/syllogism.test.ts` / `nback-engine.test.ts`)

**`tests/lib/sequence.test.ts`** (new):

- *Bank shape:* 13 families, unique ids, difficulty split 3/4/6, param ranges
  well-formed (lo ≤ hi), `shown` ∈ {4,5}, every family has a non-empty
  `explain` output.
- *Hand-checked fixtures* (the validity-table equivalent): ≥2 fixtures per
  family — explicit `p` → expected shown terms AND expected correct next term,
  hand-computed in the test file. Edits to a family require re-verifying by a
  human, not updating to match.
- *Full-pool sweep* (all 11,078 combos, fixed uid): options length 4, pairwise
  distinct, contain `correct` exactly once, no option equals a shown term
  unless via documented fallback, all values |v| ≤ 20,000, all integers.
- *Determinism:* same `(f, p, uid)` → identical terms + options order (twice);
  different uid → same terms, (typically) different order.
- *Distractor rules:* per-family spot checks that the named mistakes appear
  (e.g. quadratic round contains `prev + Δlast`); constructed collision case
  proves the fallback ladder fills to exactly 3.
- *`nextAdaptiveLevel` table:* <5 attempts holds; 4/5 promotes; 2/5 demotes;
  caps/floors at 3/1.
- *`pickRound`:* respects recent-hash exclusion; accepts a repeat after
  MAX_PICK_TRIES (seeded `rand` forcing collisions).

**`tests/lib/betterbet.test.ts`** (new):

- *Bank shape:* 12 templates, unique ids, tiers 4/4/4, knob is a peso param
  for every template, `insight` non-empty.
- *EV fixtures* (hand-checked table): ≥2 per template — explicit `p` →
  expected integer `EV_bp` for both options and expected class. Includes both
  negative-EV templates and a `long_shot` `1-in-500` case.
- *Classifier boundaries:* exact-equal → equal; relDiff 0.049 → equal; 0.05 →
  not equal; both-zero → equal; negative pairs (−F vs −pV) pick the less
  negative.
- *Class reachability sweep:* ≥3,000 seeded rounds per tier → all three
  classes occur, frequencies within ±10 pts of 40/40/20; **zero rounds in the
  dead zone** (0.03 ≤ relDiff ≤ 0.10); every emitted class ==
  `classify(evA, evB)`.
- *Determinism:* same `(tpl, p, uid)` → identical scenario, options,
  EVs, class, explanation.
- *Explanation:* contains both formatted EV amounts and the verdict line for
  each class (incl. the "within 5%" phrasing and expected-loss framing).

**`tests/routes/game.test.ts`** (additive cases, mirroring existing
nback/syllogism route cases):

- `GET /api/game/next?type=sequence|betterbet` → 200 round with token,
  **asserting the absence** of `correct_value` / `correct` / `ev_a` / `ev_b` /
  `explanation` keys (anti-cheat contract).
- `POST /api/game/answer` per game: happy path (mock insert; response has
  reveal + `streak/xp_*` fields); tampered token → 410; expired token → 410;
  mocked `23505` insert → 409; out-of-range params in a validly-signed token →
  410; bad body (choice 5, choice "c") → 400.
- Registry: `getGame("sequence")` / `getGame("betterbet")` resolve;
  `listGameMeta()` returns 5 entries (hub smoke).

**`tests/lib/xp.test.ts` + achievements tests** (additive): `sequenceXp` /
`betterBetXp` ranges (10–25); `sequence_d3` facts-only predicate truth table;
`betterbet_10` mocked count ≥/< 10; `candidateKeys` includes the new per-game
keys for the new game types.

**`tests/lib/stats.test.ts`** (additive): mock the two new per-game queries;
assert `stats.games.sequence/betterbet` shapes; existing assertions untouched.

Manual pass: play both games on mobile viewport; force a 410 (wait out TTL)
and a 409 (double-submit via devtools) and confirm silent recovery; confirm
hub shows 5 cards; confirm `/progress` tabs render both new trends; re-run the
full suite — all pre-existing tests must pass unmodified except the additive
mock extensions listed above.

---

## 11. Build sequence (one engineer session)

1. `lib/games/types.ts` — widen `GameType` (+2). Compile will now point at
   every switch that needs the new arms — none exist outside the files below.
2. `lib/xp.ts` — `sequenceXp`, `betterBetXp` (+ xp tests).
3. `lib/games/adaptive.ts` — `nextAdaptiveLevel` (+ tests).
4. `lib/games/sequence/families.ts` + `engine.ts` + `tests/lib/sequence.test.ts`
   (bank → fixtures → sweep; the bulk of the authoring work).
5. `lib/games/betterbet/templates.ts` + `engine.ts` +
   `tests/lib/betterbet.test.ts` (EV math → classifier → class construction →
   text builders).
6. `lib/games/sequence/index.ts` + `lib/games/betterbet/index.ts`
   (GameDefinitions — copy `syllogism/index.ts` structure) +
   `lib/games/registry.ts` entries + additive `tests/routes/game.test.ts`
   cases.
7. `lib/achievements.ts` — catalog/trigger/predicates delta (+ tests).
8. `app/game/sequence/{page,SequenceClient}.tsx` +
   `app/game/betterbet/{page,BetterBetClient}.tsx` (copy syllogism UI pattern).
9. `lib/stats.ts` per-game blocks + `app/progress/DashboardCharts.tsx` tabs
   (+ additive stats test mocks).
10. Full suite green; manual pass per §10. **No schema step, no deploy-order
    constraint** — this feature is safe to ship code-first (unlike v1's
    schema-before-code rule, which still applies to the v1 delta itself).
