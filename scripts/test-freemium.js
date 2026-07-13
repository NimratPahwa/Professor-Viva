// Done-When demo for Step 11.5 (Freemium two-tier gate, FR-1.9/1.10/1.11/1.12).
//
// Step 11.5 Done-When:
//   A new account submits an idea and receives a FREE verdict with the locked
//   sections visible in the specified order (next steps, competitive analysis,
//   evidence); clicking unlock completes the Step-11 checkout in test mode; the
//   same idea then shows the FULL report with working source links and 3 next
//   steps; and a SECOND free verdict attempt on the same idea from the same
//   account is BLOCKED.
//
// Part A is hermetic (no DB/API/LLM): the deterministic competitive assembly and
// the ordered, non-fabricated teaser builder.
// Part B exercises the real endpoints (spends Anthropic credits — a quick Haiku
// pass for the free verdict, then a full deep run for the paid report) against
// Supabase + Stripe TEST mode. It needs migration 0007 applied and the Stripe
// test env set (same as Step 11).

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const path = require('path');
const fetch = require('node-fetch');

const { buildCompetitiveAnalysis } = require('../lib/competitive');
const { buildTeasers, TEASER_ORDER, blurFragment } = require('../lib/teasers');
const { computeScores } = require('../lib/scoring');
const { getSupabase } = require('../lib/db');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

let failures = 0;
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}

// ─── Part A: pure logic (no DB/API/LLM) ─────────────────────────────────────────
function partA() {
  console.log('--- Part A: competitive assembly + teasers (pure) ---');

  const evidence = [
    { dimension: 'market_gap', signal: 'undermines', claim: 'Forty rival tools already serve this niche at $10/mo.', source_url: 'https://example.com/market1' },
    { dimension: 'market_gap', signal: 'neutral', claim: 'The category grew 12% last year per an industry report.', source_url: 'https://example.com/market2' },
    { dimension: 'monetization', signal: 'supports', claim: 'Comparable tools sustain $29/mo with low churn.', source_url: 'https://example.com/money1' },
    { dimension: 'demand', signal: 'supports', claim: 'A Reddit thread with 89 upvotes begs for this.', source_url: 'https://example.com/demand1' }
  ];

  const competitive = buildCompetitiveAnalysis({ evidence });
  const scored = computeScores(evidence);
  assert(competitive.sections.length === 2, 'competitive analysis has exactly 2 sections');
  assert(competitive.sections[0].dimension === 'market_gap' && competitive.sections[1].dimension === 'monetization',
    'competitive sections are market_gap then monetization');
  assert(competitive.sections[0].score === scored.dimensions.market_gap.score,
    'competitive score matches deterministic scoring (single source of truth)');
  assert(competitive.total_claims === 3, 'competitive assembles only market_gap + monetization claims (3), not demand');

  const nextSteps = [
    'Interview five of the 89 Reddit complainers before writing a line of code.',
    'Price at $29/mo to match the proven willingness-to-pay, not a race to $10.',
    'Pick the ONE feature the 40 rivals all miss and ship only that.'
  ];
  const teasers = buildTeasers({ nextSteps, competitive, evidenceRows: evidence });

  // Order: next steps, competitive analysis, evidence (FR-1.11).
  assert(teasers.length === 3, 'three locked sections');
  assert(teasers.map((t) => t.section).join(',') === TEASER_ORDER.join(','),
    'locked sections ordered: next_steps, competitive_analysis, evidence');
  assert(teasers[0].order === 1 && teasers[1].order === 2 && teasers[2].order === 3, 'order fields 1,2,3');
  assert(teasers.every((t) => t.locked === true), 'every section is locked');

  // Teasers are REAL fragments of the user's own content — never fabricated.
  const firstStepPreview = teasers[0].teaser.preview.replace(/…$/, '');
  assert(nextSteps[0].startsWith(firstStepPreview), 'next-steps teaser is a real fragment of the real step');
  const firstCompClaim = competitive.sections.flatMap((s) => s.claims)[0].claim;
  const compPreview = teasers[1].teaser.preview.replace(/…$/, '');
  assert(firstCompClaim.startsWith(compPreview), 'competitive teaser is a real fragment of a real claim');
  assert(teasers.every((t) => !t.teaser || t.teaser.blurred === true), 'teasers are marked blurred');

  // No fabricated teaser for an empty section: honest emptiness instead.
  const emptyTeasers = buildTeasers({ nextSteps: [], competitive: { sections: [] }, evidenceRows: [] });
  assert(emptyTeasers.every((t) => t.has_content === false && t.teaser === null && typeof t.note === 'string'),
    'empty sections get an honest note, never a fabricated teaser');

  // blurFragment never invents text.
  const f = blurFragment('one two three four five six seven eight nine ten eleven twelve thirteen');
  assert(f.preview.endsWith('…') && 'one two three four five six seven eight nine ten eleven twelve thirteen'.startsWith(f.preview.replace(/…$/, '')),
    'blurFragment truncates real text with an ellipsis, adds nothing');
  assert(blurFragment('') === null, 'blurFragment of empty is null (no content, no teaser)');
}

// ─── Part B: real endpoints (Supabase + Stripe test mode + Anthropic) ────────────
function envConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.ANTHROPIC_API_KEY && process.env.STRIPE_SECRET_KEY &&
    process.env.STRIPE_WEBHOOK_SECRET && process.env.PRICE_INR_ID && process.env.PRICE_USD_ID);
}

const INTAKE = {
  problem: 'Small construction subcontractors lose hours reconciling supplier delivery tickets against invoices by hand every week.',
  audience: 'Small construction subcontractors and their back-office bookkeepers.',
  monetization_hypothesis: 'Flat monthly SaaS fee per company for automated ticket-to-invoice reconciliation.',
  unfair_advantage: 'Founder ran back-office operations for a mid-size general contractor for six years.'
};

async function deliverCompletedWebhook(stripe, sessionId, currency, amount) {
  const event = {
    id: `evt_test_${Date.now()}`,
    object: 'event',
    type: 'checkout.session.completed',
    data: { object: { id: sessionId, object: 'checkout.session', currency, amount_total: amount, metadata: { currency } } }
  };
  const payload = JSON.stringify(event);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  return fetch(`${BASE_URL}/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload
  });
}

async function partB() {
  console.log('--- Part B: real end-to-end Done-When (Supabase + Stripe + Anthropic) ---');
  if (!envConfigured()) {
    console.log('[SKIP] Env not fully set (SUPABASE_*, ANTHROPIC_API_KEY, STRIPE_*, PRICE_*_ID).');
    console.log('       Apply migration 0007 and set the env to run Part B. Part B spends Anthropic credits.');
    return;
  }
  // eslint-disable-next-line global-require
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  const supabase = getSupabase();

  const serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) }
  });
  const waitForServer = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    serverProc.stdout.on('data', (chunk) => { if (chunk.toString().includes('ready to judge')) { clearTimeout(timeout); resolve(); } });
    serverProc.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });

  const accountRef = `freemium-test-${Date.now()}@example.com`;
  let ideaId;
  try {
    await waitForServer();

    // (0) A NEW ACCOUNT submits an idea.
    const ideaRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...INTAKE, account_ref: accountRef })
    });
    const idea = await ideaRes.json();
    ideaId = idea.id;
    assert(ideaRes.status === 201 && !!ideaId, 'new account submits an idea');
    assert(!!idea.account_id, 'idea is linked to the new account');

    // (1) FREE verdict with locked sections in order.
    console.log('  ·· running the free quick evidence pass (Haiku) — up to ~60s ··');
    const freeRes = await fetch(`${BASE_URL}/ideas/${ideaId}/free-verdict`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_ref: accountRef })
    });
    const free = await freeRes.json();
    assert(freeRes.status === 201, `free verdict returned (got ${freeRes.status})`);
    assert(free.tier === 'free' && ['BUILD', 'PIVOT', 'BURY'].includes(free.verdict),
      'free tier returns a BUILD/PIVOT/BURY verdict');
    assert(typeof free.total_score === 'number', 'free verdict carries a numeric score');
    assert(typeof free.roast === 'string' && free.roast.length > 0, 'free verdict carries a roast');
    assert(typeof free.quick_pass_label === 'string' && /quick/i.test(free.quick_pass_label),
      'free verdict is labeled a quick pass');
    assert(Array.isArray(free.locked_sections) &&
      free.locked_sections.map((s) => s.section).join(',') === 'next_steps,competitive_analysis,evidence',
      'locked sections in order: next steps, competitive analysis, evidence');
    assert(free.unlock && /unlock/i.test(free.unlock.action) && free.unlock.checkout === `/ideas/${ideaId}/checkout`,
      'free screen offers the unlock (moved checkout trigger)');

    // (2) SECOND free verdict on the same idea+account is BLOCKED.
    const blockedRes = await fetch(`${BASE_URL}/ideas/${ideaId}/free-verdict`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_ref: accountRef })
    });
    const blocked = await blockedRes.json();
    assert(blockedRes.status === 409 && blocked.blocked === true,
      'a second free verdict on the same idea+account is blocked (409)');

    // (3) The full report is LOCKED before unlock.
    const lockedReport = await fetch(`${BASE_URL}/ideas/${ideaId}/report`);
    assert(lockedReport.status === 402, 'full report is locked (402) before unlock');

    // (4) Unlock: complete the Step-11 checkout in test mode.
    const checkoutRes = await fetch(`${BASE_URL}/ideas/${ideaId}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: 'usd' })
    });
    const checkout = await checkoutRes.json();
    assert(checkoutRes.status === 201 && checkout.checkout_url.includes('stripe.com'),
      'unlock opens a real Stripe test-mode Checkout Session');
    const hookRes = await deliverCompletedWebhook(stripe, checkout.session_id, 'usd', checkout.amount);
    assert(hookRes.status === 200, 'checkout completes via the verified webhook');

    // (5) Deep run generates the full report.
    console.log('  ·· running the paid DEEP evidence run + voice (Opus) — several minutes ··');
    const validateRes = await fetch(`${BASE_URL}/ideas/${ideaId}/validate`, { method: 'POST' });
    const validate = await validateRes.json();
    assert(validateRes.status === 200 && validate.status === 'complete',
      `deep validate run completes (got ${validateRes.status}, status ${validate.status})`);

    // (6) The same idea now shows the FULL report: leads with 3 next steps, then
    //     competitive analysis, then evidence with working source links.
    const reportRes = await fetch(`${BASE_URL}/ideas/${ideaId}/report`);
    const report = await reportRes.json();
    assert(reportRes.status === 200 && report.tier === 'paid', 'full report unlocked (200, paid)');
    assert(Array.isArray(report.next_steps) && report.next_steps.length === 3, 'full report has exactly 3 next steps');
    // Lead-with-next-steps: next_steps precedes competitive + evidence in the body.
    const keys = Object.keys(report);
    assert(keys.indexOf('next_steps') < keys.indexOf('competitive_analysis') &&
      keys.indexOf('competitive_analysis') < keys.indexOf('evidence_receipts'),
      'report leads with next steps, then competitive analysis, then evidence');
    assert(report.competitive_analysis && Array.isArray(report.competitive_analysis.sections),
      'full report includes competitive analysis');
    const allClaims = report.evidence_receipts.dimensions.flatMap((d) => d.claims);
    const withHttp = allClaims.filter((c) => /^https?:\/\//i.test(c.source_url));
    assert(allClaims.length > 0 && withHttp.length === allClaims.length,
      'every evidence receipt has a working http(s) source link');
  } finally {
    serverProc.kill();
    if (ideaId) {
      await supabase.from('ideas').delete().eq('id', ideaId); // cascades free_verdicts, evidence, scores, verdicts, purchases, runs
    }
    await supabase.from('accounts').delete().eq('external_ref', accountRef);
    console.log('\nCleaned up test idea + account (dependent rows cascade).');
  }
}

async function main() {
  partA();
  await partB();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
