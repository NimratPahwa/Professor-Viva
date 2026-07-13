// Professor Viva — free quick verdict orchestrator (Step 11.5, FR-1.9/1.11).
//
// The FREE-tier analog of the paid delivery stage (lib/pipeline.js). It composes
// the already-tested primitives into the one free verdict a (account, idea) pair
// gets:
//
//   quick evidence pass ─▶ computeScores ─▶ determineVerdict     (pure code)
//         │                                        │
//         └──────────────▶ ONE combined voice call (roast + shallow next steps)
//                                                  │
//         competitive analysis (deterministic) ────┤
//         ordered blurred teasers (real content) ──┘
//
// No score or verdict is ever assigned by an LLM (CLAUDE.md). The roast + shallow
// next steps come from ONE Haiku call (Step 11.5 budget rule), screened by the
// SAME server-side guardrail filter as the paid verdict; a filtered reply
// regenerates once at dial 0.

const { gatherQuickEvidence } = require('./quick-evidence');
const { computeScores } = require('./scoring');
const { determineVerdict, THRESHOLD_VERSION } = require('./verdict');
const { renderQuickVerdict, SARCASM_DIAL } = require('./viva-voice');
const { detectSensitiveInput, screenReply } = require('./guardrail-filter');
const { buildCompetitiveAnalysis } = require('./competitive');
const { buildTeasers } = require('./teasers');

// Screens the combined free reply (roast + shallow next steps) with the SAME
// G1/G2 filter the paid path uses. Sensitive input forces dial 0 on the first
// render; a filtered reply regenerates once at dial 0.
async function renderQuickVerdictGuarded({ verdict, scores, evidence, idea }) {
  const sensitiveInput = detectSensitiveInput(idea);
  const baseDial = sensitiveInput ? 0 : SARCASM_DIAL[verdict];

  const screenText = (r) => `${r.roast}\n${r.next_steps.join('\n')}`;

  let dialUsed = baseDial;
  let result = await renderQuickVerdict({ verdict, scores, evidence, idea, dial: baseDial });
  let screen = screenReply(screenText(result), evidence);
  let regenerated = false;

  if (!screen.ok) {
    regenerated = true;
    dialUsed = 0;
    result = await renderQuickVerdict({ verdict, scores, evidence, idea, dial: 0 });
    screen = screenReply(screenText(result), evidence);
    if (!screen.ok) {
      const e = new Error('Free verdict failed guardrail screening after dial-0 regeneration.');
      e.code = 'GUARDRAIL_RESIDUAL';
      e.violations = screen.violations;
      throw e;
    }
  }

  return { result, dialUsed, sensitiveInput, regenerated };
}

// Produces the full free-verdict payload for an idea. Pure composition — the
// caller owns account resolution, the one-per-(account, idea) ledger check, and
// persistence. Spends LLM credits (quick evidence pass + one Haiku voice call).
async function produceFreeVerdict(idea) {
  const { dimensionResults, evidence } = await gatherQuickEvidence(idea);
  const scores = computeScores(evidence);
  const verdict = determineVerdict(scores.total);

  const guarded = await renderQuickVerdictGuarded({ verdict, scores, evidence, idea });
  const competitive = buildCompetitiveAnalysis({ evidence });
  const teasers = buildTeasers({
    nextSteps: guarded.result.next_steps,
    competitive,
    evidenceRows: evidence
  });

  return {
    verdict,
    total_score: scores.total,
    threshold_version: THRESHOLD_VERSION,
    rubric_version: scores.rubric_version,
    roast: guarded.result.roast,
    // Shallow sections live in the payload; the free SCREEN shows only the
    // ordered blurred teasers (FR-1.11). The full sections are persisted so the
    // teasers provably come from real content, and for audit.
    shallow: {
      pass: 'quick',
      quick_pass_label: 'quick evidence pass',
      dimensions: dimensionResults.map((r) => ({ dimension: r.dimension, status: r.status, claim_count: r.claims.length })),
      evidence,
      scores: scores.dimensions,
      next_steps: guarded.result.next_steps,
      competitive_analysis: competitive
    },
    locked_sections: teasers,
    sarcasm_dial: guarded.dialUsed,
    sensitive_input: guarded.sensitiveInput,
    regenerated: guarded.regenerated
  };
}

module.exports = { produceFreeVerdict, renderQuickVerdictGuarded };
