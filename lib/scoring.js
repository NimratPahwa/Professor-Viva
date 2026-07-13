// Professor Viva — scoring engine (Step 4 of the gap-closure plan).
// Implements 03-AI Rules §3 and Architecture §3 stage 3.
//
// PURE CODE. No LLM is called here. Given the same stored evidence, this
// module always returns the same scores (CLAUDE.md: "Verdict logic and
// scoring are pure code — no LLM ever assigns a score or verdict").
//
// Input: the evidence rows for one idea (from the `evidence` table), each
// carrying a `dimension` and a `signal` in {supports, neutral, undermines}
// (the polarity classified upstream in the evidence pipeline).
//
// Per-dimension score (0–100):
//   Let supports (s), undermines (u), neutral (n) be the claim counts.
//   directional = s + u ; total = s + u + n.
//   - total == 0            -> INSUFFICIENT_DIMENSION_SCORE, status
//                              'insufficient_signal' (disclosed, never padded
//                              with model opinion — 03-AI Rules §3).
//   - otherwise             -> status 'scored', and
//       polarity   = directional > 0 ? s / directional : 0.5   (0..1)
//       confidence = min(1, directional / CONFIDENCE_FULL)     (0..1)
//       score      = 50 + (polarity - 0.5) * 100 * confidence  (0..100)
//
//   Rationale: score is centered at 50 (genuinely mixed / no directional
//   lean) and pushed toward 100 (all favorable) or 0 (all unfavorable) in
//   proportion to how one-sided the evidence is AND how much directional
//   evidence exists. One lone supporting claim yields a mild 60, not a 100.
//
// Weighted total (0–100): sum of dimension score * rubric weight.

const RUBRIC_VERSION = '1.0.0';

// 03-AI Rules §3 weights.
const WEIGHTS = {
  demand: 0.30,
  market_gap: 0.25,
  monetization: 0.20,
  founder_fit: 0.15,
  timing: 0.10
};

const DIMENSIONS = Object.keys(WEIGHTS);

// Number of directional (supports/undermines) claims at which a dimension is
// considered to have full confidence in its polarity lean.
const CONFIDENCE_FULL = 5;

// A dimension with zero validated evidence scores low but not zero: "no signal
// found" is a weak, disclosed result, not the maximally damning 0 reserved for
// evidence that actively undermines the idea (03-AI Rules §3).
const INSUFFICIENT_DIMENSION_SCORE = 20;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function scoreDimension(rows) {
  let supports = 0;
  let undermines = 0;
  let neutral = 0;
  for (const r of rows) {
    if (r.signal === 'supports') supports++;
    else if (r.signal === 'undermines') undermines++;
    else neutral++;
  }

  const total = supports + undermines + neutral;
  if (total === 0) {
    return {
      score: INSUFFICIENT_DIMENSION_SCORE,
      status: 'insufficient_signal',
      supports,
      undermines,
      neutral
    };
  }

  const directional = supports + undermines;
  const polarity = directional > 0 ? supports / directional : 0.5;
  const confidence = Math.min(1, directional / CONFIDENCE_FULL);
  let score = 50 + (polarity - 0.5) * 100 * confidence;
  score = Math.max(0, Math.min(100, score));

  return {
    score: round2(score),
    status: 'scored',
    supports,
    undermines,
    neutral
  };
}

// evidenceRows: array of { dimension, signal, ... } for a single idea.
// Returns per-dimension scores + the rubric-weighted total.
function computeScores(evidenceRows) {
  const byDimension = {};
  for (const dim of DIMENSIONS) byDimension[dim] = [];
  for (const row of evidenceRows) {
    if (byDimension[row.dimension]) byDimension[row.dimension].push(row);
  }

  const dimensions = {};
  let total = 0;
  for (const dim of DIMENSIONS) {
    const result = scoreDimension(byDimension[dim]);
    dimensions[dim] = result;
    total += result.score * WEIGHTS[dim];
  }

  return {
    rubric_version: RUBRIC_VERSION,
    dimensions,
    total: round2(total)
  };
}

module.exports = {
  computeScores,
  scoreDimension,
  RUBRIC_VERSION,
  WEIGHTS,
  DIMENSIONS,
  CONFIDENCE_FULL,
  INSUFFICIENT_DIMENSION_SCORE
};
