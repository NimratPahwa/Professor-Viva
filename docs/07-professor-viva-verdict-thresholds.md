# Professor Viva — Verdict Thresholds (Step 5 of gap-closure plan)
**Companion docs:** 01-PRD (FR-1.3) · 02-Architecture (§3 stage 4) · 03-AI Rules (§3)

---

## 1. Principle

The verdict is **pure code** (`lib/verdict.js`) — a hard-coded threshold
comparison over the rubric-weighted total from the scoring engine
(`lib/scoring.js`). No LLM. Same idea + same evidence → same total → same
verdict (CLAUDE.md; 03-AI Rules §3).

## 2. Thresholds (03-AI Rules §3)

| Weighted total | Verdict | Meaning |
|---|---|---|
| ≥ 75 | **BUILD** | Unlocks the Layer 2 offer |
| 50 – 74.99 | **PIVOT** | Viva names the pivot; re-validation is free |
| < 50 | **BURY** | Salvageable insight + one adjacent direction |

Boundaries are inclusive at the lower edge: exactly 75 → BUILD, exactly 50 →
PIVOT. A non-numeric total throws rather than silently guessing a verdict.

`threshold_version` (`1.0.0`) is recorded on every verdict row, so threshold
changes are A/B-testable against share rate without touching the pipeline
(03-AI Rules §5).

## 3. What this step does and does not persist

`POST /ideas/:id/verdict` loads the idea's stored evidence, recomputes the
deterministic scores (single source of truth = `computeScores`), maps the
weighted total to a verdict, and writes one row to `verdicts` with `verdict`,
`total_score`, and `threshold_version`. It sets idea status to `verdict`.

`voice_pass_output` (Step 6 — the Viva-voice rendering) and `card_asset_url`
(Step 9 — the shareable card) are intentionally left null here. This step is
*only* the deterministic decision; how that decision is spoken and drawn comes
later. Keeping them separate preserves the two-pass rule (03-AI Rules §5):
voice can never alter the score or the verdict.

## 4. Done-When

`scripts/test-verdict.js`:
- **Part A (hermetic):** every threshold boundary — 100/75 → BUILD,
  74.99/60/50 → PIVOT, 49.99/49.5/0 → BURY — plus a non-numeric input that
  must throw.
- **Part B (real endpoint):** synthetic evidence with a known weighted total
  (49.5 → BURY) scored and judged through `POST /ideas/:id/verdict`; confirms
  the persisted `verdicts` row (verdict, total_score, threshold_version, null
  voice/card fields) and that idea status advanced to `verdict`.
