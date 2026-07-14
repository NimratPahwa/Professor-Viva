// Professor Viva — Layer 1 validation state machine (Step 8 of the gap-closure
// plan). Implements Architecture §3: "Deterministic five-stage state machine;
// each stage persists before the next begins, so a crashed run resumes rather
// than restarts."
//
// Stage 1 (Intake) already happened at idea creation. This module wires the
// remaining four stages into a single resumable runner:
//
//   intake ──▶ evidence ──▶ scoring ──▶ verdict ──▶ delivery
//              (2)          (3)         (4)         (5)
//
// `ideas.status` is the RESUMABLE CURSOR. It records the furthest COMPLETED
// stage and is persisted after each stage's output is written (never before).
// On resume, the runner reads the cursor and executes only the stages that
// have not yet completed — a crash after stage N re-enters at stage N+1, not
// stage 1. Each stage function is pure composition over the already-tested
// primitives (Steps 3–7): the business logic lives once in its own module.

const { getIdeaById, updateIdeaStatus } = require('./ideas-repo');
const { gatherAllEvidence, gatherDimensionEvidence, DIMENSIONS } = require('./evidence-pipeline');
const { insertEvidence, getEvidenceForIdea, deleteEvidenceForDimension } = require('./evidence-repo');
const { computeScores } = require('./scoring');
const { insertScores } = require('./scores-repo');
const { determineVerdict, THRESHOLD_VERSION } = require('./verdict');
const { insertVerdict, getLatestVerdictForIdea, updateVerdictVoice, updateVerdictCard } = require('./verdicts-repo');
const { renderVerdictVoice, renderNextSteps, SARCASM_DIAL, VOICE_PROMPT_VERSION } = require('./viva-voice');
const { renderWithGuardrails, screenReply } = require('./guardrail-filter');
const { summarizeUsage } = require('./usage-meter');

// The stable, canonical retrieval URL for an idea's verdict card (Step 9).
// The SVG is rendered deterministically on demand at this path.
function cardAssetUrlFor(ideaId) {
  return `/ideas/${ideaId}/card.svg`;
}

// ── Stage functions: do the work, persist their OWN table output, return the
// result. They do NOT touch idea.status — the runner owns the cursor. ──

async function runEvidenceStage(idea) {
  const dimensionResults = await gatherAllEvidence(idea);
  for (const r of dimensionResults) {
    if (r.status === 'ok') await insertEvidence(idea.id, r.dimension, r.claims);
  }
  // Per-call usage lines (one per dimension) bubble up for run-cost aggregation.
  const usage = dimensionResults.map((r) => r.usage).filter(Boolean);
  return { dimensionResults, usage };
}

async function runScoringStage(idea) {
  const evidence = await getEvidenceForIdea(idea.id);
  const computed = computeScores(evidence);
  await insertScores(idea.id, computed);
  return { computed, usage: [] }; // pure code — no LLM spend
}

async function runVerdictStage(idea) {
  const evidence = await getEvidenceForIdea(idea.id);
  const computed = computeScores(evidence);
  const verdict = determineVerdict(computed.total);
  const row = await insertVerdict(idea.id, {
    verdict,
    totalScore: computed.total,
    thresholdVersion: THRESHOLD_VERSION
  });
  return { computed, verdict, row, usage: [] }; // pure code — no LLM spend
}

// Stage 5 — Delivery. Renders the decided verdict in Viva's voice THROUGH the
// guardrail filter (Step 7) and persists it onto the verdict row. Card asset
// (Step 9) folds into this same stage later. Shared by the standalone
// POST /ideas/:id/voice endpoint and the full pipeline runner (single source of
// truth for the guardrail-wrapped voice pass).
async function runDeliveryStage(idea) {
  const verdictRow = await getLatestVerdictForIdea(idea.id);
  if (!verdictRow) {
    const e = new Error('No verdict to deliver. Run the verdict stage first.');
    e.code = 'NO_VERDICT';
    throw e;
  }

  const evidence = await getEvidenceForIdea(idea.id);
  const scores = computeScores(evidence);
  const baseDial = SARCASM_DIAL[verdictRow.verdict];

  // Capture the usage of EVERY voice call the guardrail flow makes, including a
  // dial-0 regeneration, by metering inside the injected render closure.
  const usage = [];
  const render = async (dial) => {
    const r = await renderVerdictVoice({ verdict: verdictRow.verdict, scores, evidence, idea, dial });
    usage.push(r.usage);
    return r.voice;
  };

  const guarded = await renderWithGuardrails({ idea, evidence, baseDial, render });

  if (guarded.residualViolations.length > 0) {
    const e = new Error('Reply failed guardrail screening after dial-0 regeneration.');
    e.code = 'GUARDRAIL_RESIDUAL';
    e.violations = guarded.residualViolations;
    throw e;
  }

  // FR-1.4 / §3.1: exactly 3 next steps at the SAME dial the voice reply used
  // (so a sensitive-input dial-0 verdict also gets dial-0 steps). Screened by the
  // same G1/G2 filter; a filtered set regenerates once at dial 0.
  let nextStepsResult = await renderNextSteps({
    verdict: verdictRow.verdict, scores, evidence, idea, dial: guarded.dialUsed
  });
  usage.push(nextStepsResult.usage);
  let nsScreen = screenReply(nextStepsResult.next_steps.join('\n'), evidence);
  if (!nsScreen.ok) {
    nextStepsResult = await renderNextSteps({
      verdict: verdictRow.verdict, scores, evidence, idea, dial: 0
    });
    usage.push(nextStepsResult.usage);
    nsScreen = screenReply(nextStepsResult.next_steps.join('\n'), evidence);
    if (!nsScreen.ok) {
      const e = new Error('Next steps failed guardrail screening after dial-0 regeneration.');
      e.code = 'GUARDRAIL_RESIDUAL';
      e.violations = nsScreen.violations;
      throw e;
    }
  }

  await updateVerdictVoice(verdictRow.id, {
    voicePassOutput: guarded.reply,
    voicePromptVersion: VOICE_PROMPT_VERSION,
    nextSteps: nextStepsResult.next_steps
  });

  // Step 9 (FR-1.5): the shareable verdict card is part of delivery. Its SVG is
  // rendered deterministically on demand at this stable URL; persist the URL.
  const updated = await updateVerdictCard(verdictRow.id, cardAssetUrlFor(idea.id));

  return { verdictRow, guarded, updated, nextSteps: nextStepsResult.next_steps, usage };
}

// ── Delta re-validation (cost optimization) ──
//
// The free re-validation (2nd entitled run) does NOT re-gather all five
// dimensions from scratch. Evidence gathering is the entire cost of a deep run
// (5 Sonnet + web_search calls); re-running it unchanged is why a "free"
// re-validation would cost as much as the first. Instead, a delta run REUSES
// the stored evidence rows that are still fresh and re-gathers ONLY the stale
// ones, then re-scores / re-verdicts / re-delivers over the merged evidence.
//
// A dimension is stale when it has NO stored claims (a prior insufficient_signal
// — worth another try) or its freshest claim is older than STALE_EVIDENCE_MS.
// Env-overridable so the freshness window can be tuned without a code change.
const STALE_EVIDENCE_MS = Number(process.env.STALE_EVIDENCE_MS) || 7 * 24 * 60 * 60 * 1000;

// PURE staleness planner (no I/O): given the stored evidence rows and a "now",
// which of the five dimensions must be re-gathered and which are reused as-is.
// Testable without a DB or the clock.
function planDelta(evidenceRows, now = Date.now(), staleMs = STALE_EVIDENCE_MS) {
  const allDims = Object.keys(DIMENSIONS);
  const freshestByDim = new Map();
  for (const row of evidenceRows) {
    const t = row.retrieved_at ? Date.parse(row.retrieved_at) : NaN;
    if (Number.isNaN(t)) continue;
    const prev = freshestByDim.get(row.dimension);
    if (prev === undefined || t > prev) freshestByDim.set(row.dimension, t);
  }

  const stale = [];
  const reused = [];
  for (const dim of allDims) {
    const freshest = freshestByDim.get(dim);
    // No stored claims for this dimension → stale (nothing to reuse; retry it).
    // Freshest claim older than the window → stale (refresh it).
    if (freshest === undefined || (now - freshest) > staleMs) {
      stale.push(dim);
    } else {
      reused.push(dim);
    }
  }
  return { stale, reused };
}

// Re-gathers only the stale dimensions and replaces THOSE rows in place, leaving
// reused dimensions' rows untouched. A stale dimension that comes back empty
// (timeout / insufficient_signal) keeps its OLD rows rather than erasing them —
// we only delete a dimension we successfully refreshed, so a failed re-gather
// never degrades evidence we already had.
async function runDeltaEvidenceStage(idea, stale) {
  const usage = [];
  for (const dimension of stale) {
    const r = await gatherDimensionEvidence(dimension, idea);
    if (r.usage) usage.push(r.usage);
    if (r.status === 'ok' && r.claims.length > 0) {
      await deleteEvidenceForDimension(idea.id, dimension);
      await insertEvidence(idea.id, dimension, r.claims);
    }
  }
  return { usage };
}

// Runs a DELTA re-validation for an idea that has already completed a full run.
// Reuses fresh evidence, refreshes only stale dimensions, then re-scores,
// re-decides the verdict, and re-delivers over the merged evidence. Returns the
// same shape as runPipeline (idea, trace, usage) so callers treat both uniformly.
async function runDeltaPipeline(ideaId) {
  const idea = await getIdeaById(ideaId);
  if (!idea) {
    const e = new Error('Idea not found.');
    e.code = 'NOT_FOUND';
    throw e;
  }

  const existing = await getEvidenceForIdea(ideaId);
  const { stale, reused } = planDelta(existing);
  const trace = [];
  const usageLines = [];

  const delta = await runDeltaEvidenceStage(idea, stale);
  usageLines.push(...delta.usage);
  trace.push({ stage: 'evidence', ran: stale.length > 0, refreshed: stale, reused });

  // Re-score / re-verdict / re-deliver over the merged evidence. These stages
  // are pure code (scoring, verdict) plus the guardrailed voice pass (delivery);
  // delivery is the only one that spends on the LLM.
  for (const stage of [
    { name: 'scoring', run: runScoringStage },
    { name: 'verdict', run: runVerdictStage },
    { name: 'delivery', run: runDeliveryStage }
  ]) {
    const out = await stage.run(idea);
    if (out && Array.isArray(out.usage)) usageLines.push(...out.usage);
    trace.push({ stage: stage.name, ran: true });
  }

  return { idea, delta: true, trace, usage: summarizeUsage(usageLines) };
}

// ── The machine ──

// The cursor's ordered values. Index = number of completed stages.
const STATUS_ORDER = ['intake', 'evidence_gathering', 'scoring', 'verdict', 'complete'];

// Ordered stages. STAGES[i] produces STATUS_ORDER[i + 1] when it completes.
const STAGES = [
  { name: 'evidence', produces: 'evidence_gathering', run: runEvidenceStage },
  { name: 'scoring', produces: 'scoring', run: runScoringStage },
  { name: 'verdict', produces: 'verdict', run: runVerdictStage },
  { name: 'delivery', produces: 'complete', run: runDeliveryStage }
];

// PURE resume planner (no I/O): given the persisted cursor, which stages are
// already done and which remain. Testable without a DB.
function planResume(status) {
  const completedStages = STATUS_ORDER.indexOf(status);
  if (completedStages < 0) {
    throw new Error(`planResume: unknown status "${status}"`);
  }
  return {
    resumedFrom: status,
    completedStages,
    toSkip: STAGES.slice(0, completedStages).map((s) => s.name),
    toRun: STAGES.slice(completedStages).map((s) => s.name)
  };
}

// Runs the pipeline from wherever the idea's cursor currently sits to
// 'complete'. Already-completed stages are skipped (resume). Each stage
// persists its output, THEN the cursor advances — so a crash mid-stage leaves
// the cursor untouched and the stage re-runs cleanly on the next call. Running
// an already-'complete' idea is a no-op.
async function runPipeline(ideaId) {
  let idea = await getIdeaById(ideaId);
  if (!idea) {
    const e = new Error('Idea not found.');
    e.code = 'NOT_FOUND';
    throw e;
  }

  const plan = planResume(idea.status);
  const trace = [];
  // Only the stages that actually run THIS invocation contribute usage — a
  // resumed run does not re-bill stages completed on a prior invocation.
  const usageLines = [];

  for (let i = 0; i < STAGES.length; i++) {
    const stage = STAGES[i];
    if (i < plan.completedStages) {
      trace.push({ stage: stage.name, ran: false, reason: 'already complete' });
      continue;
    }
    const out = await stage.run(idea);
    if (out && Array.isArray(out.usage)) usageLines.push(...out.usage);
    idea = await updateIdeaStatus(ideaId, stage.produces);
    trace.push({ stage: stage.name, ran: true, status: stage.produces });
  }

  return { idea, resumedFrom: plan.resumedFrom, trace, usage: summarizeUsage(usageLines) };
}

module.exports = {
  runEvidenceStage,
  runScoringStage,
  runVerdictStage,
  runDeliveryStage,
  runPipeline,
  runDeltaPipeline,
  runDeltaEvidenceStage,
  planResume,
  planDelta,
  cardAssetUrlFor,
  STAGES,
  STATUS_ORDER,
  STALE_EVIDENCE_MS
};
