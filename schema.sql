-- ============================================================================
-- Talasin — Supabase / Postgres schema
-- ----------------------------------------------------------------------------
-- Single-user "mental gym" PWA. Applied BY HAND to Supabase (SQL editor).
-- Idempotent: safe to run top-to-bottom repeatedly.
--
-- Access posture (see DESIGN.md §2.7):
--   * RLS is ENABLED on every table with NO permissive policies for anon /
--     authenticated → the public anon key can read/write nothing.
--   * The app connects ONLY with the service-role key (server-side), which
--     BYPASSES RLS. The anon key is never shipped to the browser.
-- ============================================================================

-- gen_random_uuid() lives in pgcrypto. On Supabase it is usually pre-installed;
-- create it defensively so this file runs on a bare Postgres too.
create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 2.2  fallacy_types — reference list of fallacies (small, seeded)
-- ----------------------------------------------------------------------------
create table if not exists fallacy_types (
  key         text primary key,
  label       text        not null,
  short_def   text        not null,
  sort_order  smallint
);

-- ----------------------------------------------------------------------------
-- 2.1  fallacy_rounds — cached game content (filled by top-up)
-- ----------------------------------------------------------------------------
create table if not exists fallacy_rounds (
  id            uuid primary key default gen_random_uuid(),
  fallacy_key   text        not null,
  argument_text text        not null,
  choices       jsonb       not null,   -- [{ key, label }] × 4, incl. the correct one
  correct_key   text        not null,   -- must equal one choices[].key (normally = fallacy_key)
  explanation   text        not null,
  difficulty    smallint    not null default 1,   -- 1..3
  content_hash  text        not null,   -- sha256(normalize(argument_text)); dedupe guard
  gen_batch_id  uuid,
  gen_model     text,
  status        text        not null default 'active',   -- 'active' | 'retired' | 'needs_review'
  created_at    timestamptz not null default now(),
  constraint fallacy_rounds_content_hash_key unique (content_hash),
  constraint fallacy_rounds_difficulty_chk   check (difficulty between 1 and 3),
  constraint fallacy_rounds_status_chk       check (status in ('active', 'retired', 'needs_review')),
  -- Structural invariants on the choices/answer (DESIGN.md §2.1):
  --  * choices is a JSON array of exactly 4 elements
  --  * correct_key appears as one of the choices' keys
  constraint chk_placeholder_removed check (true)
);

-- The inline CHECK above can't express the array logic portably, so define the
-- real constraints separately and idempotently. (Postgres has no
-- "add constraint if not exists", so guard with a catalog lookup.)
alter table fallacy_rounds drop constraint if exists chk_placeholder_removed;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'fallacy_rounds_choices_len4'
  ) then
    alter table fallacy_rounds
      add constraint fallacy_rounds_choices_len4
      check (jsonb_typeof(choices) = 'array' and jsonb_array_length(choices) = 4);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'fallacy_rounds_correct_in_choices'
  ) then
    -- NOTE: Postgres forbids subqueries in CHECK constraints ("cannot use
    -- subquery in check constraint"), so this uses jsonb containment instead:
    -- the choices array must contain an element whose "key" = correct_key.
    alter table fallacy_rounds
      add constraint fallacy_rounds_correct_in_choices
      check (choices @> jsonb_build_array(jsonb_build_object('key', correct_key)));
  end if;
end
$$;

create index if not exists fallacy_rounds_status_idx          on fallacy_rounds (status);
create index if not exists fallacy_rounds_status_created_idx  on fallacy_rounds (status, created_at);
create index if not exists fallacy_rounds_fallacy_key_idx     on fallacy_rounds (fallacy_key);

-- ----------------------------------------------------------------------------
-- 2.3  game_attempts — one row per answered round (append-only)
-- ----------------------------------------------------------------------------
create table if not exists game_attempts (
  id          uuid primary key default gen_random_uuid(),
  round_id    uuid        not null references fallacy_rounds (id),
  chosen_key  text        not null,
  is_correct  boolean     not null,   -- derived server-side at insert
  fallacy_key text        not null,   -- denormalized from round for cheap grouping
  answered_ms integer,                -- time-to-answer in ms (optional analytics)
  local_day   date        not null,   -- Asia/Manila calendar day — drives streak
  created_at  timestamptz not null default now()
);

create index if not exists game_attempts_local_day_idx   on game_attempts (local_day);
create index if not exists game_attempts_fallacy_key_idx on game_attempts (fallacy_key);
create index if not exists game_attempts_round_id_idx    on game_attempts (round_id);

-- ----------------------------------------------------------------------------
-- 2.4  interview_prompts — the pitch/interview questions (seeded)
-- ----------------------------------------------------------------------------
create table if not exists interview_prompts (
  id          uuid primary key default gen_random_uuid(),
  prompt_text text        not null,
  category    text,                    -- 'behavioral' | 'pitch' | 'technical'
  status      text        not null default 'active',
  created_at  timestamptz not null default now(),
  constraint interview_prompts_status_chk check (status in ('active', 'retired'))
);

create index if not exists interview_prompts_status_idx on interview_prompts (status);

-- ----------------------------------------------------------------------------
-- 2.5  interview_attempts — transcript + scores ONLY (audio discarded)
-- ----------------------------------------------------------------------------
-- Schema-level enforcement of transcribe-then-discard: NO audio column, NO
-- bytea, NO storage-path column. The only artifact of a recording is the
-- transcript text and the numeric scores below.
create table if not exists interview_attempts (
  id                     uuid primary key default gen_random_uuid(),
  prompt_id              uuid references interview_prompts (id),
  transcript             text        not null,   -- ONLY persisted representation of the utterance
  filler_count           integer     not null default 0,
  words_per_minute       numeric(5,1),
  clarity_score          smallint,               -- 0..100
  overall_delivery_score smallint,               -- 0..100, model's single-number verdict (drives the trend line)
  structure_note         text,
  coaching               text,
  duration_sec           numeric(6,1),
  local_day              date        not null,   -- drives streak
  created_at             timestamptz not null default now(),
  constraint interview_attempts_clarity_chk  check (clarity_score is null or clarity_score between 0 and 100),
  constraint interview_attempts_delivery_chk check (overall_delivery_score is null or overall_delivery_score between 0 and 100)
);

-- Additive migration for databases created before overall_delivery_score existed
-- (idempotent: "if not exists" on the column, guarded add for the check).
alter table interview_attempts add column if not exists overall_delivery_score smallint;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'interview_attempts_delivery_chk'
  ) then
    alter table interview_attempts
      add constraint interview_attempts_delivery_chk
      check (overall_delivery_score is null or overall_delivery_score between 0 and 100);
  end if;
end
$$;

create index if not exists interview_attempts_local_day_idx on interview_attempts (local_day);

-- ----------------------------------------------------------------------------
-- 2.6  daily_activity — materialized streak helper (one row per active day)
-- ----------------------------------------------------------------------------
create table if not exists daily_activity (
  local_day       date primary key,
  game_count      integer     not null default 0,
  interview_count integer     not null default 0,
  updated_at      timestamptz not null default now()
);

-- ============================================================================
-- RLS: deny-all to anon / authenticated. service_role bypasses RLS.
-- (No policies are created → those roles are denied by default.)
-- ============================================================================
alter table fallacy_types      enable row level security;
alter table fallacy_rounds     enable row level security;
alter table game_attempts      enable row level security;
alter table interview_prompts  enable row level security;
alter table interview_attempts enable row level security;
alter table daily_activity     enable row level security;

-- Deliberately NO "force row level security": FORCE subjects even the table
-- owner to RLS, which breaks this file's own seed INSERTs and backfill UPDATEs
-- when run from the Supabase SQL editor (owner role, no policies → denied /
-- silently no-op'd). ENABLE with zero policies already denies anon and
-- authenticated completely; service_role bypasses RLS via its BYPASSRLS
-- attribute. Do not re-add FORCE — it makes the file non-re-runnable by hand.

-- ============================================================================
-- Seed: fallacy_types (the 12 taxonomy keys from AI_DESIGN.md §2.2, plus a few
-- common extras for richer review labels). Idempotent via ON CONFLICT.
-- ============================================================================
insert into fallacy_types (key, label, short_def, sort_order) values
  ('strawman',             'Straw Man',              'Misrepresenting an opponent''s argument to make it easier to attack.', 1),
  ('ad_hominem',           'Ad Hominem',             'Attacking the person making the argument instead of the argument itself.', 2),
  ('false_cause',          'False Cause',            'Assuming that because B followed A, A must have caused B.', 3),
  ('appeal_to_authority',  'Appeal to Authority',    'Claiming something is true because an authority or celebrity said so, especially an irrelevant one.', 4),
  ('slippery_slope',       'Slippery Slope',         'Asserting one small step will inevitably lead to extreme consequences.', 5),
  ('false_dilemma',        'False Dilemma',          'Presenting only two options when more actually exist.', 6),
  ('hasty_generalization', 'Hasty Generalization',   'Drawing a broad conclusion from too few or unrepresentative cases.', 7),
  ('circular_reasoning',   'Circular Reasoning',     'Assuming the conclusion within the premise (begging the question).', 8),
  ('appeal_to_emotion',    'Appeal to Emotion',      'Using fear, pity, or flattery in place of a real reason.', 9),
  ('bandwagon',            'Bandwagon',              'Claiming something is right or true because everyone does or believes it.', 10),
  ('red_herring',          'Red Herring',            'Introducing an irrelevant distraction from the real issue.', 11),
  ('tu_quoque',            'Tu Quoque',              'Dismissing a claim because the speaker doesn''t practice what they preach.', 12)
on conflict (key) do update set
  label      = excluded.label,
  short_def  = excluded.short_def,
  sort_order = excluded.sort_order;

-- ============================================================================
-- Seed: interview_prompts (static MVP list — DESIGN.md §2.4).
-- Idempotent: only insert a prompt if the same text isn't already present.
-- ============================================================================
insert into interview_prompts (prompt_text, category)
select v.prompt_text, v.category
from (values
  ('Tell me about a time you handled a tight deadline.',                          'behavioral'),
  ('Describe a conflict you had with a teammate and how you resolved it.',        'behavioral'),
  ('Tell me about a project you are proud of and what your role was.',            'behavioral'),
  ('Describe a time you failed. What did you learn?',                             'behavioral'),
  ('Tell me about a time you had to learn something new quickly.',                'behavioral'),
  ('Walk me through a difficult decision you made with limited information.',      'behavioral'),
  ('Give me your 60-second pitch for what you do and the value you bring.',       'pitch'),
  ('Pitch a product or project you have built as if I were a potential client.', 'pitch'),
  ('Why should we hire you over other candidates?',                              'pitch'),
  ('Explain a technical concept you know well to a non-technical audience.',      'technical'),
  ('Describe your approach to debugging a problem you have never seen before.',   'technical'),
  ('How do you decide between building something yourself versus using a tool?',  'technical')
) as v(prompt_text, category)
where not exists (
  select 1 from interview_prompts ip where ip.prompt_text = v.prompt_text
);

-- ============================================================================
-- v1 delta (DESIGN_V1.md §2) — all additive + idempotent. Wave B lands the
-- ENTIRE v1 schema (including Wave C's tables, which stay inert until used).
-- Safe to re-run top-to-bottom against a DB that already holds MVP data.
-- ============================================================================

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
  -- a schema change. The registry (lib/games/registry.ts) is the source of truth
  -- for valid types.
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

-- v1: interview_prompts — category CHECK + ~12 additional seeds ---------------
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
  -- negotiation
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

-- v1: interview_attempts — STAR flags + structure score + XP ------------------
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

-- v1: achievements — unlock log (catalog lives in lib/achievements.ts) --------
create table if not exists achievements (
  key         text primary key,                 -- e.g. 'streak_7'
  unlocked_at timestamptz not null default now(),
  context     jsonb                             -- snapshot of what unlocked it (optional)
);
alter table achievements enable row level security;  -- no FORCE (see RLS note above)

-- v1: login_attempts — durable login limiter (per security review) ------------
create table if not exists login_attempts (
  id           bigint generated always as identity primary key,
  ip           text        not null,
  success      boolean     not null,
  attempted_at timestamptz not null default now()
);
create index if not exists login_attempts_ip_time_idx on login_attempts (ip, attempted_at);
alter table login_attempts enable row level security;  -- no FORCE (see RLS note above)
