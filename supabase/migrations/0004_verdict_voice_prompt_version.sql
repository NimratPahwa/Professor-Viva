-- Step 6 (two-pass voice layer).
-- 03-AI Rules §5: "every verdict row records the prompt versions that produced
-- it. Personality changes are A/B testable against share rate without touching
-- the pipeline." verdicts.voice_pass_output already exists (0001_init); this
-- adds the version of the voice prompt stack that rendered it.
alter table verdicts
  add column if not exists voice_prompt_version text;
