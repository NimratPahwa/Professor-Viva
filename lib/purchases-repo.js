// Professor Viva — Step 11: purchase + validation-run persistence (FR-1.7).
//
// A purchase row is created 'pending' when a Checkout Session opens and flipped
// to 'paid' by the Stripe webhook. The row stores the Stripe Price ID, currency,
// and amount so the founding→list price change is config-only. validation_runs
// is the ledger the entitlement check counts against.

const { getSupabase } = require('./db');

// Records a pending purchase at Checkout-Session creation time. The session id
// is unique, so a webhook can later find exactly this row to mark it paid.
async function createPendingPurchase({ ideaId, stripeSessionId, stripePriceId, currency, amount }) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('purchases')
    .insert({
      idea_id: ideaId,
      stripe_session_id: stripeSessionId,
      stripe_price_id: stripePriceId,
      currency,
      amount,
      status: 'pending'
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Flips a purchase to 'paid' (idempotent — the webhook may fire more than once).
// The Price ID / currency / amount are re-asserted from the completed session so
// the stored record reflects exactly what Stripe charged.
async function markPurchasePaid(stripeSessionId, { stripePriceId, currency, amount } = {}) {
  const supabase = getSupabase();
  const update = { status: 'paid', updated_at: new Date().toISOString() };
  if (stripePriceId !== undefined) update.stripe_price_id = stripePriceId;
  if (currency !== undefined) update.currency = currency;
  if (amount !== undefined) update.amount = amount;

  const { data, error } = await supabase
    .from('purchases')
    .update(update)
    .eq('stripe_session_id', stripeSessionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getPurchaseBySessionId(stripeSessionId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('purchases')
    .select('*')
    .eq('stripe_session_id', stripeSessionId)
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

// Count of PAID purchases for an idea — the entitlement numerator.
async function countPaidPurchases(ideaId) {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('purchases')
    .select('*', { count: 'exact', head: true })
    .eq('idea_id', ideaId)
    .eq('status', 'paid');
  if (error) throw error;
  return count || 0;
}

// Records a consumed validation run against an idea (optionally tagged with the
// purchase that entitled it). This is what makes the "third run blocked" rule
// durable across process restarts.
async function recordValidationRun(ideaId, purchaseId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('validation_runs')
    .insert({ idea_id: ideaId, purchase_id: purchaseId || null })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function countValidationRuns(ideaId) {
  const supabase = getSupabase();
  const { count, error } = await supabase
    .from('validation_runs')
    .select('*', { count: 'exact', head: true })
    .eq('idea_id', ideaId);
  if (error) throw error;
  return count || 0;
}

// Persists the measured API cost of a completed deep run onto its ledger row
// (migration 0008). `summary` is a lib/usage-meter summarizeUsage() result: its
// totals set the token/search counts + cost_usd, and the full summary (per-call
// lines + per-model breakdown) is stored in usage_detail for auditing.
async function updateValidationRunCost(runId, summary) {
  const supabase = getSupabase();
  const totals = (summary && summary.totals) || {};
  const { data, error } = await supabase
    .from('validation_runs')
    .update({
      input_tokens: totals.input_tokens || 0,
      output_tokens: totals.output_tokens || 0,
      web_search_requests: totals.web_search_requests || 0,
      cost_usd: totals.total_cost || 0,
      usage_detail: summary || null
    })
    .eq('id', runId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  createPendingPurchase,
  markPurchasePaid,
  getPurchaseBySessionId,
  countPaidPurchases,
  recordValidationRun,
  countValidationRuns,
  updateValidationRunCost
};
