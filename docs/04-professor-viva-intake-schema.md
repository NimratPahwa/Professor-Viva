# Professor Viva — Intake Schema (Step 1 of gap-closure plan)
**Companion docs:** 01-PRD (FR-1.1) · 02-Architecture (§3 stage 1) · 03-AI Rules

---

## 1. Purpose

Replaces the current single free-text `idea` field with the structured intake
required by FR-1.1: problem, audience, monetization hypothesis, founder's
unfair advantage — plus a bounded clarifying-question exchange (max 3)
before evidence gathering (Step 3) begins.

This document is the schema of record. The machine-readable version lives in
`lib/intake-schema.js`.

---

## 2. Fields

| Field | Type | Required | Length (trimmed) | Notes |
|---|---|---|---|---|
| `problem` | string | yes | 10–1000 chars | The problem being solved. Maps to PRD "problem". |
| `audience` | string | yes | 5–500 chars | Who has the problem. Maps to PRD "audience". |
| `monetization_hypothesis` | string | yes | 10–1000 chars | How this makes money. Maps to PRD "monetization hypothesis". |
| `unfair_advantage` | string | yes | 5–1000 chars | Founder's stated edge. Scored later under Founder Fit (03-AI Rules §3, 15% weight). |
| `clarifying_questions` | array | no (defaults to `[]`) | 0–3 items | Bounded per FR-1.1 ("Max 3 clarifying questions before analysis begins"). |
| `clarifying_questions[].question` | string | yes (if item present) | 5–300 chars | Question Viva asked. |
| `clarifying_questions[].answer` | string | yes (if item present) | 1–1000 chars | Founder's answer. |

No field accepts HTML/markup — plain text only. All string fields are
trimmed before length validation.

---

## 3. Validation rules

1. All four top-level fields (`problem`, `audience`, `monetization_hypothesis`,
   `unfair_advantage`) are required and must be non-empty after trimming.
2. `clarifying_questions`, if present, must be an array of **0 to 3** items —
   a 4th item is a hard validation error (enforces the FR-1.1 cap in code,
   not just in the prompt).
3. Each clarifying-question item must have both `question` and `answer`
   populated — a question without an answer is invalid (can't proceed to
   evidence gathering on a half-answered exchange).
4. Validation failures return a list of `{ field, message }` errors — never a
   single opaque failure — so the intake UI can point at the specific field.
5. Validation is pure code, no LLM involvement (consistent with the
   verdict/scoring boundary in 02-Architecture §2 principle 2).

---

## 4. Example valid payload

```json
{
  "problem": "Small contractors lose 10+ hours a week reconciling paper change orders against invoices.",
  "audience": "Independent general contractors running 2-10 active residential jobs at a time.",
  "monetization_hypothesis": "Usage-based SaaS, $49/mo per active job site, billed monthly.",
  "unfair_advantage": "Ten years running field ops for a mid-size GC; personal relationships with 40+ contractors who've asked for this.",
  "clarifying_questions": [
    { "question": "Who exactly wakes up angry about this problem?", "answer": "The GC themselves, not their office admin — they're the one eating the cost of the mismatch." }
  ]
}
```

This payload has 1 of the allowed 0–3 clarifying questions and passes all
five validation rules above.

---

## 5. Out of scope for this step

- Persistence (Step 2 — Supabase `ideas` table)
- Evidence gathering trigger (Step 3)
- Clarifying-question *generation* (which questions Viva asks) — this step
  only defines the shape of the exchange, not the logic that produces the
  questions
