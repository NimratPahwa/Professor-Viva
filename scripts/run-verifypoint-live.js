// Real client validation run — VerifyPoint (Ontario property due diligence /
// development feasibility platform). Reuses the Step 12 live-run mechanics
// (scripts/test-step12-live-run.js) — free verdict -> real Stripe test-mode
// checkout+webhook -> paid deep run -> free delta re-validation — against a
// real founder's idea instead of the fixture test idea, for a client call.
//
// NOT hermetic — spends real Anthropic credits (Haiku quick pass + Opus deep
// run + delta run) and opens a real Stripe TEST-mode Checkout Session.
//
// Full output (idea, free verdict, deep report incl. roast, next steps, six
// answers, competitive analysis, evidence receipts, card data, cost, timing)
// is saved to scripts/output/verifypoint-live-run.json.

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { getSupabase } = require('../lib/db');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

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

const INTAKE = {
  problem: 'VerifyPoint is an Ontario-focused property due diligence and development feasibility platform built for brokers and developers to instantly assess site viability before committing capital. Brokers, developers, and investors spend thousands on planners, architects, and consultants just to find out what can realistically be built on a property. VerifyPoint tells them instantly, before they commit that capital.',
  audience: 'Commercial and land realtors, developers, investors, landowners, lenders, and brokerages evaluating development or redevelopment opportunities in Ontario.',
  monetization_hypothesis: 'Mix of pay-per-report and subscription. Basic property screening $199 to $299 per report, detailed feasibility and highest-and-best-use reports priced higher, enterprise and brokerage plans on subscription, plus a developer tier at $1,800 to $3,500 per month.',
  unfair_advantage: '13-plus years working on Ontario land, development, zoning, feasibility, and transactions, having personally dealt with these problems across real projects.'
};

async function deliverCompletedWebhook(stripe, sessionId, currency, amount) {
  const event = {
    id: `evt_verifypoint_${Date.now()}`,
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
    console.log('[SKIP] Env not fully set (SUPABASE_*, ANTHROPIC_API_KEY, STRIPE_*, PRICE_*_ID). Cannot run live.');
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

  const accountRef = `verifypoint-live-${Date.now()}@example.com`;
  let ideaId;
  const output = { started_at: new Date().toISOString(), intake: INTAKE, account_ref: accountRef };

  try {
    await waitForServer();

    const ideaRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...INTAKE, account_ref: accountRef })
    });
    const idea = await ideaRes.json();
    ideaId = idea.id;
    assert(ideaRes.status === 201 && !!ideaId, 'idea created');
    output.idea = idea;

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

    console.log('\n·· running the paid DEEP evidence run + voice (Opus) — timing starts now ··');
    const deepStart = Date.now();
    const validateRes = await fetch(`${BASE_URL}/ideas/${ideaId}/validate`, { method: 'POST' });
    const validate = await validateRes.json();
    const deepMs = Date.now() - deepStart;
    assert(validateRes.status === 200 && validate.status === 'complete',
      `deep validate run completes (got ${validateRes.status}, status ${validate.status})`);
    console.log(`   deep run completed in ${(deepMs / 1000 / 60).toFixed(2)} minutes, reported cost $${validate.cost && validate.cost.total_cost}`);

    const { data: runRows } = await supabase
      .from('validation_runs')
      .select('cost_usd, input_tokens, output_tokens, web_search_requests, usage_detail')
      .eq('idea_id', ideaId)
      .order('created_at', { ascending: false })
      .limit(1);
    const runRow = runRows && runRows[0];
    assert(runRow && Number(runRow.cost_usd) > 0, `deep run cost persisted ($${runRow && runRow.cost_usd})`);
    output.deep_run = { wall_ms: deepMs, wall_minutes: Number((deepMs / 1000 / 60).toFixed(2)), cost_usd: runRow && Number(runRow.cost_usd), usage_detail: runRow && runRow.usage_detail };

    const reportRes = await fetch(`${BASE_URL}/ideas/${ideaId}/report`);
    const report = await reportRes.json();
    assert(reportRes.status === 200 && report.tier === 'paid', 'full report unlocked (200, paid)');
    output.report = report;

    const cardRes = await fetch(`${BASE_URL}${report.card_data && report.card_data.card_asset_url ? report.card_data.card_asset_url : `/ideas/${ideaId}/card.svg`}`);
    const cardSvg = cardRes.status === 200 ? await cardRes.text() : null;
    output.card_svg_status = cardRes.status;

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
    output.delta_run = { wall_ms: revalMs, cost_usd: revalRow && Number(revalRow.cost_usd), usage_detail: revalRow && revalRow.usage_detail };

    console.log('\n================ VERIFYPOINT — FULL RESULT ================');
    console.log(`Verdict: ${report.verdict} @ ${report.total_score}`);
    console.log('\n--- Roast ---\n' + report.roast);
    console.log('\n--- Next steps ---');
    (report.next_steps || []).forEach((s, i) => console.log(`${i + 1}. ${s}`));
    console.log('\n--- Six answers ---');
    console.log(JSON.stringify(report.six_answers, null, 2));
    console.log('\n--- Card SVG status: ' + cardRes.status + ' ---');
    console.log('==============================================================\n');

    output.finished_at = new Date().toISOString();
    output.card_svg = cardSvg;

    const outDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
    const outPath = path.join(outDir, 'verifypoint-live-run.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    if (cardSvg) fs.writeFileSync(path.join(outDir, 'verifypoint-live-run-card.svg'), cardSvg);
    console.log(`Saved full output to ${outPath}`);
    if (cardSvg) console.log(`Saved card SVG to ${path.join(outDir, 'verifypoint-live-run-card.svg')}`);

  } finally {
    serverProc.kill();
    if (ideaId) {
      await supabase.from('ideas').delete().eq('id', ideaId);
    }
    await supabase.from('accounts').delete().eq('external_ref', accountRef);
    console.log('Cleaned up idea + account (dependent rows cascade) — output file preserved.');
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed (see output file for full data regardless).`);
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
