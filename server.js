require('dotenv').config({ override: true });
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const { validateIntake } = require('./lib/intake-schema');
const { createIdea, getIdeaById, updateIdeaStatus } = require('./lib/ideas-repo');
const { gatherAllEvidence } = require('./lib/evidence-pipeline');
const { insertEvidence, getEvidenceForIdea } = require('./lib/evidence-repo');
const { computeScores } = require('./lib/scoring');
const { insertScores } = require('./lib/scores-repo');
const { determineVerdict, THRESHOLD_VERSION } = require('./lib/verdict');
const { insertVerdict, getLatestVerdictForIdea, countBuildVerdictsThisMonth } = require('./lib/verdicts-repo');
const { runDeliveryStage, runPipeline, runDeltaPipeline } = require('./lib/pipeline');
const { renderVerdictCardSVG } = require('./lib/verdict-card');
const { buildReceipts, renderReceiptsHTML } = require('./lib/receipts');
const { pricingOptions, resolveCurrency } = require('./lib/pricing');
const { evaluateEntitlement } = require('./lib/entitlement');
const {
  createPendingPurchase,
  markPurchasePaid,
  getPurchaseBySessionId,
  countPaidPurchases,
  recordValidationRun,
  countValidationRuns,
  updateValidationRunCost
} = require('./lib/purchases-repo');
const { formatUsageLog } = require('./lib/usage-meter');
const { createCheckoutSession, constructWebhookEvent } = require('./lib/checkout');
const { findOrCreateAccount } = require('./lib/accounts-repo');
const { getFreeVerdict, getLatestFreeVerdictForIdea, createFreeVerdict } = require('./lib/free-verdicts-repo');
const { produceFreeVerdict } = require('./lib/free-verdict');
const { buildCompetitiveAnalysis } = require('./lib/competitive');
const { sseFrame, findingEvent, buildMockStreamSequence } = require('./lib/free-verdict-stream');
const { buildCardData } = require('./lib/card-data');
const { buildSampleReport } = require('./lib/sample-report');
const { getChecks, setCheck } = require('./lib/next-step-checks-repo');
const { assembleSixAnswers } = require('./lib/report-answers');
const { reportToPdf, reportToXlsx } = require('./lib/report-export');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Stripe webhook MUST see the raw, unparsed body to verify the signature, so it
// is registered with a raw body parser BEFORE the global JSON parser below.
// Everything after this line gets parsed JSON as usual.
app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];
  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      // The purchase becomes 'paid' only on a verified completed session. We
      // re-assert Price ID / currency / amount from the session so the stored
      // record reflects exactly what Stripe charged (FR-1.7).
      const currency = (session.currency || (session.metadata && session.metadata.currency) || '').toLowerCase();
      await markPurchasePaid(session.id, {
        currency: currency || undefined,
        amount: session.amount_total != null ? session.amount_total : undefined
      });
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('stripe webhook handling error:', err);
    res.status(500).json({ error: 'Webhook handling failed.' });
  }
});

app.use(express.json());
app.use(express.static(path.join(process.cwd())));

// ─── Intake (Step 1 schema + Step 2 persistence) ────────────────────────────────

app.post('/ideas', async (req, res) => {
  const { valid, errors } = validateIntake(req.body);
  if (!valid) {
    return res.status(400).json({ errors });
  }

  try {
    // Step 11.5 (FR-1.12): an optional lightweight account link. When an
    // account_ref is supplied, the idea is attributed to that account so the
    // one-free-verdict-per-idea rule (FR-1.9) can be enforced per account.
    let accountId;
    if (req.body.account_ref) {
      const account = await findOrCreateAccount(req.body.account_ref);
      accountId = account.id;
    }
    const idea = await createIdea({ ...req.body, account_id: accountId });
    res.status(201).json(idea);
  } catch (err) {
    console.error('createIdea error:', err);
    res.status(500).json({ error: 'Failed to save idea.' });
  }
});

// ─── Evidence (Step 3 pipeline) ─────────────────────────────────────────────────

app.post('/ideas/:id/evidence', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  try {
    await updateIdeaStatus(idea.id, 'evidence_gathering');

    const dimensionResults = await gatherAllEvidence(idea);

    for (const result of dimensionResults) {
      if (result.status === 'ok') {
        await insertEvidence(idea.id, result.dimension, result.claims);
      }
    }

    const evidence = await getEvidenceForIdea(idea.id);
    res.status(200).json({
      idea_id: idea.id,
      dimensions: dimensionResults.map((r) => ({
        dimension: r.dimension,
        status: r.status,
        claim_count: r.claims.length
      })),
      evidence
    });
  } catch (err) {
    console.error('evidence gathering error:', err);
    res.status(500).json({ error: 'Failed to gather evidence.' });
  }
});

// ─── Scoring (Step 4 pure-code engine) ──────────────────────────────────────────

app.post('/ideas/:id/score', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  try {
    const evidence = await getEvidenceForIdea(idea.id);
    const computed = computeScores(evidence);

    await insertScores(idea.id, computed);
    await updateIdeaStatus(idea.id, 'scoring');

    res.status(200).json({
      idea_id: idea.id,
      rubric_version: computed.rubric_version,
      dimensions: computed.dimensions,
      total_score: computed.total
    });
  } catch (err) {
    console.error('scoring error:', err);
    res.status(500).json({ error: 'Failed to score idea.' });
  }
});

// ─── Verdict (Step 5 pure-code thresholds) ──────────────────────────────────────

app.post('/ideas/:id/verdict', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  try {
    const evidence = await getEvidenceForIdea(idea.id);
    const computed = computeScores(evidence);
    const verdict = determineVerdict(computed.total);

    const row = await insertVerdict(idea.id, {
      verdict,
      totalScore: computed.total,
      thresholdVersion: THRESHOLD_VERSION
    });
    await updateIdeaStatus(idea.id, 'verdict');

    res.status(200).json({
      idea_id: idea.id,
      verdict,
      total_score: computed.total,
      threshold_version: THRESHOLD_VERSION,
      verdict_id: row.id
    });
  } catch (err) {
    console.error('verdict error:', err);
    res.status(500).json({ error: 'Failed to determine verdict.' });
  }
});

// ─── Voice (Step 6 two-pass voice layer, Step 7 guardrails) ─────────────────────
// Delegates to the shared delivery stage (Step 8) — single source of truth for
// the guardrail-wrapped voice pass. This standalone trigger does NOT advance the
// cursor to 'complete'; the full pipeline runner owns that transition.

app.post('/ideas/:id/voice', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  try {
    const { guarded, updated, nextSteps } = await runDeliveryStage(idea);
    res.status(200).json({
      idea_id: idea.id,
      verdict_id: updated.id,
      verdict: updated.verdict,
      voice_pass_output: updated.voice_pass_output,
      voice_prompt_version: updated.voice_prompt_version,
      next_steps: nextSteps,
      sarcasm_dial: guarded.dialUsed,
      sensitive_input: guarded.sensitiveInput,
      regenerated: guarded.regenerated
    });
  } catch (err) {
    if (err.code === 'NO_VERDICT') {
      return res.status(409).json({ error: 'No verdict to voice. Run POST /ideas/:id/verdict first.' });
    }
    if (err.code === 'GUARDRAIL_RESIDUAL') {
      console.error('guardrail filter: residual violations after dial-0 regeneration:', err.violations);
      return res.status(502).json({ error: 'Reply failed guardrail screening.', violations: err.violations });
    }
    console.error('voice rendering error:', err);
    res.status(500).json({ error: 'Failed to render verdict voice.' });
  }
});

// ─── Full pipeline (Step 8 resumable state machine) ─────────────────────────────
// Runs the validation pipeline from wherever the idea's cursor sits to
// 'complete'. Already-completed stages are skipped, so a crashed/interrupted
// run resumes rather than restarts (Architecture §3).

app.post('/ideas/:id/run', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  try {
    const result = await runPipeline(idea.id);
    res.status(200).json({
      idea_id: idea.id,
      status: result.idea.status,
      resumed_from: result.resumedFrom,
      trace: result.trace
    });
  } catch (err) {
    if (err.code === 'GUARDRAIL_RESIDUAL') {
      return res.status(502).json({ error: 'Reply failed guardrail screening.', violations: err.violations });
    }
    console.error('pipeline run error:', err);
    res.status(500).json({ error: 'Pipeline run failed.' });
  }
});

// ─── Verdict card (Step 9, FR-1.5) ──────────────────────────────────────────────
// Deterministic SVG rendering of the decided verdict — the shareable growth
// artifact. Rendered on demand from the persisted verdict + scores; the stable
// URL is set on the verdict row during the delivery stage.

app.get('/ideas/:id/card.svg', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  try {
    const verdictRow = await getLatestVerdictForIdea(idea.id);
    if (!verdictRow) {
      return res.status(404).json({ error: 'No verdict card yet. Run the verdict stage first.' });
    }

    const evidence = await getEvidenceForIdea(idea.id);
    const scores = computeScores(evidence);
    const svg = renderVerdictCardSVG({
      verdict: verdictRow.verdict,
      totalScore: Number(verdictRow.total_score),
      idea,
      dimensions: scores.dimensions
    });

    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).send(svg);
  } catch (err) {
    console.error('verdict card error:', err);
    res.status(500).json({ error: 'Failed to render verdict card.' });
  }
});

// ─── Evidence receipts (Step 10, FR-1.6) ────────────────────────────────────────
// Every scored claim linked to its source, viewable by the user. PURE CODE — the
// stored, sourced evidence is assembled behind the verdict and grouped by rubric
// dimension, with deterministic per-dimension scores. Transparency is the
// anti-dispute mechanism (Architecture §3: "Disputes are answered with receipts,
// not re-runs"). Two views share one builder: JSON for machines, HTML for humans.

async function loadReceipts(ideaId) {
  const idea = await getIdeaById(ideaId);
  if (!idea) return { notFound: true };
  const evidence = await getEvidenceForIdea(idea.id);
  const verdict = await getLatestVerdictForIdea(idea.id);
  return { receipts: buildReceipts({ idea, evidence, verdict }) };
}

app.get('/ideas/:id/receipts', async (req, res) => {
  try {
    const { notFound, receipts } = await loadReceipts(req.params.id);
    if (notFound) return res.status(404).json({ error: 'Idea not found.' });
    res.status(200).json(receipts);
  } catch (err) {
    console.error('receipts error:', err);
    res.status(500).json({ error: 'Failed to assemble receipts.' });
  }
});

app.get('/ideas/:id/receipts.html', async (req, res) => {
  try {
    const { notFound, receipts } = await loadReceipts(req.params.id);
    if (notFound) return res.status(404).send('Idea not found.');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.status(200).send(renderReceiptsHTML(receipts));
  } catch (err) {
    console.error('receipts html error:', err);
    res.status(500).send('Failed to assemble receipts.');
  }
});

// ─── Pricing, checkout & entitlement (Step 11, FR-1.7) ──────────────────────────
// One-time purchase via Stripe Checkout Sessions. Prices come from config (never
// hardcoded): ₹1,499 (INR) for India-detected users, $39 (USD) for everyone else,
// with a visible currency selector override. One paid purchase entitles the
// initial validation plus one free re-validation; the third run is blocked.

// Region-detected pricing + both options, so the client can render the selector
// with the detected region preselected. ?currency=inr|usd overrides detection.
app.get('/pricing', (req, res) => {
  try {
    res.status(200).json(pricingOptions(req, req.query.currency));
  } catch (err) {
    console.error('pricing error:', err);
    res.status(500).json({ error: 'Failed to resolve pricing.' });
  }
});

// Opens a one-time Checkout Session for an idea in the resolved currency and
// records a pending purchase (Stripe Price ID + currency + amount) to reconcile
// against the webhook.
app.post('/ideas/:id/checkout', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  try {
    const override = (req.body && req.body.currency) || req.query.currency;
    const { currency } = resolveCurrency(req, override);
    const { session, stripePriceId, amount } = await createCheckoutSession({ ideaId: idea.id, currency });

    await createPendingPurchase({
      ideaId: idea.id,
      stripeSessionId: session.id,
      stripePriceId,
      currency,
      amount
    });

    res.status(201).json({
      idea_id: idea.id,
      checkout_url: session.url,
      session_id: session.id,
      currency,
      amount,
      stripe_price_id: stripePriceId
    });
  } catch (err) {
    console.error('checkout error:', err);
    res.status(500).json({ error: 'Failed to open checkout.' });
  }
});

// Current entitlement for an idea: how many paid purchases, runs used, and
// whether another validation run is allowed. Pure count-based rule (FR-1.7).
async function entitlementFor(ideaId) {
  const [paidPurchases, runsUsed] = await Promise.all([
    countPaidPurchases(ideaId),
    countValidationRuns(ideaId)
  ]);
  return evaluateEntitlement({ paidPurchases, runsUsed });
}

app.get('/ideas/:id/entitlement', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }
  try {
    const ent = await entitlementFor(idea.id);
    res.status(200).json({ idea_id: idea.id, ...ent });
  } catch (err) {
    console.error('entitlement error:', err);
    res.status(500).json({ error: 'Failed to read entitlement.' });
  }
});

// Entitlement-GATED validation run. Unlike the raw POST /ideas/:id/run (used by
// tests and the batch runner), this is the paid product action: it blocks the
// third run with 402 until a new purchase, records the consumed run, then runs
// the full pipeline. The rule is identical for INR and USD buyers.
app.post('/ideas/:id/validate', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  try {
    const ent = await entitlementFor(idea.id);
    if (!ent.allowed) {
      return res.status(402).json({
        error: ent.reason === 'no_purchase'
          ? 'No purchase found. Buy a validation to continue.'
          : 'Free re-validation used. Buy another validation to run again.',
        ...ent
      });
    }

    // Consume the run BEFORE the pipeline so a concurrent duplicate can't slip a
    // third run through; the ledger is the source of truth.
    const runRow = await recordValidationRun(idea.id, null);

    // The first entitled run is a FULL deep gather; the free re-validation is a
    // DELTA run that reuses fresh evidence and refreshes only stale dimensions —
    // that is what keeps the "free" run genuinely cheap (cost optimization).
    const isRevalidation = ent.reason === 'free_revalidation';
    const result = isRevalidation
      ? await runDeltaPipeline(idea.id)
      : await runPipeline(idea.id);

    // Persist the measured API cost of this run onto its ledger row, and log it.
    await updateValidationRunCost(runRow.id, result.usage);
    console.log(`[cost] validate idea=${idea.id} run=${runRow.id} mode=${isRevalidation ? 'delta' : 'full'} — ${formatUsageLog(result.usage)}`);

    const after = await entitlementFor(idea.id);

    res.status(200).json({
      idea_id: idea.id,
      status: result.idea.status,
      mode: isRevalidation ? 'delta' : 'full',
      resumed_from: result.resumedFrom,
      trace: result.trace,
      cost: result.usage.totals,
      entitlement: after
    });
  } catch (err) {
    if (err.code === 'GUARDRAIL_RESIDUAL') {
      return res.status(502).json({ error: 'Reply failed guardrail screening.', violations: err.violations });
    }
    console.error('validate run error:', err);
    res.status(500).json({ error: 'Validation run failed.' });
  }
});

// ─── Freemium two-tier gate (Step 11.5, FR-1.9/1.10/1.11) ───────────────────────
// FREE tier: one verdict per idea, per account — score + BUILD/PIVOT/BURY + roast
// from a QUICK evidence pass, with the paid sections LOCKED and teased from the
// user's own real content (ordered: next steps, competitive analysis, evidence).
// PAID tier: the Step-11 checkout (unchanged mechanically) is the "Unlock your
// next steps + full report" action; the deep run + full report follow.

// The free verdict. Requires an account_ref so the one-per-(account, idea) rule
// is enforced. A second attempt on the same pair is blocked (409) pending unlock.
// The LIVE free-verdict stream (The Professor's Stage, Screen 3). Runs the quick
// pass and emits, over Server-Sent Events: a `finding` event per dimension as it
// settles (real observed counts), a `progress` event with the running source
// count, then a terminal `verdict` event carrying the same payload the blocking
// endpoint returns. `?mock=1` replays a seeded, credit-free sequence so the wait
// screen is inspectable offline with NO LLM call (and touches no DB).
app.get('/ideas/:id/free-verdict/stream', async (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  res.flushHeaders && res.flushHeaders();

  const send = (event, data) => res.write(sseFrame(event, data));

  // Mock mode: replay the seeded sequence, no DB, no LLM. This is the path the
  // Done-When verifies (credits are empty).
  if (req.query.mock === '1' || req.query.mock === 'true') {
    for (const ev of buildMockStreamSequence()) {
      send(ev.event, ev.data);
    }
    send('done', { ok: true });
    return res.end();
  }

  // Real mode: mirrors the blocking POST endpoint's guard rails, but streams.
  try {
    const idea = await getIdeaById(req.params.id);
    if (!idea) {
      send('error', { error: 'Idea not found.' });
      return res.end();
    }

    const accountRef = (req.query.account_ref) || idea.account_ref;
    if (!accountRef && !idea.account_id) {
      send('error', { error: 'account_ref is required for a free verdict.' });
      return res.end();
    }

    let accountId = idea.account_id;
    if (!accountId) {
      const account = await findOrCreateAccount(accountRef);
      accountId = account.id;
    }

    // FR-1.9: one free verdict per (account, idea).
    const existing = await getFreeVerdict(accountId, idea.id);
    if (existing) {
      send('blocked', {
        error: 'This idea already used its one free verdict on this account.',
        unlock: { action: 'Unlock your next steps + full report', checkout: `/ideas/${idea.id}/checkout` }
      });
      return res.end();
    }

    // Stream each dimension's finding as it settles; keep the running counter.
    let cumulativeSources = 0;
    const free = await produceFreeVerdict(idea, {
      onDimension: (r) => {
        cumulativeSources += r.sources_examined || 0;
        send('finding', findingEvent(r, cumulativeSources));
      }
    });
    send('progress', { sources_examined: cumulativeSources, dimensions_complete: free.shallow.dimensions.length });
    console.log(`[cost] free-verdict(stream) idea=${idea.id} account=${accountId} — ${formatUsageLog(free.cost)}`);

    let row;
    try {
      row = await createFreeVerdict({
        accountId,
        ideaId: idea.id,
        verdict: free.verdict,
        totalScore: free.total_score,
        roast: free.roast,
        payload: {
          quick_pass_label: free.shallow.quick_pass_label,
          shallow: free.shallow,
          locked_sections: free.locked_sections,
          sarcasm_dial: free.sarcasm_dial,
          sensitive_input: free.sensitive_input,
          regenerated: free.regenerated,
          cost: free.cost
        }
      });
    } catch (e) {
      if (e.code === 'FREE_VERDICT_EXISTS') {
        send('blocked', { error: 'This idea already used its one free verdict on this account.' });
        return res.end();
      }
      throw e;
    }

    send('verdict', {
      idea_id: idea.id,
      free_verdict_id: row.id,
      tier: 'free',
      quick_pass_label: free.shallow.quick_pass_label,
      verdict: free.verdict,
      total_score: free.total_score,
      roast: free.roast,
      locked_sections: free.locked_sections,
      unlock: { action: 'Unlock your next steps + full report', checkout: `/ideas/${idea.id}/checkout` },
      sarcasm_dial: free.sarcasm_dial,
      sensitive_input: free.sensitive_input,
      cost: free.cost.totals
    });
    send('done', { ok: true });
    res.end();
  } catch (err) {
    if (err.code === 'GUARDRAIL_RESIDUAL') {
      send('error', { error: 'Free verdict failed guardrail screening.', violations: err.violations });
    } else {
      console.error('free verdict stream error:', err);
      send('error', { error: 'Failed to produce free verdict.' });
    }
    res.end();
  }
});

app.post('/ideas/:id/free-verdict', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  const accountRef = (req.body && req.body.account_ref) || idea.account_ref;
  if (!accountRef && !idea.account_id) {
    return res.status(400).json({ error: 'account_ref is required for a free verdict.' });
  }

  try {
    // Resolve the account: prefer the idea's existing link, else the supplied ref.
    let accountId = idea.account_id;
    if (!accountId) {
      const account = await findOrCreateAccount(accountRef);
      accountId = account.id;
    }

    // FR-1.9: exactly one free verdict per (account, idea). A second attempt is
    // blocked pending unlock (the pre-check; the DB unique constraint backs it up).
    const existing = await getFreeVerdict(accountId, idea.id);
    if (existing) {
      return res.status(409).json({
        error: 'This idea already used its one free verdict on this account. Unlock the full report to go deeper.',
        blocked: true,
        idea_id: idea.id,
        unlock: { action: 'Unlock your next steps + full report', checkout: `/ideas/${idea.id}/checkout` }
      });
    }

    const free = await produceFreeVerdict(idea);
    console.log(`[cost] free-verdict idea=${idea.id} account=${accountId} — ${formatUsageLog(free.cost)}`);

    let row;
    try {
      row = await createFreeVerdict({
        accountId,
        ideaId: idea.id,
        verdict: free.verdict,
        totalScore: free.total_score,
        roast: free.roast,
        payload: {
          quick_pass_label: free.shallow.quick_pass_label,
          shallow: free.shallow,
          locked_sections: free.locked_sections,
          sarcasm_dial: free.sarcasm_dial,
          sensitive_input: free.sensitive_input,
          regenerated: free.regenerated,
          // Measured API cost of this free verdict (there is no validation_runs
          // row for the free tier, so the cost lives on the free_verdict record).
          cost: free.cost
        }
      });
    } catch (e) {
      // Lost the one-per race to a concurrent request — treat as blocked.
      if (e.code === 'FREE_VERDICT_EXISTS') {
        return res.status(409).json({ error: 'This idea already used its one free verdict on this account.', blocked: true });
      }
      throw e;
    }

    // The free SCREEN: verdict + score + roast, and the LOCKED sections in order
    // (FR-1.11). The shallow full content stays server-side (in the ledger).
    res.status(201).json({
      idea_id: idea.id,
      free_verdict_id: row.id,
      tier: 'free',
      quick_pass_label: free.shallow.quick_pass_label,
      verdict: free.verdict,
      total_score: free.total_score,
      roast: free.roast,
      locked_sections: free.locked_sections,
      unlock: { action: 'Unlock your next steps + full report', checkout: `/ideas/${idea.id}/checkout` },
      sarcasm_dial: free.sarcasm_dial,
      sensitive_input: free.sensitive_input,
      cost: free.cost.totals
    });
  } catch (err) {
    if (err.code === 'GUARDRAIL_RESIDUAL') {
      return res.status(502).json({ error: 'Free verdict failed guardrail screening.', violations: err.violations });
    }
    console.error('free verdict error:', err);
    res.status(500).json({ error: 'Failed to produce free verdict.' });
  }
});

// The PAID full report (FR-1.10). Gated on a paid unlock: no purchase → 402. The
// report LEADS WITH THE NEXT STEPS, then competitive analysis, then evidence
// receipts — the paid-tier order (03-AI Rules §3.2). Assembled from the DEEP
// evidence run persisted by POST /ideas/:id/validate.
app.get('/ideas/:id/report', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) {
    return res.status(404).json({ error: 'Idea not found.' });
  }

  try {
    const paidPurchases = await countPaidPurchases(idea.id);
    if (paidPurchases < 1) {
      return res.status(402).json({
        error: 'Locked. Unlock your next steps + full report to view this.',
        locked: true,
        unlock: { action: 'Unlock your next steps + full report', checkout: `/ideas/${idea.id}/checkout` }
      });
    }

    const verdict = await getLatestVerdictForIdea(idea.id);
    if (!verdict || !verdict.voice_pass_output) {
      return res.status(409).json({ error: 'Full report not generated yet. Run POST /ideas/:id/validate after unlocking.' });
    }

    const evidence = await getEvidenceForIdea(idea.id);
    const competitive = buildCompetitiveAnalysis({ evidence });
    const receipts = buildReceipts({ idea, evidence, verdict });
    // Screen 5 "The Six Answers": 1–4 from evidence/competitive, 5–6 the deep
    // run's schema-enforced generated fields (verdicts.six_answers).
    const sixAnswers = assembleSixAnswers({ idea, evidence, competitive, sixAnswers: verdict.six_answers });

    // Lead with the next steps (FR-1.10 / §3.2), then competitive, then evidence.
    res.status(200).json({
      idea_id: idea.id,
      tier: 'paid',
      verdict: verdict.verdict,
      total_score: Number(verdict.total_score),
      next_steps: verdict.next_steps || [],
      six_answers: sixAnswers,
      competitive_analysis: competitive,
      evidence_receipts: receipts,
      roast: verdict.voice_pass_output,
      card_asset_url: verdict.card_asset_url
    });
  } catch (err) {
    console.error('report error:', err);
    res.status(500).json({ error: 'Failed to assemble full report.' });
  }
});

// ─── The Professor's Stage: card data, sample report, checkbox state ─────────────

// Screen 4 verdict-card data: the comedic REAL-data fields for the matching
// verdict format (obituary / driving-test / certificate) + letterhead + the
// "1 of N this month" count. Free tier — no payment required. Prefers the deep
// verdict; falls back to the idea's free verdict (the reveal fires right after it).
app.get('/ideas/:id/card-data', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found.' });

  try {
    const deep = await getLatestVerdictForIdea(idea.id);
    let verdict; let scores; let evidence; let createdAt; let verdictNumber;

    if (deep) {
      evidence = await getEvidenceForIdea(idea.id);
      scores = computeScores(evidence);
      verdict = deep.verdict;
      createdAt = deep.created_at;
      verdictNumber = String(deep.id).slice(0, 8).toUpperCase();
    } else {
      const free = await getLatestFreeVerdictForIdea(idea.id);
      if (!free) return res.status(409).json({ error: 'No verdict yet. Produce a free verdict first.' });
      // The free tier's shallow evidence lives in the payload, not the evidence table.
      evidence = (free.payload && free.payload.shallow && free.payload.shallow.evidence) || [];
      scores = computeScores(evidence);
      verdict = free.verdict;
      createdAt = free.created_at;
      verdictNumber = String(free.id).slice(0, 8).toUpperCase();
    }

    const elapsedMs = idea.created_at && createdAt
      ? Math.max(0, new Date(createdAt).getTime() - new Date(idea.created_at).getTime())
      : 0;
    const buildsThisMonth = verdict === 'BUILD' ? await countBuildVerdictsThisMonth() : undefined;

    const cardData = buildCardData({ idea, verdict, scores, evidence, elapsedMs, verdictNumber, buildsThisMonth });
    res.status(200).json(cardData);
  } catch (err) {
    console.error('card-data error:', err);
    res.status(500).json({ error: 'Failed to build card data.' });
  }
});

// A permanently public, complete six-answer sample report (seeded data). No auth,
// no payment — lets a visitor see the full paid product before buying, and keeps
// the report UI inspectable offline (no LLM call).
app.get('/sample', (req, res) => {
  try {
    res.status(200).json(buildSampleReport());
  } catch (err) {
    console.error('sample report error:', err);
    res.status(500).json({ error: 'Failed to build sample report.' });
  }
});

// Public, non-secret front-end config. Keeps user-facing URLs (like the build
// guide the BUILD report bridges into) out of hardcoded copy and in env.
app.get('/public-config', (req, res) => {
  res.status(200).json({
    guide_url: process.env.GUIDE_URL || 'https://professorviva.com/guide/zero-to-running-app'
  });
});

// Public sample exports — the /sample report as PDF / Excel, no gate. Lets the
// Screen 5 download buttons be inspected offline (no LLM, no purchase) and mirrors
// the real report.pdf / report.xlsx exactly (same generator).
app.get('/sample/report.pdf', async (req, res) => {
  try {
    const pdf = await reportToPdf(buildSampleReport());
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="professor-viva-sample.pdf"' });
    res.status(200).send(pdf);
  } catch (err) {
    console.error('sample report.pdf error:', err);
    res.status(500).json({ error: 'Failed to generate sample PDF.' });
  }
});

app.get('/sample/report.xlsx', async (req, res) => {
  try {
    const xlsx = await reportToXlsx(buildSampleReport());
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="professor-viva-sample.xlsx"'
    });
    res.status(200).send(xlsx);
  } catch (err) {
    console.error('sample report.xlsx error:', err);
    res.status(500).json({ error: 'Failed to generate sample Excel.' });
  }
});

// Persisted next-step checkbox state for the unlocked report (per account).
// GET returns the { step_index: checked } map; PUT upserts one step's state.
app.get('/ideas/:id/report/checks', async (req, res) => {
  const accountRef = req.query.account_ref;
  if (!accountRef) return res.status(400).json({ error: 'account_ref is required.' });
  try {
    const idea = await getIdeaById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found.' });
    const verdict = await getLatestVerdictForIdea(idea.id);
    if (!verdict) return res.status(409).json({ error: 'No verdict yet.' });
    const account = await findOrCreateAccount(accountRef);
    const checks = await getChecks(account.id, verdict.id);
    res.status(200).json({ verdict_id: verdict.id, checks });
  } catch (err) {
    console.error('get checks error:', err);
    res.status(500).json({ error: 'Failed to read checkbox state.' });
  }
});

app.put('/ideas/:id/report/checks', async (req, res) => {
  const accountRef = req.body && req.body.account_ref;
  const stepIndex = req.body && req.body.step_index;
  const checked = req.body && req.body.checked;
  if (!accountRef) return res.status(400).json({ error: 'account_ref is required.' });
  if (!Number.isInteger(stepIndex) || stepIndex < 0) return res.status(400).json({ error: 'step_index must be a non-negative integer.' });
  if (typeof checked !== 'boolean') return res.status(400).json({ error: 'checked must be a boolean.' });
  try {
    const idea = await getIdeaById(req.params.id);
    if (!idea) return res.status(404).json({ error: 'Idea not found.' });
    const verdict = await getLatestVerdictForIdea(idea.id);
    if (!verdict) return res.status(409).json({ error: 'No verdict yet.' });
    const account = await findOrCreateAccount(accountRef);
    await setCheck(account.id, verdict.id, stepIndex, checked);
    const checks = await getChecks(account.id, verdict.id);
    res.status(200).json({ verdict_id: verdict.id, checks });
  } catch (err) {
    console.error('put check error:', err);
    res.status(500).json({ error: 'Failed to save checkbox state.' });
  }
});

// Assembles the unlocked report's data for export. Shared by the PDF + XLSX
// routes. Enforces the SAME 402 unlock gate as GET /report; returns { locked }
// or { notReady } so the route can map to the right status. No LLM call.
async function assembleUnlockedReport(idea) {
  const paidPurchases = await countPaidPurchases(idea.id);
  if (paidPurchases < 1) return { locked: true };
  const verdict = await getLatestVerdictForIdea(idea.id);
  if (!verdict || !verdict.voice_pass_output) return { notReady: true };

  const evidence = await getEvidenceForIdea(idea.id);
  const competitive = buildCompetitiveAnalysis({ evidence });
  const receipts = buildReceipts({ idea, evidence, verdict });
  const six_answers = assembleSixAnswers({ idea, evidence, competitive, sixAnswers: verdict.six_answers });
  return {
    report: {
      idea,
      verdict: verdict.verdict,
      total_score: Number(verdict.total_score),
      roast: verdict.voice_pass_output,
      next_steps: verdict.next_steps || [],
      six_answers,
      competitive_analysis: competitive,
      evidence_receipts: receipts,
      evidence
    }
  };
}

function gateExport(result, res) {
  if (result.locked) {
    res.status(402).json({ error: 'Locked. Unlock your next steps + full report to download.', locked: true });
    return false;
  }
  if (result.notReady) {
    res.status(409).json({ error: 'Full report not generated yet. Run POST /ideas/:id/validate after unlocking.' });
    return false;
  }
  return true;
}

// PDF export — unlocked reports only (same 402 gate as /report).
app.get('/ideas/:id/report.pdf', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found.' });
  try {
    const result = await assembleUnlockedReport(idea);
    if (!gateExport(result, res)) return;
    const pdf = await reportToPdf(result.report);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="professor-viva-${idea.id}.pdf"` });
    res.status(200).send(pdf);
  } catch (err) {
    console.error('report.pdf error:', err);
    res.status(500).json({ error: 'Failed to generate PDF.' });
  }
});

// Excel export (evidence table) — unlocked reports only.
app.get('/ideas/:id/report.xlsx', async (req, res) => {
  const idea = await getIdeaById(req.params.id);
  if (!idea) return res.status(404).json({ error: 'Idea not found.' });
  try {
    const result = await assembleUnlockedReport(idea);
    if (!gateExport(result, res)) return;
    const xlsx = await reportToXlsx(result.report);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="professor-viva-${idea.id}.xlsx"`
    });
    res.status(200).send(xlsx);
  } catch (err) {
    console.error('report.xlsx error:', err);
    res.status(500).json({ error: 'Failed to generate Excel.' });
  }
});

// ─── Roast database ────────────────────────────────────────────────────────────

const roasts = {
  ai: [
    {
      roast: "Oh wonderful. ANOTHER AI wrapper. You took OpenAI's API, put a thin layer of CSS on top, and now you expect venture capitalists to give you seventeen million dollars. Brilliant. Absolutely brilliant. My peon in 1998 had more original ideas, and he was asleep.",
      mood: "Furious",
      originality: 1,
      execution: 3,
      delusion: 9,
      survival: 4,
      emoji: "😤"
    },
    {
      roast: "Let me understand. You wrapped GPT-4 in a Next.js app, gave it a name that ends in '.ai', and you think this is a startup. This is not a startup. This is a weekend project that escaped. The moment OpenAI adds one more feature, your entire company is deprecated like Internet Explorer.",
      mood: "Deeply Disappointed",
      originality: 2,
      execution: 4,
      delusion: 8,
      survival: 7,
      emoji: "😑"
    },
    {
      roast: "AI-powered, you say. Everything is AI-powered now! My toaster has AI! My neighbour's dog has AI! What specific problem does YOUR AI solve that cannot be solved by asking ChatGPT directly? ... No? Nothing? Thought so. Next.",
      mood: "Exasperated",
      originality: 2,
      execution: 5,
      delusion: 8,
      survival: 6,
      emoji: "👏"
    }
  ],
  marketplace: [
    {
      roast: "Ah yes, a marketplace. The classic chicken-and-egg problem, now served fresh with YOUR special ignorance sauce. Tell me — who comes first? The buyers with no sellers, or the sellers with no buyers? You need BOTH and you have NEITHER. This is not a business plan, this is an existential crisis.",
      mood: "Philosophically Furious",
      originality: 3,
      execution: 9,
      delusion: 8,
      survival: 9,
      emoji: "😤"
    },
    {
      roast: "A two-sided marketplace. Very good. Very brave. Amazon tried this and they had to BUILD THEIR OWN INVENTORY for years. You have seventeen thousand rupees and a LinkedIn profile. Best of luck with your liquidity problem, which will begin on day one and end on the day you shut down.",
      mood: "Sarcastically Supportive",
      originality: 3,
      execution: 9,
      delusion: 7,
      survival: 12,
      emoji: "👏"
    }
  ],
  uber: [
    {
      roast: "Uber for X. The laziest category of startup known to humankind. Uber for dog grooming. Uber for groceries. Uber for prayers. Listen — Uber ITSELF is barely profitable after fifteen years and twelve billion dollars! You want to do this for... laundry? With what funding? Your optimism?",
      mood: "Historically Offended",
      originality: 1,
      execution: 8,
      delusion: 9,
      survival: 5,
      emoji: "😤"
    },
    {
      roast: "Oh very nice. Uber for X. You know what happened to all the Uber-for-X companies? They either got acquired for nothing, or they died quietly while their founders blamed 'market timing'. The market timing was fine. The idea was the problem.",
      mood: "Clinically Disappointed",
      originality: 1,
      execution: 7,
      delusion: 7,
      survival: 8,
      emoji: "😑"
    }
  ],
  saas: [
    {
      roast: "Another SaaS dashboard. With another subscription. For another workflow that could be handled by a Google Sheet. Tell me — what does your dashboard SHOW that Microsoft Excel, built in 1987, cannot already do? Take your time. I have tenure. I am not going anywhere.",
      mood: "Patiently Furious",
      originality: 3,
      execution: 5,
      delusion: 7,
      survival: 15,
      emoji: "🤨"
    },
    {
      roast: "SaaS, forty-nine dollars per month, unlimited users, cancel anytime. I have seen this landing page. I have seen it four hundred times. What is your CAC? What is your LTV? What is your churn? You don't know, do you. You don't know because you haven't launched. You haven't launched because deep down, you know.",
      mood: "Prophetically Grim",
      originality: 4,
      execution: 6,
      delusion: 7,
      survival: 11,
      emoji: "😑"
    }
  ],
  creator: [
    {
      roast: "A platform for creators. Wonderful. You want to compete with YouTube, Substack, Patreon, TikTok, Instagram, Gumroad, Beehiiv, and seventeen other platforms — all of whom have a head start of approximately ten years and two billion dollars. What is your differentiation? 'Better community'. That is not a moat. That is a puddle.",
      mood: "Exhausted",
      originality: 2,
      execution: 8,
      delusion: 8,
      survival: 6,
      emoji: "😑"
    },
    {
      roast: "Creator economy! Everyone is talking about creator economy! You know what creators want? MONEY. Not another platform with better analytics and a 'supportive community'. They want money. You are going to give them community. They will leave you for Patreon in three months.",
      mood: "Prophetically Correct",
      originality: 3,
      execution: 7,
      delusion: 7,
      survival: 8,
      emoji: "😤"
    }
  ],
  random: [
    {
      roast: "I have been a professor for twenty-three years. I have reviewed four hundred and twelve business ideas. Yours is, without question, among the four hundred and twelve. The market you are targeting does not know it needs your solution because it does not. The problem you are solving is a problem you invented to justify the solution you already built.",
      mood: "Professionally Defeated",
      originality: 5,
      execution: 6,
      delusion: 7,
      survival: 18,
      emoji: "😑"
    },
    {
      roast: "Very bold idea. Very bold. Tell me — have you done any customer discovery? Have you spoken to even ONE potential user? No? You have spoken to your friends and family who said 'wow what a great idea'? Those people LOVE you. They are LYING to you. That is what love does. The market does not love you.",
      mood: "Tenderly Brutal",
      originality: 5,
      execution: 6,
      delusion: 8,
      survival: 20,
      emoji: "🤨"
    },
    {
      roast: "Congratulations. You have identified a problem, imagined a solution, and skipped every step in between. There is no go-to-market. There is no revenue model. There is no moat. There is only vibes and a Figma prototype your cousin made. This is not a startup. This is a mood board.",
      mood: "Architecturally Appalled",
      originality: 4,
      execution: 7,
      delusion: 8,
      survival: 14,
      emoji: "👏"
    },
    {
      roast: "You know what I find remarkable? Your confidence. To walk in here, state this idea with a straight face, and expect validation — that alone shows founder potential. Unfortunately, founder potential and a viable business are two completely separate things, and you currently possess only one of them.",
      mood: "Backhanded Encouragement",
      originality: 5,
      execution: 5,
      delusion: 9,
      survival: 22,
      emoji: "👏"
    },
    {
      roast: "First of all — what problem are you solving? Second of all — for whom? Third of all — why you? Fourth of all — why now? You have answered none of these questions. You have, however, given me a very detailed description of the app's UI. I am not a designer. I am your target customer. And I am walking away.",
      mood: "Methodically Unimpressed",
      originality: 4,
      execution: 6,
      delusion: 7,
      survival: 16,
      emoji: "😑"
    },
    {
      roast: "I see you have done a competitor analysis. You have found that there are no direct competitors. Do you know what no direct competitors means? It means either you have found a genuine gap in the market — which happens once per decade — or, far more likely, it means others have tried this and quietly given up. Which do you think is more probable?",
      mood: "Statistically Grim",
      originality: 6,
      execution: 7,
      delusion: 6,
      survival: 19,
      emoji: "🤨"
    }
  ]
};

function getRoast(idea) {
  const lower = idea.toLowerCase();
  let pool;

  if (lower.includes('ai') || lower.includes('artificial intelligence') || lower.includes('machine learning') || lower.includes('llm') || lower.includes('gpt') || lower.includes('chatbot')) {
    pool = roasts.ai;
  } else if (lower.includes('marketplace') || lower.includes('platform') && (lower.includes('buy') || lower.includes('sell') || lower.includes('connect'))) {
    pool = roasts.marketplace;
  } else if (lower.includes('uber') || lower.includes('uber for') || lower.includes('airbnb for') || lower.includes('tinder for')) {
    pool = roasts.uber;
  } else if (lower.includes('saas') || lower.includes('dashboard') || lower.includes('subscription') || lower.includes('b2b')) {
    pool = roasts.saas;
  } else if (lower.includes('creator') || lower.includes('influencer') || lower.includes('content creator') || lower.includes('newsletter')) {
    pool = roasts.creator;
  } else {
    pool = roasts.random;
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

// ─── Routes ────────────────────────────────────────────────────────────────────

app.post('/roast', (req, res) => {
  const { idea } = req.body;

  if (!idea || typeof idea !== 'string' || idea.trim().length < 3) {
    return res.status(400).json({ error: 'Please provide a startup idea.' });
  }

  if (idea.trim().length > 2000) {
    return res.status(400).json({ error: 'Idea too long. Professors have limited patience.' });
  }

  const result = getRoast(idea.trim());
  res.json(result);
});

app.post('/speak', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'No text provided.' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.VOICE_ID;

  if (!apiKey || !voiceId) {
    return res.status(503).json({ error: 'TTS not configured.' });
  }

  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg'
      },
      body: JSON.stringify({
        text: text.slice(0, 500),
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75,
          style: 0.6,
          use_speaker_boost: true
        }
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('ElevenLabs error:', err);
      return res.status(502).json({ error: 'TTS service error.' });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    response.body.pipe(res);
  } catch (err) {
    console.error('TTS fetch error:', err);
    res.status(500).json({ error: 'Failed to generate speech.' });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Professor Viva is ready to judge at http://localhost:${PORT}`);
  });
}

module.exports = app;
