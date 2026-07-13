# Professor Viva — Working Rules

## Before any task
- Read /docs/01-professor-viva-prd.md, /docs/02-professor-viva-architecture.md,
  and /docs/03-professor-viva-ai-rules.md before writing or changing code.
- 03 (AI Rules) is the source of truth for anything Viva says: personality,
  sarcasm dial, guardrails, verdict thresholds.

## How we work
- We follow the 12-step gap-closure plan, one step at a time.
- Never start a step until the previous step's "Done When" check has passed
  and been shown to me.
- Never skip ahead, never batch multiple steps without asking.
- Verdict logic and scoring are pure code — no LLM ever assigns a score
  or verdict.

## Stack decisions (do not change without asking)
- Supabase for data, Stripe for payments ($79 one-time),
  Claude API for evidence gathering and voice.
