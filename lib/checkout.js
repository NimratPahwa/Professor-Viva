// Professor Viva — Step 11: Stripe Checkout Session creation (FR-1.7).
//
// A ONE-TIME purchase (mode: 'payment', NOT a subscription). The line item uses
// the configured Stripe Price ID for the resolved currency — the price amount
// lives in Stripe's catalogue and in our env, never hardcoded here. On success
// we return the session so the caller can persist a pending purchase row and
// redirect the buyer to session.url.

const { priceFor } = require('./pricing');

let _stripe = null;

// Lazily construct the Stripe client so importing this module (e.g. for the
// hermetic parts of the test) doesn't require a key. Fails loudly if a real
// checkout is attempted without STRIPE_SECRET_KEY.
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !String(key).trim()) {
    throw new Error('Missing STRIPE_SECRET_KEY — cannot create a Checkout Session');
  }
  // eslint-disable-next-line global-require
  const Stripe = require('stripe');
  _stripe = Stripe(String(key).trim());
  return _stripe;
}

// Where Stripe sends the buyer after the hosted checkout page. Configurable via
// env; falls back to a localhost default for local test runs.
function baseUrl() {
  return (process.env.CHECKOUT_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

// Opens a one-time Checkout Session for an idea in the resolved currency.
// Returns { session, currency, stripePriceId, amount } — the caller records the
// pending purchase and hands session.url to the client.
async function createCheckoutSession({ ideaId, currency }) {
  const option = priceFor(currency); // { currency, amount, stripePriceId }
  const stripe = getStripe();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment', // one-time, NOT subscription
    line_items: [{ price: option.stripePriceId, quantity: 1 }],
    // idea_id travels on the session so the webhook can attribute the payment
    // without trusting anything from the client.
    client_reference_id: ideaId,
    metadata: { idea_id: ideaId, currency: option.currency },
    // live=1 travels through the round-trip so the client return handler knows
    // to resume in live mode (a real ideaId always implies live); without it,
    // the client's page-load LIVE flag would be false on the return leg and it
    // would fall back to the demo/sample paths.
    success_url: `${baseUrl()}/checkout/success?session_id={CHECKOUT_SESSION_ID}&idea_id=${encodeURIComponent(ideaId)}&live=1`,
    cancel_url: `${baseUrl()}/checkout/cancel?idea_id=${encodeURIComponent(ideaId)}&live=1`
  });

  return {
    session,
    currency: option.currency,
    stripePriceId: option.stripePriceId,
    amount: option.amount
  };
}

// Verifies a webhook payload came from Stripe and returns the parsed event.
// Signature verification is mandatory — an unverified body could mark any
// purchase paid. Throws on a bad/missing signature.
function constructWebhookEvent(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || !String(secret).trim()) {
    throw new Error('Missing STRIPE_WEBHOOK_SECRET — cannot verify webhook');
  }
  const stripe = getStripe();
  return stripe.webhooks.constructEvent(rawBody, signature, String(secret).trim());
}

module.exports = {
  getStripe,
  createCheckoutSession,
  constructWebhookEvent
};
