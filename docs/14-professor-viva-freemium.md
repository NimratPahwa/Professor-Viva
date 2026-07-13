# Professor Viva — Freemium Two-Tier Gate (Step 11.5)

Implements the freemium business model (01-PRD §1, FR-1.9/1.10/1.11/1.12,
03-AI Rules §3.2). The **verdict is free; the report is paid.** Every account
gets **one free verdict per idea** from a **quick evidence pass**; the Step-11
checkout (unchanged mechanically) becomes the **"Unlock your next steps + full
report"** action.

## The two tiers

| | Free tier | Paid tier |
|---|---|---|
| Trigger | `POST /ideas/:id/free-verdict` | Step-11 checkout → `POST /ideas/:id/validate` → `GET /ideas/:id/report` |
| Evidence | **Quick pass** — Haiku, ≤ 2 searches/dim, 60 s cap | **Deep run** — Sonnet, full web_search |
| Model | `claude-haiku-4-5` (roast + shallow next steps in **one** call) | `claude-opus-4-6` voice pass (unchanged) |
| Delivered | score + BUILD/PIVOT/BURY + roast + **locked** sections | next steps → competitive analysis → evidence receipts |
| Per account | **one per (account, idea)**; 2nd blocked (409) | per purchase; one free re-validation |

Both tiers feed the **same deterministic scoring engine** (`lib/scoring.js`) and
the **same competitive assembly** (`lib/competitive.js`). No LLM ever assigns a
score or verdict, in either tier.

## Design decisions (resolved)

1. **Option A — real-but-shallow sections.** The quick pass produces real,
   shallow versions of all three locked sections; teasers are blurred fragments
   of those. **Hard budget rule:** the shallow next steps are generated inside
   the quick-pass budget — the **same Haiku call** that produces the roast
   (`renderQuickVerdict`, `lib/viva-voice.js`). **No additional LLM call per free
   verdict.** Unlock reveals the deep versions; paid next steps may differ from
   the shallow ones (more evidence) — expected and fine.
2. **Competitive analysis = deterministic assembly** of already-gathered
   `market_gap` + `monetization` evidence, **no new LLM verdict call, for BOTH
   tiers**. The paid version is richer only because the deep run gathered more
   rows — same mechanism. Any narrative framing on the paid report goes through
   the **existing** voice pass, never a new analysis call.

## Free verdict flow (`lib/free-verdict.js`)

```
quick evidence pass ─▶ computeScores ─▶ determineVerdict      (pure code)
      │                                        │
      └────────────▶ ONE Haiku call: roast + 3 shallow next steps
                                               │
      competitive analysis (deterministic) ────┤
      ordered blurred teasers (real content) ──┘
```

The combined free reply (roast + shallow next steps) is screened by the **same**
server-side guardrail filter as the paid verdict (G1 no fabricated evidence /
teasers, G2 no punching down, G3 sensitive input → dial 0). A filtered reply
regenerates once at dial 0.

## Quick evidence pass (`lib/quick-evidence.js`)

- Model `claude-haiku-4-5`; `web_search` capped at `max_uses: 2` per dimension
  ("limited sources", FR-1.2).
- Per-dimension budget 50 s, whole-pass backstop 60 s (FR-1.8). A dimension that
  times out or validates zero claims degrades to `insufficient_signal` — scored
  low and disclosed, **never fabricated** (03-AI Rules §3.2, guardrail 1).
- Same ground-truth URL validation as the deep pass: a claim citing a URL not in
  the retrieved set is discarded.
- Shallow evidence is returned **in-memory only** and stored in
  `free_verdicts.payload` (jsonb). It is **never** written to the `evidence`
  table — the deep run remains the sole writer, so the two passes never mix in
  scoring or receipts.

## Locked sections & teasers (`lib/teasers.js`, FR-1.11)

Fixed order: **(1) next steps, (2) competitive analysis, (3) evidence.** Each
locked section emits a **blurred fragment of that user's own real quick-pass
content** — the first ~12 words of a real next step / claim, `blurred: true`,
`locked: true`. A section with no real content gets an honest `note`, **never a
fabricated teaser** (guardrail 1). The roast may reference that a deeper finding
exists and withhold it in character — the one sanctioned form of withholding
(03-AI Rules §3.2), enforced by the same filter.

## Paid full report (`GET /ideas/:id/report`, FR-1.10)

Gated on `countPaidPurchases ≥ 1` (402 when locked). The report body **leads
with the 3 next steps**, then competitive analysis, then evidence receipts
(03-AI Rules §3.2). Assembled from the **deep** evidence run persisted by
`POST /ideas/:id/validate` (the Step-11 entitlement-gated pipeline). The full
prose roast and card come from the existing Opus voice pass — unchanged.

## Accounts (`lib/accounts-repo.js`, migration 0007, FR-1.12)

A lightweight account keyed by `external_ref` (email / anon token / handle). An
idea created with `account_ref` is attributed to that account (`ideas.account_id`).
The `free_verdicts` table's `unique (account_id, idea_id)` constraint is the
durable enforcement of one-free-verdict-per-idea; a concurrent double-attempt
hits `23505` and is mapped to "blocked".

## Endpoints (`server.js`)

| Method + path | Purpose |
|---|---|
| `POST /ideas` (+ `account_ref`) | Create an idea, optionally linked to an account |
| `POST /ideas/:id/free-verdict` | The one free quick verdict; 409 on a 2nd attempt (same account+idea) |
| `POST /ideas/:id/checkout` | Unlock — the Step-11 checkout, trigger moved |
| `GET /ideas/:id/report` | Paid full report (402 if unlocked); leads with next steps |

`POST /ideas/:id/validate` (Step 11) is unchanged: entitlement-gated deep run.
The raw `POST /ideas/:id/run` stays ungated (tests + batch).

## Done-When (`scripts/test-freemium.js`)

A new account submits an idea → free verdict with locked sections in order
(next steps, competitive analysis, evidence); clicking unlock completes the
Step-11 checkout in test mode; the same idea then shows the full report with
working source links and 3 next steps; a second free verdict attempt on the same
idea + account is blocked.

- **Part A** (hermetic): deterministic competitive assembly + ordered,
  non-fabricated teasers.
- **Part B** (real): the full end-to-end Done-When against Supabase + Stripe test
  mode + Anthropic. Requires **migration 0007 applied** and the env from Step 11.
  Part B spends Anthropic credits (a quick Haiku pass, then a full deep run).
