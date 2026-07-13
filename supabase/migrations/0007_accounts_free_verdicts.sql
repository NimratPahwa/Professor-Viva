-- Professor Viva — Step 11.5: freemium two-tier gate (FR-1.9, FR-1.11, FR-1.12).
--
-- Freemium (01-PRD business model): the verdict is FREE, the full report is PAID.
-- Every visitor gets ONE free verdict per idea, per account — a score, a
-- BUILD/PIVOT/BURY verdict, and a roast, produced by a quick evidence pass. A
-- second free verdict on the same (account, idea) is blocked pending unlock.
--
-- This migration adds the lightweight-account identity (FR-1.12) and the
-- free-verdict ledger that enforces the one-per-(account, idea) rule (FR-1.9).
-- The paid unlock reuses the Step-11 purchases / validation_runs ledger
-- (migration 0006) unchanged — no schema change there.
--
-- The quick pass's SHALLOW evidence is NOT written to the `evidence` table: it
-- lives only in free_verdicts.payload as jsonb. The deep evidence run (paid)
-- remains the sole writer of the `evidence` table, so the two passes never mix
-- in deterministic scoring. See lib/quick-evidence.js.

-- Lightweight account: a stable external reference (email, anon token, handle)
-- identifies the user so the per-account rules can be enforced. No auth yet —
-- RLS stays deferred exactly as in migration 0001.
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  external_ref text not null unique,
  created_at timestamptz not null default now()
);

-- Link an idea to the account that submitted it (FR-1.12). Nullable so ideas
-- created before this step (and the ungated test/batch paths) still work.
alter table ideas add column if not exists account_id uuid references accounts(id) on delete set null;
create index if not exists ideas_account_id_idx on ideas(account_id);

-- The free-verdict ledger. The unique (account_id, idea_id) constraint is the
-- durable enforcement of "one free verdict per idea, per account" (FR-1.9): a
-- second attempt hits the constraint / the pre-check and is blocked pending
-- unlock. `payload` carries the shallow quick-pass sections (evidence claims,
-- scores, shallow next steps, competitive analysis, ordered teasers) so the free
-- screen renders from that user's OWN real content — never fabricated (FR-1.11).
create table if not exists free_verdicts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  idea_id uuid not null references ideas(id) on delete cascade,
  verdict text not null check (verdict in ('BUILD', 'PIVOT', 'BURY')),
  total_score numeric not null check (total_score >= 0 and total_score <= 100),
  roast text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (account_id, idea_id)
);

create index if not exists free_verdicts_idea_id_idx on free_verdicts(idea_id);
create index if not exists free_verdicts_account_id_idx on free_verdicts(account_id);

grant select, insert, update, delete on accounts, free_verdicts to service_role;
