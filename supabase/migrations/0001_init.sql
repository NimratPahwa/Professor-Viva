-- Professor Viva — Step 2 data layer (Layer 1 / Validator scope only)
-- Matches 02-professor-viva-architecture.md §6.
-- apps, metrics_snapshots, viva_memory are Layer 2/3 tables — out of scope
-- for this step per the 12-step gap-closure plan.
--
-- RLS is intentionally NOT enabled yet: there is no auth/owner concept in
-- the Step 1 intake schema, so per-user policies (Architecture §7) have
-- nothing to key off. This is deferred to whichever step introduces auth,
-- not skipped silently — flagged here so it isn't forgotten.

create extension if not exists pgcrypto;

create table if not exists ideas (
  id uuid primary key default gen_random_uuid(),
  problem text not null,
  audience text not null,
  monetization_hypothesis text not null,
  unfair_advantage text not null,
  clarifying_questions jsonb not null default '[]'::jsonb,
  status text not null default 'intake'
    check (status in ('intake', 'evidence_gathering', 'scoring', 'verdict', 'complete')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists evidence (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references ideas(id) on delete cascade,
  dimension text not null
    check (dimension in ('demand', 'market_gap', 'monetization', 'founder_fit', 'timing')),
  claim text not null,
  source_url text not null,
  retrieved_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists evidence_idea_id_idx on evidence(idea_id);

create table if not exists scores (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references ideas(id) on delete cascade,
  dimension text not null
    check (dimension in ('demand', 'market_gap', 'monetization', 'founder_fit', 'timing')),
  score numeric not null check (score >= 0 and score <= 100),
  rubric_version text not null,
  created_at timestamptz not null default now()
);

create index if not exists scores_idea_id_idx on scores(idea_id);

create table if not exists verdicts (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references ideas(id) on delete cascade,
  verdict text not null check (verdict in ('BUILD', 'PIVOT', 'BURY')),
  total_score numeric not null check (total_score >= 0 and total_score <= 100),
  threshold_version text not null,
  voice_pass_output text,
  card_asset_url text,
  created_at timestamptz not null default now()
);

create index if not exists verdicts_idea_id_idx on verdicts(idea_id);
