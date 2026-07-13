-- Professor Viva — Step 2 fix: grant service_role access to Step 1 tables.
-- Supabase auto-grants privileges to service_role/anon/authenticated only
-- for tables created through its own tooling; tables created via raw SQL
-- need this explicitly.

grant select, insert, update, delete on ideas, evidence, scores, verdicts to service_role;
