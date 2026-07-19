// Professor Viva — The Professor's Stage, Screen 5 "The Six Answers".
//
// Deterministic assembly of the report's six-answer structure from real pipeline
// data. Answers 1, 2, 4 are grounded in the relevant dimension's evidence rows;
// Answer 3 is the deterministic competitive assembly; Answers 5 & 6 are the two
// schema-enforced GENERATED fields the deep run produces (verdicts.six_answers).
// No LLM runs here — this only re-shapes already-produced data, so /report and
// /sample render an identical structure.

// Claims for a dimension, trimmed to what the report shows (claim + source).
function claimsFor(evidence, dimension) {
  return evidence
    .filter((e) => e.dimension === dimension)
    .map((e) => ({ claim: e.claim, source_url: e.source_url, signal: e.signal || 'neutral' }));
}

// Assembles the six answers.
//   idea        — { problem, audience }
//   evidence    — the idea's evidence rows
//   competitive — buildCompetitiveAnalysis() output (Answer 3)
//   sixAnswers  — { acquisition, first_revenue } from the verdict row (5 & 6);
//                 may be null for a not-yet-generated report.
function assembleSixAnswers({ idea, evidence, competitive, sixAnswers }) {
  const sa = sixAnswers || {};
  return [
    { n: 1, title: 'The problem, evidenced',
      subject: idea.problem, claims: claimsFor(evidence, 'demand') },
    { n: 2, title: 'Your customer, sharpened',
      subject: idea.audience, claims: claimsFor(evidence, 'demand') },
    { n: 3, title: 'Your competitors, priced',
      competitive },
    { n: 4, title: 'Why anyone switches to you',
      subject: idea.unfair_advantage || '', claims: claimsFor(evidence, 'founder_fit') },
    { n: 5, title: 'Your first ten customers: a concrete plan',
      body: sa.acquisition || '' },
    { n: 6, title: 'Your first dollar: the path',
      body: sa.first_revenue || '' }
  ];
}

module.exports = { assembleSixAnswers, claimsFor };
