# Professor Viva — Scoring Engine (Step 4 of gap-closure plan)
**Companion docs:** 01-PRD (FR-1.3) · 02-Architecture (§3 stage 3) · 03-AI Rules (§3)

---

## 1. Principle

Scoring is **pure code** (`lib/scoring.js`). No LLM runs in this stage. The
same stored evidence always produces the same per-dimension scores and the
same rubric-weighted total (CLAUDE.md: "no LLM ever assigns a score or
verdict"; 03-AI Rules §3: "same idea + same evidence = same verdict").

## 2. Where the "signals" come from (polarity enrichment)

03-AI Rules §3 gives dimension weights but not a sub-score formula, and
Architecture §3 says scoring uses "evidence **counts and signals**." Raw
counts alone are insufficient and can invert a verdict — e.g. many competitor
claims mean a *crowded* market, which should *lower* the market_gap score, but
a count-only model would *raise* it.

So each evidence row carries a `signal` classified upstream in the evidence
pipeline (migration `0003_evidence_signal.sql`):

- `supports` — the sourced fact strengthens the case for this idea on this dimension
- `undermines` — it weakens the case
- `neutral` — relevant/sourced but not directionally good or bad

The LLM only *classifies* evidence into these buckets; the numeric score is
computed from them in pure code. That keeps "no LLM assigns a score" intact
while giving the engine the directional signal it needs.

## 3. Rubric (03-AI Rules §3)

| Dimension | Weight |
|---|---|
| demand | 30% |
| market_gap | 25% |
| monetization | 20% |
| founder_fit | 15% |
| timing | 10% |

`rubric_version` is recorded on every persisted score row (`1.0.0`), so a
rubric change is A/B-testable and every score is traceable to the rubric that
produced it.

## 4. Per-dimension score (0–100)

Given a dimension's claim counts — supports `s`, undermines `u`, neutral `n`:

- `total = s + u + n`, `directional = s + u`
- **`total == 0`** → score = `INSUFFICIENT_DIMENSION_SCORE` (20), status
  `insufficient_signal`. Disclosed, never padded with model opinion
  (03-AI Rules §3). 20 (not 0) means "no signal found" is weak-but-not-damning;
  0 is reserved for evidence that actively undermines the idea.
- **otherwise** → status `scored`, and:
  - `polarity   = directional > 0 ? s / directional : 0.5`   (0..1)
  - `confidence = min(1, directional / CONFIDENCE_FULL)`      (`CONFIDENCE_FULL = 5`)
  - `score = 50 + (polarity − 0.5) × 100 × confidence`, clamped to 0..100

Centered at 50 (mixed / no directional lean) and pushed toward 100 (all
favorable) or 0 (all unfavorable) in proportion to how one-sided the evidence
is *and* how much directional evidence exists. One lone supporting claim yields
a mild 60, not 100.

## 5. Weighted total

`total = Σ (dimension_score × weight)`, rounded to 2 decimals. The total is
**not** stored by this step — it belongs to the verdict row (Step 5), per the
schema split in Architecture §6 (`scores` = per-dimension; `verdicts` =
`total_score`). The engine returns it so Step 5 can threshold it.

## 6. Endpoint

`POST /ideas/:id/score` — loads the idea's stored evidence, computes scores,
persists the five per-dimension rows to `scores`, sets idea status to
`scoring`, and returns the per-dimension breakdown plus the weighted total.

## 7. Worked example (also the Done-When fixture)

| Dimension | s / u / n | Score |
|---|---|---|
| demand | 4 / 1 / 0 | 80 |
| market_gap | 1 / 3 / 0 | 30 |
| monetization | 2 / 2 / 1 | 50 |
| founder_fit | 0 / 0 / 0 | 20 (insufficient) |
| timing | 0 / 0 / 3 | 50 |

Weighted total = 80×.30 + 30×.25 + 50×.20 + 20×.15 + 50×.10 = **49.5**.

`scripts/test-scoring.js` asserts these exact values (hermetic, no DB), proves
determinism across repeated runs, and confirms the same numbers persist through
the real endpoint into the `scores` table.
