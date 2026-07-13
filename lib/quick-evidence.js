// Professor Viva — quick evidence pass (Step 11.5, FR-1.2 free tier).
//
// The FREE tier's verdict is produced by a QUICK evidence pass: a cheaper model
// (Haiku), LIMITED sources (web_search capped), and a hard 60-second cap. It
// produces real-but-SHALLOW versions of the same five rubric dimensions the deep
// run gathers — same schema, same signal classification, same ground-truth URL
// validation — just less of it. Both passes feed the SAME deterministic scoring
// engine (lib/scoring.js), so "no LLM ever assigns a score" still holds.
//
// The shallow evidence is returned in-memory and NEVER written to the `evidence`
// table (it lives in free_verdicts.payload as jsonb). The deep evidence run
// remains the sole writer of the `evidence` table, so the two passes never mix
// in scoring or receipts.
//
// Guardrail 1 (03-AI Rules §4): limited sources are not an excuse for padding. A
// dimension that finds nothing degrades to 'insufficient_signal' — scored low
// and disclosed, never fabricated (FR-1.9, §3.2 "a quick pass that finds nothing
// still tells the truth").

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { buildCategoryQuery, extractGroundTruthUrls, DIMENSIONS } = require('./evidence-pipeline');

const client = new Anthropic();

// Cheaper model for the free tier (01-PRD business model, 03-AI Rules §3.2).
const QUICK_EVIDENCE_MODEL = 'claude-haiku-4-5';

// "Quick evidence pass ... ≤ 60 seconds" (FR-1.2 / FR-1.8). The per-dimension
// budget is kept under the whole-pass cap so a single slow dimension degrades to
// insufficient-signal rather than blowing the 60s ceiling. The whole pass is
// additionally raced against QUICK_PASS_TIMEOUT_MS as a hard backstop.
const QUICK_DIMENSION_TIMEOUT_MS = 50_000;
const QUICK_PASS_TIMEOUT_MS = 60_000;

// "Limited sources" (FR-1.2): the web_search tool is capped so the free pass is
// a genuine back-of-the-envelope read, not the deep run.
const QUICK_MAX_SEARCHES = 2;

const ClaimsSchema = z.object({
  claims: z.array(z.object({
    claim: z.string(),
    source_url: z.string(),
    signal: z.enum(['supports', 'neutral', 'undermines'])
  }))
});

function withTimeout(promise, ms, onTimeoutValue) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onTimeoutValue), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

async function gatherQuickDimension(dimension, idea) {
  const focus = DIMENSIONS[dimension].focus;
  try {
    const response = await withTimeout(
      client.messages.stream({
        model: QUICK_EVIDENCE_MODEL,
        max_tokens: 2000,
        // Haiku does not support programmatic tool calling, so web_search must be
        // marked allowed_callers:['direct'] (the model calls it directly, not via a
        // tool-runner loop). max_uses caps it to a genuine limited-sources pass.
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: QUICK_MAX_SEARCHES, allowed_callers: ['direct'] }],
        output_config: { format: zodOutputFormat(ClaimsSchema, 'claims') },
        messages: [{ role: 'user', content: buildCategoryQuery(idea, focus) }]
      }).finalMessage(),
      QUICK_DIMENSION_TIMEOUT_MS,
      null
    );

    if (!response || !response.parsed_output) {
      return { dimension, status: 'insufficient_signal', claims: [] };
    }

    // Same ground-truth enforcement as the deep pass: a claim citing a URL that
    // was not actually retrieved is discarded (no fabricated evidence).
    const groundTruthUrls = extractGroundTruthUrls(response.content);
    const validatedClaims = response.parsed_output.claims.filter(
      (c) => groundTruthUrls.has(c.source_url)
    );

    if (validatedClaims.length === 0) {
      return { dimension, status: 'insufficient_signal', claims: [] };
    }
    return { dimension, status: 'ok', claims: validatedClaims };
  } catch (err) {
    console.error(`quick evidence failed for dimension "${dimension}":`, err.message);
    return { dimension, status: 'insufficient_signal', claims: [] };
  }
}

// Runs all five dimensions in parallel under the 60s whole-pass cap. Returns
// BOTH the per-dimension results and a flat `evidence` array in the same row
// shape the scoring engine + receipts + competitive assembly expect
// ({ dimension, signal, claim, source_url }), tagged pass:'quick'.
async function gatherQuickEvidence(idea) {
  const dimensionNames = Object.keys(DIMENSIONS);
  const perDimension = await withTimeout(
    Promise.all(dimensionNames.map((d) => gatherQuickDimension(d, idea))),
    QUICK_PASS_TIMEOUT_MS,
    // Whole-pass backstop: if the 60s ceiling is hit, every dimension degrades
    // to insufficient-signal (truthful — nothing was validated in time).
    dimensionNames.map((d) => ({ dimension: d, status: 'insufficient_signal', claims: [] }))
  );

  const evidence = [];
  for (const r of perDimension) {
    if (r.status === 'ok') {
      for (const c of r.claims) {
        evidence.push({
          dimension: r.dimension,
          signal: c.signal || 'neutral',
          claim: c.claim,
          source_url: c.source_url,
          pass: 'quick'
        });
      }
    }
  }

  return { pass: 'quick', dimensionResults: perDimension, evidence };
}

module.exports = {
  gatherQuickEvidence,
  gatherQuickDimension,
  QUICK_EVIDENCE_MODEL,
  QUICK_MAX_SEARCHES,
  QUICK_DIMENSION_TIMEOUT_MS,
  QUICK_PASS_TIMEOUT_MS
};
