# Professor Viva — Server-Side Guardrail Filter (Step 7 of gap-closure plan)
**Companion docs:** 02-Architecture (§7) · 03-AI Rules (§4)

---

## 1. Principle

Guardrails are not left to the model. `lib/guardrail-filter.js` is **pure code**
that wraps the Step 6 voice pass and enforces 03-AI Rules §4 guardrails 1–3
before any reply renders. The model is *told* the guardrails in its prompt; this
filter *enforces* them regardless of what the model does. "A filtered reply
regenerates at dial 0" (§4).

## 2. The three enforced guardrails

| # | Guardrail | Side | Rule-based enforcement |
|---|---|---|---|
| G1 | No fabricated evidence | output | Any source URL the reply **cites** must exist in the idea's stored evidence. A clean reply cites nothing (the voice contract forbids raw citations); this catches a model that invents a link. |
| G2 | No personal attacks | output | A tight pattern set flags punching down at the founder (intelligence, education, English, background). Idea-roasts ("your idea has been built 47 times", "your market") deliberately do **not** trip. |
| G3 | No sarcasm on sensitive input | input | Founder disclosure of job loss, financial desperation, health distress, or acute distress forces the dial to **0** before the first render. |

Semantic fabrication (a made-up *fact* with no link) cannot be caught by a rule
engine — that is constrained upstream by the prompt's "cite only the evidence
block" instruction (§4.1). The filter enforces the *citable-source* rule, which
is the part a deterministic filter can guarantee.

## 3. Control flow (`renderWithGuardrails`)

```
1. G3: detectSensitiveInput(idea) → if true, first render forced to dial 0.
2. render(dial) → reply.
3. screenReply(reply, evidence) → G1 + G2.
4. if filtered → regenerate ONCE at dial 0, re-screen.
5. residual violations after dial-0 regen → endpoint returns 502 (never ship a breach).
```

`render` is dependency-injected (`async (dial) => replyText`), so the whole flow
is testable in pure code without an LLM. In `server.js` the injected renderer is
the Step 6 `renderVerdictVoice`, now accepting a `dial` override so the filter
can force 0.

## 4. Endpoint integration

`POST /ideas/:id/voice` now runs the voice pass **through** the filter. The
response carries `sarcasm_dial` (the dial actually used), `sensitive_input`, and
`regenerated` so the outcome is auditable. If regeneration at dial 0 still fails
screening, the endpoint returns 502 rather than persisting a guardrail breach.

## 5. Done-When

`scripts/test-guardrails.js`:
- **Part A (hermetic):** G3 detection (job loss / financial / health true;
  ordinary idea false); G1 (in-evidence citation passes, fabricated URL flagged);
  G2 (personal attack + attribute punch-down flagged, hard idea-roast passes);
  and the control flow — sensitive input forces first render to dial 0, a clean
  reply renders once at the base dial, and a violating first reply regenerates
  exactly once at dial 0 with no residual violations (injected fake renderer).
- **Part B (real endpoint):** a sensitive-disclosure idea (BURY, base dial 6) is
  voiced through `POST /ideas/:id/voice` and comes back with `sensitive_input:
  true` and `sarcasm_dial: 0`, footer intact, prose non-empty, and the rendered
  reply itself passing G1+G2 screening.
