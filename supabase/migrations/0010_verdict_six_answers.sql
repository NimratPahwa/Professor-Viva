-- Professor Viva — The Professor's Stage (Screen 5, "The Six Answers").
--
-- The unlocked report is restructured as six answers. Answers 1–4 render
-- deterministically at display time from existing evidence + the deterministic
-- competitive assembly, so they need no new storage. Answers 5 & 6 are the two
-- GENERATED action fields the deep run must ALWAYS produce:
--   - acquisition   (Answer 5, "your first ten customers") — a concrete
--                   acquisition plan grounded in the real demand channels
--                   captured on evidence rows (migration 0009).
--   - first_revenue (Answer 6, "your first dollar") — a first-revenue path
--                   grounded in comparable pricing evidence (monetization dim).
--
-- These are schema-enforced non-empty in code (lib/viva-voice.js SixAnswersSchema)
-- so a run can never silently omit them. Stored together as one jsonb object so
-- the report can add answer fields later without another migration, and so a
-- verdict row without a deep run simply has null (free/quick verdicts don't
-- produce them).
--
-- Still a voice-side field (like next_steps): written on the verdict row during
-- the delivery stage. No verdict/score column is touched — the two-pass rule
-- (03-AI Rules §5) holds; the model narrates actions, it never sets a number.

alter table verdicts
  add column if not exists six_answers jsonb;
