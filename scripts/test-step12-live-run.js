// Step 12 Done-When: ONE complete live pipeline run against a real test idea,
// through the REAL entitlement journey (free verdict -> real Stripe test-mode
// checkout+webhook -> paid deep run -> free delta re-validation), measuring:
//   - time to verdict (deep run): must be UNDER 10 minutes (PRD §6)
//   - deep run cost: must be UNDER $2.50 (closes the deferred cost-optimization
//     Done-When alongside the existing $2.50 assertion in test-freemium.js)
//   - delta re-validation cost: must be UNDER $1.50
//
// This is NOT a hermetic suite — it spends real Anthropic credits (one quick
// Haiku pass + one full Opus deep run + one delta run) and opens a real Stripe
// TEST-mode Checkout Session. It should be run once, deliberately, not as part
// of the regular hermetic regression sweep.
//
// The full captured output (idea, free verdict, deep report incl. roast, next
// steps, six answers, competitive analysis, evidence receipts, card data, cost,
// timing) is saved to scripts/output/step12-live-run.json so the user — the
// explicit voice-quality gate for this step — can review the generated roast
// and card before Step 12 is graded.

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { getSupabase } = require('../lib/db');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const TIME_TO_VERDICT_LIMIT_MS = 10 * 60 * 1000; // 10 minutes
const DEEP_RUN_COST_LIMIT_USD = 2.50;
const DELTA_RUN_COST_LIMIT_USD = 1.50;

let failures = 0;
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}

function envConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.ANTHROPIC_API_KEY && process.env.STRIPE_SECRET_KEY &&
    process.env.STRIPE_WEBHOOK_SECRET && process.env.PRICE_INR_ID && process.env.PRICE_USD_ID);
}

// A real, realistic test idea — construction/AEC-flavored, matching the
// project's actual target customer.
const INTAKE = {
  problem: 'Small construction subcontractors lose hours every week reconciling supplier delivery tickets against invoices by hand.',
  audience: 'Small construction subcontractors and their back-office bookkeepers.',
  monetization_hypothesis: 'Flat monthly SaaS fee per company for automated ticket-to-invoice reconciliation.',
  unfair_advantage: 'Founder ran back-office operations for a mid-size general contractor for six years.'
};

async function deliverCompletedWebhook(stripe, sessionId, currency, amount) {
  const event = {
    id: `evt_step12_${Date.now()}`,
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

async function main() {
  if (!envConfigured()) {
    console.log('[SKIP] Env not fully set (SUPABASE_*, ANTHROPIC_API_KEY, STRIPE_*, PRICE_*_ID). Cannot run the live acceptance run.');
    process.exit(1);
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

  const accountRef = `step12-live-run-${Date.now()}@example.com`;
  let ideaId;
  const output = { started_at: new Date().toISOString(), intake: INTAKE, account_ref: accountRef };

  try {
    await waitForServer();

    // (1) A new account submits the real test idea.
    const ideaRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...INTAKE, account_ref: accountRef })
    });
    const idea = await ideaRes.json();
    ideaId = idea.id;
    assert(ideaRes.status === 201 && !!ideaId, 'idea created');
    output.idea = idea;

    // (2) Free quick-pass verdict (Haiku) — informational timing only.
    console.log('\n·· running the free quick evidence pass (Haiku) ··');
    const freeStart = Date.now();
    const freeRes = await fetch(`${BASE_URL}/ideas/${ideaId}/free-verdict`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_ref: accountRef })
    });
    const free = await freeRes.json();
    const freeMs = Date.now() - freeStart;
    assert(freeRes.status === 201, `free verdict returned (got ${freeRes.status})`);
    console.log(`   free verdict: ${free.verdict} @ ${free.total_score} in ${(freeMs / 1000).toFixed(1)}s, cost $${free.cost && free.cost.total_cost}`);
    output.free_verdict = free;
    output.free_verdict_ms = freeMs;

    // (3) Unlock: real Stripe TEST-mode checkout + verified webhook.
    console.log('\n·· opening a real Stripe test-mode checkout + delivering the signed webhook ··');
    const checkoutRes = await fetch(`${BASE_URL}/ideas/${ideaId}/checkout`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currency: 'usd' })
    });
    const checkout = await checkoutRes.json();
    assert(checkoutRes.status === 201 && checkout.checkout_url.includes('stripe.com'),
      'real Stripe test-mode Checkout Session created');
    const hookRes = await deliverCompletedWebhook(stripe, checkout.session_id, 'usd', checkout.amount);
    assert(hookRes.status === 200, 'checkout completes via the verified webhook');
    output.checkout = { checkout_url: checkout.checkout_url, session_id: checkout.session_id, amount: checkout.amount };

    // (4) THE DEEP RUN — timed. This is "time to verdict" for the paid report.
    console.log('\n·· running the paid DEEP evidence run + voice (Opus) — timing starts now ··');
    const deepStart = Date.now();
    const validateRes = await fetch(`${BASE_URL}/ideas/${ideaId}/validate`, { method: 'POST' });
    const validate = await validateRes.json();
    const deepMs = Date.now() - deepStart;
    assert(validateRes.status === 200 && validate.status === 'complete',
      `deep validate run completes (got ${validateRes.status}, status ${validate.status})`);
    console.log(`   deep run completed in ${(deepMs / 1000 / 60).toFixed(2)} minutes, reported cost $${validate.cost && validate.cost.total_cost}`);
    assert(deepMs < TIME_TO_VERDICT_LIMIT_MS,
      `time to verdict is under 10 minutes (took ${(deepMs / 1000 / 60).toFixed(2)} min)`);

    const { data: runRows } = await supabase
      .from('validation_runs')
      .select('cost_usd, input_tokens, output_tokens, web_search_requests, usage_detail')
      .eq('idea_id', ideaId)
      .order('created_at', { ascending: false })
      .limit(1);
    const runRow = runRows && runRows[0];
    assert(runRow && Number(runRow.cost_usd) > 0, `deep run cost persisted ($${runRow && runRow.cost_usd})`);
    assert(runRow && Number(runRow.cost_usd) < DEEP_RUN_COST_LIMIT_USD,
      `deep run cost is under the $${DEEP_RUN_COST_LIMIT_USD} target ($${runRow && runRow.cost_usd})`);
    output.deep_run = { wall_ms: deepMs, wall_minutes: Number((deepMs / 1000 / 60).toFixed(2)), cost_usd: runRow && Number(runRow.cost_usd), usage_detail: runRow && runRow.usage_detail };

    // (5) Full report — capture roast, card, next steps, six answers for review.
    const reportRes = await fetch(`${BASE_URL}/ideas/${ideaId}/report`);
    const report = await reportRes.json();
    assert(reportRes.status === 200 && report.tier === 'paid', 'full report unlocked (200, paid)');
    output.report = report;

    const cardRes = await fetch(`${BASE_URL}${report.card_data && report.card_data.card_asset_url ? report.card_data.card_asset_url : `/ideas/${ideaId}/card.svg`}`);
    const cardSvg = cardRes.status === 200 ? await cardRes.text() : null;
    output.card_svg_status = cardRes.status;

    // (6) Delta re-validation — cheap, reuses fresh evidence.
    console.log('\n·· running the free RE-VALIDATION (delta) ··');
    const revalStart = Date.now();
    const revalRes = await fetch(`${BASE_URL}/ideas/${ideaId}/validate`, { method: 'POST' });
    const reval = await revalRes.json();
    const revalMs = Date.now() - revalStart;
    assert(revalRes.status === 200 && reval.mode === 'delta',
      `re-validation runs in delta mode (got ${revalRes.status}, mode ${reval.mode})`);

    const { data: revalRows } = await supabase
      .from('validation_runs')
      .select('cost_usd, output_tokens, usage_detail')
      .eq('idea_id', ideaId)
      .order('created_at', { ascending: false })
      .limit(1);
    const revalRow = revalRows && revalRows[0];
    assert(revalRow && Number(revalRow.cost_usd) < DELTA_RUN_COST_LIMIT_USD,
      `delta re-validation is under the $${DELTA_RUN_COST_LIMIT_USD} target ($${revalRow && revalRow.cost_usd})`);
    output.delta_run = { wall_ms: revalMs, cost_usd: revalRow && Number(revalRow.cost_usd), usage_detail: revalRow && revalRow.usage_detail };

    // ── Print the roast + card + six answers for the mandatory voice-quality review ──
    console.log('\n================ VOICE QUALITY REVIEW ================');
    console.log(`Verdict: ${report.verdict} @ ${report.total_score}`);
    console.log('\n--- Roast ---\n' + report.roast);
    console.log('\n--- Next steps ---');
    (report.next_steps || []).forEach((s, i) => console.log(`${i + 1}. ${s}`));
    console.log('\n--- Six answers ---');
    console.log(JSON.stringify(report.six_answers, null, 2));
    console.log('\n--- Card SVG status: ' + cardRes.status + ' ---');
    console.log('========================================================\n');

    output.finished_at = new Date().toISOString();
    output.card_svg = cardSvg;

    const outDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    const outPath = path.join(outDir, 'step12-live-run.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    if (cardSvg) fs.writeFileSync(path.join(outDir, 'step12-live-run-card.svg'), cardSvg);
    console.log(`Saved full output to ${outPath}`);
    if (cardSvg) console.log(`Saved card SVG to ${path.join(outDir, 'step12-live-run-card.svg')}`);

  } finally {
    serverProc.kill();
    if (ideaId) {
      await supabase.from('ideas').delete().eq('id', ideaId);
    }
    await supabase.from('accounts').delete().eq('external_ref', accountRef);
    console.log('Cleaned up test idea + account (dependent rows cascade) — output file preserved.');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
