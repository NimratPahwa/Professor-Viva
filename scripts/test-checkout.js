// Done-When demo for Step 11 (Stripe checkout + entitlement, FR-1.7).
//
// Step 11 Done-When:
//   1. A test purchase completes in BOTH currencies via Stripe test mode.
//   2. The override selector switches the price shown.
//   3. The purchase record stores the correct Price ID + currency.
//   4. The one-free-then-blocked-third-run rule works identically for both
//      currencies.
//
// Part A is hermetic (no DB/API/Stripe): the pure entitlement rule and the pure
// currency-resolution/override logic.
// Part B exercises the real endpoints against Stripe TEST mode + Supabase:
// GET /pricing (+ override), POST /ideas/:id/checkout (a real test-mode Checkout
// Session), the signature-verified POST /stripe/webhook that marks the purchase
// paid, and the entitlement gate (POST /ideas/:id/validate returns 402 on the
// blocked third run — before the pipeline, so no Anthropic credits are spent).
//
// The two "allowed" runs are consumed against the ledger directly (the pipeline
// execution itself is covered by the Step 8 tests); this test is about the
// PURCHASE→ENTITLEMENT→BLOCK rule, proven identically for INR and USD.

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const path = require('path');
const fetch = require('node-fetch');

const { evaluateEntitlement } = require('../lib/entitlement');
const { resolveCurrency, pricingOptions, priceFor } = require('../lib/pricing');
const { getSupabase } = require('../lib/db');
const {
  getPurchaseBySessionId,
  recordValidationRun,
  countValidationRuns,
  countPaidPurchases
} = require('../lib/purchases-repo');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

let failures = 0;
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}

// ─── Part A: pure logic (no DB/API/Stripe) ──────────────────────────────────────
function partA() {
  console.log('--- Part A: entitlement + currency resolution (pure) ---');

  // Entitlement: one purchase = 2 runs (initial + one free re-validation); 3rd blocked.
  const e0 = evaluateEntitlement({ paidPurchases: 0, runsUsed: 0 });
  assert(!e0.allowed && e0.reason === 'no_purchase', 'no purchase -> blocked (no_purchase)');
  const e1 = evaluateEntitlement({ paidPurchases: 1, runsUsed: 0 });
  assert(e1.allowed && e1.reason === 'initial' && e1.runsAllowed === 2, 'purchase -> run 1 allowed (initial)');
  const e2 = evaluateEntitlement({ paidPurchases: 1, runsUsed: 1 });
  assert(e2.allowed && e2.reason === 'free_revalidation' && e2.runsRemaining === 1, 'run 2 allowed (free re-validation)');
  const e3 = evaluateEntitlement({ paidPurchases: 1, runsUsed: 2 });
  assert(!e3.allowed && e3.reason === 'runs_exhausted', 'run 3 blocked (runs_exhausted)');
  const e4 = evaluateEntitlement({ paidPurchases: 2, runsUsed: 2 });
  assert(e4.allowed && e4.runsAllowed === 4, 'a second purchase unblocks again');

  // Currency resolution: India -> INR, everyone else -> USD, override wins, bad override ignored.
  const inIN = resolveCurrency({ headers: { 'x-vercel-ip-country': 'IN' } });
  assert(inIN.currency === 'inr' && inIN.detectedCurrency === 'inr', 'India detected -> INR');
  const inUS = resolveCurrency({ headers: { 'cf-ipcountry': 'US' } });
  assert(inUS.currency === 'usd', 'US detected -> USD');
  const none = resolveCurrency({ headers: {} });
  assert(none.currency === 'usd', 'no region -> USD default');
  const overridden = resolveCurrency({ headers: { 'x-vercel-ip-country': 'IN' } }, 'usd');
  assert(overridden.currency === 'usd' && overridden.overrideApplied, 'override switches INR->USD');
  const badOverride = resolveCurrency({ headers: { 'x-vercel-ip-country': 'IN' } }, 'gbp');
  assert(badOverride.currency === 'inr' && !badOverride.overrideApplied, 'invalid override ignored');
}

// ─── Part B: real endpoints, Stripe TEST mode + Supabase ────────────────────────
function stripeConfigured() {
  return !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET &&
    process.env.PRICE_INR_ID && process.env.PRICE_USD_ID &&
    process.env.PRICE_INR_AMOUNT && process.env.PRICE_USD_AMOUNT);
}

async function createIdea() {
  const res = await fetch(`${BASE_URL}/ideas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      problem: 'Placeholder problem for the checkout test, long enough to pass intake validation.',
      audience: 'Small construction firms.',
      monetization_hypothesis: 'One-time validation fee.',
      unfair_advantage: 'Founder ran back-office ops for a mid-size GC for six years.'
    })
  });
  const idea = await res.json();
  return idea.id;
}

// Simulates Stripe delivering a verified checkout.session.completed for a session,
// signing the body with the same secret the server verifies against.
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

// Runs the full purchase→entitlement→block flow for one currency.
async function runCurrencyFlow(stripe, currency, countryHeader, supabase, createdIdeaIds) {
  console.log(`\n  ·· currency flow: ${currency.toUpperCase()} (detected country header ${countryHeader}) ··`);
  const expected = priceFor(currency); // { currency, amount, stripePriceId }

  // (2) Override selector switches the price shown. Detect from headers, then override.
  const detectRes = await fetch(`${BASE_URL}/pricing`, { headers: { 'x-country-code': countryHeader } });
  const detected = await detectRes.json();
  assert(detectRes.status === 200, `GET /pricing 200 for ${currency}`);
  const overrideRes = await fetch(`${BASE_URL}/pricing?currency=${currency}`, { headers: { 'x-country-code': countryHeader } });
  const overridden = await overrideRes.json();
  const shown = overridden.options.find((o) => o.currency === overridden.resolved_currency);
  assert(overridden.resolved_currency === currency, `override selector resolves to ${currency}`);
  assert(shown.amount === expected.amount && shown.stripe_price_id === expected.stripePriceId,
    `override shows the ${currency} price (${expected.amount} / ${expected.stripePriceId})`);
  const otherShown = detected.options.find((o) => o.currency !== currency);
  assert(otherShown && otherShown.amount !== expected.amount, 'the two currencies show different amounts');

  // Create a fresh idea for this currency.
  const ideaId = await createIdea();
  createdIdeaIds.push(ideaId);
  assert(!!ideaId, `test idea created for ${currency}`);

  // (1) Open a REAL Stripe test-mode Checkout Session in this currency.
  const checkoutRes = await fetch(`${BASE_URL}/ideas/${ideaId}/checkout`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currency })
  });
  const checkout = await checkoutRes.json();
  assert(checkoutRes.status === 201, `checkout session created for ${currency} (got ${checkoutRes.status})`);
  assert(typeof checkout.checkout_url === 'string' && checkout.checkout_url.includes('stripe.com'),
    'checkout returns a live Stripe hosted URL');
  assert(checkout.currency === currency && checkout.stripe_price_id === expected.stripePriceId,
    'checkout uses the configured Price ID for the currency');

  // (3) Purchase record stores the correct Price ID + currency (pending pre-webhook).
  const pending = await getPurchaseBySessionId(checkout.session_id);
  assert(pending && pending.status === 'pending', 'pending purchase recorded');
  assert(pending.stripe_price_id === expected.stripePriceId && pending.currency === currency,
    'pending purchase stores correct Price ID + currency');

  // (1 cont.) Complete the purchase via the verified webhook (Stripe test mode).
  const hookRes = await deliverCompletedWebhook(stripe, checkout.session_id, currency, expected.amount);
  assert(hookRes.status === 200, `webhook accepted for ${currency} (got ${hookRes.status})`);
  const paid = await getPurchaseBySessionId(checkout.session_id);
  assert(paid.status === 'paid', 'purchase marked paid after webhook');
  assert(paid.stripe_price_id === expected.stripePriceId && paid.currency === currency,
    'paid purchase still stores correct Price ID + currency');

  // (4) Entitlement: initial allowed, one free re-validation, third blocked.
  const entRes1 = await fetch(`${BASE_URL}/ideas/${ideaId}/entitlement`);
  const ent1 = await entRes1.json();
  assert(ent1.allowed && ent1.reason === 'initial' && ent1.runsAllowed === 2, `${currency}: initial run allowed`);

  // Consume run 1 against the ledger (pipeline execution covered by Step 8 tests).
  await recordValidationRun(ideaId, null);
  const ent2 = await (await fetch(`${BASE_URL}/ideas/${ideaId}/entitlement`)).json();
  assert(ent2.allowed && ent2.reason === 'free_revalidation' && ent2.runsRemaining === 1,
    `${currency}: free re-validation allowed`);

  // Consume run 2.
  await recordValidationRun(ideaId, null);
  const ent3 = await (await fetch(`${BASE_URL}/ideas/${ideaId}/entitlement`)).json();
  assert(!ent3.allowed && ent3.reason === 'runs_exhausted', `${currency}: entitlement exhausted after 2 runs`);

  // The blocked third run: POST /validate returns 402 BEFORE the pipeline (no credits spent).
  const blocked = await fetch(`${BASE_URL}/ideas/${ideaId}/validate`, { method: 'POST' });
  const blockedBody = await blocked.json();
  assert(blocked.status === 402, `${currency}: third run blocked with 402 (got ${blocked.status})`);
  assert(blockedBody.reason === 'runs_exhausted', `${currency}: 402 reports runs_exhausted`);

  // Ledger is durable and unchanged by the blocked attempt.
  const runs = await countValidationRuns(ideaId);
  const paidCount = await countPaidPurchases(ideaId);
  assert(runs === 2 && paidCount === 1, `${currency}: ledger holds 2 runs + 1 paid purchase (blocked run not recorded)`);

  return { ideaId, currency };
}

async function partB() {
  console.log('--- Part B: real endpoints (Stripe test mode + Supabase) ---');
  if (!stripeConfigured()) {
    console.log('[SKIP] Stripe/pricing env not set (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, PRICE_*_ID/AMOUNT).');
    console.log('       Set test-mode keys + real test Price IDs and apply migration 0006 to run Part B.');
    return;
  }
  // eslint-disable-next-line global-require
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

  const serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) }
  });
  const waitForServer = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    serverProc.stdout.on('data', (chunk) => { if (chunk.toString().includes('ready to judge')) { clearTimeout(timeout); resolve(); } });
    serverProc.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });

  const supabase = getSupabase();
  const createdIdeaIds = [];
  try {
    await waitForServer();
    // The rule must work IDENTICALLY for both currencies.
    await runCurrencyFlow(stripe, 'inr', 'IN', supabase, createdIdeaIds);
    await runCurrencyFlow(stripe, 'usd', 'US', supabase, createdIdeaIds);
  } finally {
    serverProc.kill();
    for (const id of createdIdeaIds) {
      await supabase.from('ideas').delete().eq('id', id); // cascades purchases + validation_runs
    }
    if (createdIdeaIds.length) console.log(`\nCleaned up ${createdIdeaIds.length} test idea(s) (purchases + runs cascade).`);
  }
}

async function main() {
  partA();
  await partB();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
