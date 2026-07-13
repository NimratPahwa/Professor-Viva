-- Professor Viva — next steps on the verdict row (FR-1.4 / 03-AI Rules §3.1).
-- Exactly 3 concrete, evidence-grounded actions, rendered in Viva's voice at the
-- same sarcasm dial as the verdict, produced by a second structured pass during
-- the delivery stage. Stored as a JSON array alongside voice_pass_output; the
-- two-pass rule still holds (verdict/total_score/threshold_version untouched).

alter table verdicts
  add column if not exists next_steps jsonb not null default '[]'::jsonb;
