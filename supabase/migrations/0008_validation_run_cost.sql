-- Professor Viva — measured API cost per deep validation run (cost tracking).
--
-- The deep run's real token + web_search spend (from response.usage on every
-- Claude call in the pipeline) is priced by lib/usage-meter.js and persisted on
-- the validation_runs ledger row that entitled the run. cost_usd is the priced
-- total; the token/search counts are stored alongside so the price can be
-- recomputed if the rate table changes, and usage_detail keeps the per-call and
-- per-model breakdown for auditing.

alter table validation_runs
  add column if not exists input_tokens bigint,
  add column if not exists output_tokens bigint,
  add column if not exists web_search_requests integer,
  add column if not exists cost_usd numeric,
  add column if not exists usage_detail jsonb;
