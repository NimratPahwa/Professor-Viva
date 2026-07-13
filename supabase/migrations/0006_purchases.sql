-- Professor Viva — Step 11: Stripe checkout + entitlement (FR-1.7).
--
-- One-time purchase (NOT a subscription) via Stripe Checkout Sessions.
-- A purchase record stores the Stripe Price ID, currency, and amount so the
-- founding→list price transition (₹1,499/$39 → ₹2,999/$79) is a config change,
-- never a schema change. Amounts are stored as the Stripe minor unit (paise /
-- cents) exactly as Stripe reports them, alongside the human currency code.
--
-- Entitlement (FR-1.7): one paid purchase buys the initial validation run plus
-- one free re-validation for that idea — two runs total. The third run is
-- blocked pending a new purchase. validation_runs is the durable ledger the
-- entitlement check counts against; the rule is identical for both currencies.

create table if not exists purchases (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references ideas(id) on delete cascade,
  stripe_session_id text not null unique,
  stripe_price_id text,
  currency text not null check (currency in ('inr', 'usd')),
  amount numeric,
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists purchases_idea_id_idx on purchases(idea_id);

create table if not exists validation_runs (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references ideas(id) on delete cascade,
  purchase_id uuid references purchases(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists validation_runs_idea_id_idx on validation_runs(idea_id);

grant select, insert, update, delete on purchases, validation_runs to service_role;
