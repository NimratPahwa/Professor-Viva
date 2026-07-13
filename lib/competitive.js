// Professor Viva — competitive analysis assembly (Step 11.5, FR-1.10/FR-1.11).
//
// PURE CODE. No LLM. Competitive analysis is a DETERMINISTIC assembly of the
// already-gathered market_gap + monetization evidence — the same mechanism for
// BOTH tiers (Step 11.5 design decision 2). The paid version is richer ONLY
// because the deep evidence run gathered more rows, not because a different call
// runs. Any narrative framing on the paid report goes through the existing voice
// pass, never a new analysis call here.
//
// market_gap answers "who else is in this space and where is the room?"
// monetization answers "will anyone pay, and how much?" — together they are the
// competitive picture behind the verdict.

const { computeScores, WEIGHTS } = require('./scoring');

const COMPETITIVE_DIMENSIONS = ['market_gap', 'monetization'];

const DIMENSION_LABELS = {
  market_gap: 'Market Gap',
  monetization: 'Monetization'
};

// Builds the competitive-analysis payload from stored/quick evidence rows.
//   evidence — rows of { dimension, signal, claim, source_url } (quick OR deep)
// Scores are recomputed deterministically (single source of truth = computeScores),
// so the section always agrees with the verdict it sits behind.
function buildCompetitiveAnalysis({ evidence }) {
  const scored = computeScores(evidence);

  const byDimension = {};
  for (const dim of COMPETITIVE_DIMENSIONS) byDimension[dim] = [];
  for (const row of evidence || []) {
    if (byDimension[row.dimension]) {
      byDimension[row.dimension].push({
        claim: row.claim,
        source_url: row.source_url,
        signal: row.signal || 'neutral'
      });
    }
  }

  let totalClaims = 0;
  const sections = COMPETITIVE_DIMENSIONS.map((dim) => {
    const s = scored.dimensions[dim];
    const claims = byDimension[dim];
    totalClaims += claims.length;
    return {
      dimension: dim,
      label: DIMENSION_LABELS[dim],
      weight: WEIGHTS[dim],
      score: s.score,
      status: s.status,
      supports: s.supports,
      undermines: s.undermines,
      neutral: s.neutral,
      claims
    };
  });

  return {
    rubric_version: scored.rubric_version,
    total_claims: totalClaims,
    sections
  };
}

module.exports = { buildCompetitiveAnalysis, COMPETITIVE_DIMENSIONS, DIMENSION_LABELS };
