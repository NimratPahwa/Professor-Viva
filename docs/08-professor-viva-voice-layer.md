# Professor Viva — Two-Pass Voice Layer (Step 6 of gap-closure plan)
**Companion docs:** 01-PRD · 02-Architecture (§3 stage 4) · 03-AI Rules (§1, §2, §4, §5)

---

## 1. Principle

The verdict and every score are already decided by **pure code** (Steps 4–5).
Step 6 is the **second pass**: a single top-tier Claude call that renders that
fixed decision in Viva's voice. Per the 03-AI Rules §5 two-pass rule, scores and
the verdict enter the prompt as **read-only facts to narrate** — never as
editable values. The model chooses words; it never touches numbers. Nothing in
this layer can change a score or flip a verdict.

## 2. What is injected in code (not left to the model)

| Element | Value | Source |
|---|---|---|
| Sarcasm dial | BUILD 8 · PIVOT 8 · BURY 6 | 03-AI Rules §2 (verdict delivery 8/10; BURY 6/10) |
| Standing footer | verbatim §4.6 line, appended in code | 03-AI Rules §4.6 / guardrail 6 |
| Model | `claude-opus-4-6` | 03-AI Rules §5 model allocation (top-tier for voice) |
| Voice prompt version | `voice-1.0.0` | 03-AI Rules §5 versioning |

The dial and footer are code-controlled so a prompt regression can never drop
the advisory disclaimer or mis-set the tone (§2: "never left to the model's
judgment").

## 3. Prompt stack (03-AI Rules §5)

Assembled per request by `lib/viva-voice.js` (`buildSystemPrompt`):

1. **viva_core_identity** — character, four voice pillars, hard guardrails
   (no fabrication, no punching down, no false hope, no competitor defamation,
   "you do not assign or change scores").
2. **viva_context_dial** — the numeric §2 dial for this verdict.
3. **task_instructions** — verdict-specific delivery, always ending with a
   "door" (BUILD: earned sincerity; PIVOT: name the specific pivot; BURY:
   salvageable insight or adjacent direction).
4. **evidence_block** — the retrieved, sourced claims grouped by dimension,
   each tagged with its polarity signal and source URL. Scores appear here only
   as read-only context. This is the only set of facts the model may cite
   (pillar 2 — every roast carries a receipt).
5. **output_contract** — plain prose only; no headings, lists, score numbers,
   or self-authored disclaimer.

## 4. Endpoint & persistence

`POST /ideas/:id/voice` loads the **latest existing verdict row** (from Step 5),
recomputes scores deterministically for the evidence block, runs the voice pass,
and writes **only** `voice_pass_output`, `voice_prompt_version`, and `next_steps`
back onto that row via `updateVerdictVoice`. `verdict`, `total_score`, and
`threshold_version` are never touched — the two-pass immutability guarantee.
Returns 409 if no verdict exists yet. As of Step 9 the delivery stage also sets
`card_asset_url` (the shareable card, FR-1.5). Idea status is left at `verdict` by
this standalone trigger; the full pipeline runner advances it to `complete`.

**Next steps (FR-1.4 / §3.1).** After the voice prose is screened, the delivery
stage runs a **second structured pass** (`renderNextSteps`) that returns exactly
3 concrete, evidence-grounded actions at the **same dial the voice reply
ultimately used** (`guarded.dialUsed`, so a sensitive-input dial-0 verdict also
gets dial-0 steps). The joined steps are re-screened by the same G1/G2 filter and
regenerate once at dial 0 on any violation. The array persists on the verdict row
as `next_steps` and is returned by the endpoint.

## 5. Done-When

`scripts/test-voice.js`:
- **Part A (hermetic):** dial mapping (8/8/6), verbatim footer, and prompt-stack
  assembly — evidence claims + source URLs + polarity present, the
  "don't change scores" and "no fabrication" guardrails present, and the numeric
  dial injected.
- **Part B (real endpoint):** the 49.5 → BURY fixture is decided via Step 5, then
  voiced via `POST /ideas/:id/voice`. Confirms the BURY dial (6) and prompt
  version were used, the standing footer is appended, the prose is non-empty,
  and — critically — the persisted `verdict`/`total_score`/`threshold_version`
  are **unchanged** by the voice pass, with only the voice fields written.
