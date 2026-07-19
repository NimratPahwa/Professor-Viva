// Professor Viva — The Professor's Stage, Screen 4 card data.
//
// The verdict card takes one of three comedic FORMATS — BURY = obituary,
// PIVOT = driving-test result, BUILD = certificate of approval — but every
// comedic FIELD is filled from REAL pipeline data, never invented (docs/15 §3
// Screen 4; 03-AI Rules §4.1). This module is PURE: it takes the already-decided
// verdict, scores, evidence, and a couple of real counts, and assembles the
// card's data. The card is rendered client-side in-palette at 4:5; no LLM runs
// here (the comedic frame is static template text — only the data is real).

const DIMENSION_LABELS = {
  demand: 'reading the room',
  market_gap: 'parallel parking into the market',
  monetization: 'charging money without flinching',
  founder_fit: 'being the person to build this',
  timing: 'showing up at the right time'
};

// Palette pose + accent per verdict (design §1/§2).
const VERDICT_POSE = { BUILD: 'build', PIVOT: 'pivot', BURY: 'bury' };
const VERDICT_ACCENT = { BUILD: 'green', PIVOT: 'gold', BURY: 'charcoal' };
// The stamp reads the verdict word itself. The format joke (the driving-test
// "retake," the obituary "rest in peace") moves to the sub-line printed
// beneath the stamp, so the verdict is legible at a glance on the card.
const VERDICT_STAMP = { BUILD: 'BUILD', PIVOT: 'PIVOT', BURY: 'BURY' };
const VERDICT_SUBLINE = {
  BUILD: 'Certified fit to build.',
  PIVOT: 'Retake permitted: 1 free re-validation.',
  BURY: 'Rest in peace.'
};

// Human elapsed time ("submission → verdict") for the obituary lifespan.
function formatLifespan(ms) {
  if (!ms || ms < 0) ms = 0;
  const sec = Math.round(ms / 1000);
  if (sec < 90) return `${sec} second${sec === 1 ? '' : 's'}`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} hour${hr === 1 ? '' : 's'}`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'}`;
}

// Strongest / weakest scored dimension (real scores). Ties break by rubric order.
function rankDimensions(scores) {
  const entries = Object.entries(scores.dimensions).map(([dim, d]) => ({ dim, score: Number(d.score) }));
  const strongest = entries.reduce((a, b) => (b.score > a.score ? b : a));
  const weakest = entries.reduce((a, b) => (b.score < a.score ? b : a));
  return { strongest, weakest };
}

// The single most damning REAL claim (top 'undermines'; else any claim), for the
// obituary's "cause of death". Empty when nothing was found — stated honestly.
function topUnderminingClaim(evidence) {
  const undermining = evidence.filter((e) => e.signal === 'undermines');
  const pick = undermining[0] || evidence[0];
  return pick ? { claim: pick.claim, source_url: pick.source_url } : null;
}

// Count of market_gap evidence rows — the "survived by N identical apps" number.
function competitorCount(evidence) {
  return evidence.filter((e) => e.dimension === 'market_gap').length;
}

function letterhead(verdict, verdictNumber) {
  return {
    title: 'PROFESSOR VIVA',
    department: 'Department of Hard Truths',
    pose: VERDICT_POSE[verdict],
    verdict_number: verdictNumber || null,
    footer: 'Get your verdict · professorviva.com'
  };
}

// Assembles the card data for a decided verdict.
//   idea            — { problem, created_at, ... }
//   verdict         — 'BUILD' | 'PIVOT' | 'BURY'
//   scores          — computeScores() output
//   evidence        — the idea's evidence rows
//   elapsedMs       — submission→verdict elapsed (obituary lifespan)
//   verdictNumber   — the card's serial (e.g. free_verdict/verdict id short)
//   buildsThisMonth — real count of BUILD verdicts this month (certificate "1 of N")
function buildCardData({ idea, verdict, scores, evidence, elapsedMs, verdictNumber, buildsThisMonth }) {
  if (!VERDICT_STAMP[verdict]) throw new Error(`buildCardData: unknown verdict "${verdict}"`);

  const base = {
    verdict,
    stamp: VERDICT_STAMP[verdict],
    stamp_subline: VERDICT_SUBLINE[verdict],
    accent: VERDICT_ACCENT[verdict],
    total_score: Number(scores.total),
    letterhead: letterhead(verdict, verdictNumber),
    idea_name: idea.problem
  };

  if (verdict === 'BURY') {
    const cause = topUnderminingClaim(evidence);
    const n = competitorCount(evidence);
    return {
      ...base,
      format: 'obituary',
      in_memory_of: idea.problem,
      lifespan: formatLifespan(elapsedMs),
      cause_of_death: cause ? cause.claim : 'No demand signal could be found. It quietly stopped breathing on its own.',
      cause_source_url: cause ? cause.source_url : null,
      survived_by: `${n} identical app${n === 1 ? '' : 's'}, all also unwell`,
      in_lieu_of_flowers: 'please validate your next idea first.'
    };
  }

  if (verdict === 'PIVOT') {
    const { strongest, weakest } = rankDimensions(scores);
    return {
      ...base,
      format: 'driving_test',
      failed_headline: `Failed: ${DIMENSION_LABELS[weakest.dim] || weakest.dim}`,
      passed_skill: { skill: DIMENSION_LABELS[strongest.dim] || strongest.dim, dimension: strongest.dim, score: strongest.score },
      failed_skill: { skill: DIMENSION_LABELS[weakest.dim] || weakest.dim, dimension: weakest.dim, score: weakest.score }
    };
  }

  // BUILD — certificate of approval.
  const n = Number.isFinite(buildsThisMonth) && buildsThisMonth > 0 ? buildsThisMonth : 1;
  return {
    ...base,
    format: 'certificate',
    seal: true,
    approved_line: `Approved: 1 of ${n} this month`,
    signature: 'Professor Viva, Dept. of Hard Truths'
  };
}

module.exports = {
  buildCardData,
  formatLifespan,
  rankDimensions,
  competitorCount,
  topUnderminingClaim,
  DIMENSION_LABELS
};
