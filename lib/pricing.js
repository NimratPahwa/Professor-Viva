// Professor Viva — Step 11: pricing configuration (FR-1.7).
//
// Price amounts and Stripe Price IDs are NEVER hardcoded — they come from env
// so the founding→list transition (₹1,499/$39 → ₹2,999/$79) is a config change,
// not a code change. This module owns three things:
//   1. the two currency options (INR for India, USD for everyone else),
//   2. region detection from a request (geo header, with a query/body override),
//   3. resolving a region to the currency + Stripe Price ID to charge.
//
// Amounts are expressed in the Stripe MINOR unit (paise / cents) because that
// is what Stripe Checkout expects and what the webhook reports back.

// Reads a required env var, throwing a clear error if it is missing. Keeping
// this strict means a misconfigured deploy fails loudly at checkout time rather
// than silently charging the wrong (or a zero) price.
function requireEnv(name) {
  const v = process.env[name];
  if (v === undefined || v === null || String(v).trim() === '') {
    throw new Error(`Missing required pricing env var: ${name}`);
  }
  return String(v).trim();
}

function intEnv(name) {
  const raw = requireEnv(name);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Pricing env var ${name} must be a positive integer (minor units), got: ${raw}`);
  }
  return n;
}

// The catalogue, assembled fresh from env on each call so tests and config
// changes take effect without a restart-time snapshot. INR is the India price;
// USD is the everyone-else price.
function pricingConfig() {
  return {
    inr: {
      currency: 'inr',
      amount: intEnv('PRICE_INR_AMOUNT'),        // e.g. 149900 paise = ₹1,499
      stripePriceId: requireEnv('PRICE_INR_ID')
    },
    usd: {
      currency: 'usd',
      amount: intEnv('PRICE_USD_AMOUNT'),         // e.g. 3900 cents = $39
      stripePriceId: requireEnv('PRICE_USD_ID')
    }
  };
}

const VALID_CURRENCIES = ['inr', 'usd'];

// Detects the buyer's region from request geo hints. Vercel/Cloudflare-style
// country headers are checked; absent those, region is 'unknown' and the caller
// falls back to USD. This is only a DEFAULT — the user can always override.
function detectRegionCountry(req) {
  const h = (req && req.headers) || {};
  const country =
    h['x-vercel-ip-country'] ||
    h['cf-ipcountry'] ||
    h['x-country-code'] ||
    '';
  return String(country).trim().toUpperCase();
}

// India → INR, everyone else → USD. Exposed separately so both the detection
// path and any test can share one mapping.
function currencyForCountry(country) {
  return String(country).toUpperCase() === 'IN' ? 'inr' : 'usd';
}

// Resolves the currency to actually charge. An explicit override (from the
// visible currency selector) wins over detection; an invalid override is
// ignored rather than trusted. Returns both the resolved currency and whether
// an override was applied, so the UI can reflect it.
function resolveCurrency(req, override) {
  const detectedCountry = detectRegionCountry(req);
  const detectedCurrency = currencyForCountry(detectedCountry);

  const normalizedOverride = override ? String(override).toLowerCase().trim() : '';
  const overrideApplied = VALID_CURRENCIES.includes(normalizedOverride);
  const currency = overrideApplied ? normalizedOverride : detectedCurrency;

  return {
    currency,
    detectedCountry: detectedCountry || null,
    detectedCurrency,
    overrideApplied
  };
}

// The single price option for one currency, shaped for both the API response
// and the Checkout Session line item.
function priceFor(currency) {
  const normalized = String(currency || '').toLowerCase();
  const config = pricingConfig();
  const option = config[normalized];
  if (!option) throw new Error(`No price configured for currency: ${currency}`);
  return option;
}

// Both options plus the resolved default — this is what GET /pricing returns so
// the client can render the selector with the detected region preselected.
function pricingOptions(req, override) {
  const resolution = resolveCurrency(req, override);
  const config = pricingConfig();
  return {
    resolved_currency: resolution.currency,
    detected_country: resolution.detectedCountry,
    detected_currency: resolution.detectedCurrency,
    override_applied: resolution.overrideApplied,
    options: VALID_CURRENCIES.map((c) => ({
      currency: c,
      amount: config[c].amount,
      stripe_price_id: config[c].stripePriceId
    }))
  };
}

module.exports = {
  VALID_CURRENCIES,
  pricingConfig,
  detectRegionCountry,
  currencyForCountry,
  resolveCurrency,
  priceFor,
  pricingOptions
};
