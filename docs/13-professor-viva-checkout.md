# Professor Viva — Stripe Checkout & Entitlement (Step 11)

Implements **FR-1.7**. A one-time purchase (NOT a subscription) via Stripe
**Checkout Sessions**, with configurable founding-launch pricing, a region-aware
currency selector, and a purchase-count entitlement rule that gives one free
re-validation per idea and blocks the third run.

## Pricing (configurable, never hardcoded)

Amounts and Stripe Price IDs live entirely in env (`lib/pricing.js`), so the
founding→list transition (₹1,499/$39 → ₹2,999/$79) is a config change, not a
code change. Amounts are stored/sent in the Stripe **minor unit** (paise/cents).

| Env var | Meaning | Founding value |
|---|---|---|
| `PRICE_INR_AMOUNT` | India price, paise | `149900` (₹1,499) |
| `PRICE_INR_ID` | Stripe Price ID (INR) | `price_...` |
| `PRICE_USD_AMOUNT` | Everyone-else price, cents | `3900` ($39) |
| `PRICE_USD_ID` | Stripe Price ID (USD) | `price_...` |
| `STRIPE_SECRET_KEY` | Test/live secret key | `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret | `whsec_...` |
| `CHECKOUT_BASE_URL` | Redirect origin | `http://localhost:3000` |

## Currency resolution (`lib/pricing.js`)

- **Detected region** from geo headers (`x-vercel-ip-country`, `cf-ipcountry`,
  `x-country-code`). India (`IN`) → **INR**; everyone else → **USD**.
- **Visible currency selector** overrides detection: an explicit `currency`
  (query or body, `inr`|`usd`) wins. An invalid override is ignored, not trusted.
- `GET /pricing` returns the resolved currency, the detected country, both
  options, and whether an override was applied — enough to render the selector
  with the detected region preselected.

## Checkout (`lib/checkout.js`)

`mode: 'payment'` (one-time). The line item is the configured Stripe Price ID
for the resolved currency — the amount lives in Stripe's catalogue + our env, not
in code. `client_reference_id` and `metadata.idea_id` carry the idea so the
webhook can attribute payment without trusting the client.

## Entitlement (`lib/entitlement.js`, pure)

One paid purchase grants **two** runs (initial + one free re-validation):
`runs_allowed = paid_purchases × 2`. `runs_remaining = runs_allowed − runs_used`.
The **third run is blocked** (`402`) pending a new purchase. The rule counts
purchases, so it is **identical for INR and USD** buyers.

## Persistence (`lib/purchases-repo.js`, migration `0006`)

- `purchases` — one row per Checkout Session. Created `pending` at checkout,
  flipped to `paid` by the verified webhook. Stores **Stripe Price ID, currency,
  amount** (FR-1.7).
- `validation_runs` — the ledger the entitlement check counts against; makes
  "third run blocked" durable across restarts.

## Endpoints (`server.js`)

| Method + path | Purpose |
|---|---|
| `GET /pricing` | Detected region + both price options + override flag |
| `POST /ideas/:id/checkout` | Open a Checkout Session; record pending purchase |
| `POST /stripe/webhook` | Signature-verified; marks purchase `paid` on `checkout.session.completed` |
| `GET /ideas/:id/entitlement` | Paid purchases, runs used, whether another run is allowed |
| `POST /ideas/:id/validate` | Entitlement-gated pipeline run (402 on the blocked third run) |

The raw `POST /ideas/:id/run` stays **ungated** (tests + batch runner). The paid
product action is `POST /ideas/:id/validate`, which consumes a run from the
ledger before running the pipeline.

### Webhook body parsing

`POST /stripe/webhook` is registered with `express.raw()` **before** the global
`express.json()` so Stripe's signature can be verified against the unparsed body.

## Webhook secret: test vs. production

`STRIPE_WEBHOOK_SECRET` is used by `constructWebhookEvent` (`lib/checkout.js`) to
verify the `stripe-signature` header. There are two ways to source it.

### Automated Done-When (self-signed — what `scripts/test-checkout.js` uses)

The test signs the synthetic `checkout.session.completed` event itself via the
Stripe SDK's `generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET })`
and POSTs it to `/stripe/webhook`. The server verifies against the **same** env
value, so any non-empty string works (e.g. `whsec_test_dummy`). No webhook
endpoint and no Stripe CLI are required — Stripe never delivers over the network.
This still exercises real signature verification: a tampered signature 400s.

### Production path (Stripe delivers the event — `whsec_…` required)

When Stripe itself delivers events to a running server, the secret must be the
real signing secret Stripe generates. Two ways to get one:

1. **Stripe CLI (local development):**
   ```bash
   stripe login
   stripe listen --forward-to localhost:3000/stripe/webhook
   ```
   The CLI prints a signing secret (`whsec_…`) on start — copy it into
   `STRIPE_WEBHOOK_SECRET` and restart the server. Trigger a real event with
   `stripe trigger checkout.session.completed`, or complete a live test-mode
   checkout, and the CLI forwards the signed event to your endpoint.

2. **Dashboard-registered endpoint (deployed environment):**
   Developers → Webhooks → *Add endpoint* → URL
   `https://your-domain/stripe/webhook`, subscribe to
   `checkout.session.completed`. The endpoint's *Signing secret* (`whsec_…`,
   shown on the endpoint's page) is the value to set in `STRIPE_WEBHOOK_SECRET`.

In both production cases the secret is unique to that endpoint — it is not
arbitrary the way the self-signed test value is.

## Done-When (FR-1.7)

1. A test purchase completes in **both** currencies via Stripe test mode.
2. The override selector switches the price shown (`GET /pricing?currency=…`).
3. The purchase record stores the correct **Price ID + currency**.
4. The **one-free-then-blocked-third-run** rule works identically for INR and USD.
