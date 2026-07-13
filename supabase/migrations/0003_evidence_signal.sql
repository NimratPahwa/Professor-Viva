-- Professor Viva — Step 4 (scoring engine): evidence polarity enrichment.
--
-- The scoring engine (03-AI Rules §3) must derive per-dimension scores in
-- pure code from stored evidence. Raw claim COUNTS are not enough: for some
-- dimensions more claims mean a WORSE case (e.g. many competitor claims => a
-- crowded market => a weaker market_gap), so a count-only model would invert
-- the verdict. Architecture §3 stage 3 says scoring uses "evidence counts AND
-- signals" — this column is that signal.
--
-- `signal` records, per claim, whether the sourced fact strengthens or
-- weakens the case for building THIS idea on THAT dimension:
--   supports    — good news for the idea on this dimension
--   undermines  — bad news for the idea on this dimension
--   neutral     — sourced/relevant but not directionally good or bad
--
-- The LLM only classifies evidence into these buckets; it never assigns a
-- score. The numeric score is computed from these buckets in pure code
-- (lib/scoring.js), preserving "no LLM ever assigns a score" (CLAUDE.md).

alter table evidence
  add column if not exists signal text not null default 'neutral'
    check (signal in ('supports', 'neutral', 'undermines'));
