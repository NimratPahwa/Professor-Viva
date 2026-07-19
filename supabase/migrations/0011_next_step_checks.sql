-- Professor Viva — The Professor's Stage (Screen 5): persisted checkbox state.
--
-- On the unlocked report, the next steps render as checkboxes the founder ticks
-- off as they act. That checked-state must persist per user, so returning to the
-- report shows their progress. This table stores one row per
-- (account, verdict, step_index); the unique constraint makes a PUT idempotent
-- (upsert on conflict), so a re-check is a no-op rather than a duplicate.
--
-- Keyed on the deep verdict row (the paid report's next steps live on
-- verdicts.next_steps). Both FKs cascade on delete so a removed account or a
-- re-run verdict doesn't orphan check rows. No verdict/score is touched — this
-- is pure UI state, not pipeline data.

create table if not exists next_step_checks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  verdict_id uuid not null references verdicts(id) on delete cascade,
  step_index int not null check (step_index >= 0),
  checked boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (account_id, verdict_id, step_index)
);

create index if not exists next_step_checks_lookup_idx
  on next_step_checks(account_id, verdict_id);

grant select, insert, update, delete on next_step_checks to service_role;
