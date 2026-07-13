# Professor Viva — Product Requirements Document
**Version 1.0 | July 2026 | Owner: Nimrat (@nimratbuilds / Spearanza)**
**Companion docs:** 02-Architecture · 03-AI Rules

---

## 1. Product definition

**One-liner:** Everyone else sells you a report about your app. Viva validates it, then builds v1 — and never lets it die.

**Positioning:** $79 one-time validation. Anchored 2.7x above Preuve AI ($29) on the strength of the build output, 40% below DimeADozen ($129) on the axis incumbents can't follow — none of them are builder platforms. The $29–$129 band is structurally empty; Viva owns it.

**Target user:** The 500M people globally with an app idea and no execution path. Beachhead: @nimratbuilds audience — founders and aspiring builders who want a verdict before they waste six months.

**Core thesis:** Every competitor terminates in a document. Viva terminates in a working product. The pre-build intelligence — real market analysis delivered by a sarcastic, brutally honest professor — is the moat. Infrastructure companies (Emergent, Lovable, Bolt) will never build it because their incentive is to get you building, not to tell you to stop.

---

## 2. Market context

| Competitor | Price | Evidence type | Terminates in |
|---|---|---|---|
| WorthBuild | $5/report | Model opinion | Report |
| Trend Seeker | $9.99/mo | Live pain signals | Score |
| Preuve AI | $29 one-time | Live sourced | Report |
| ValidatorAI | $49 / 3 sessions | Model opinion | Chat |
| DimeADozen | $129 one-time | Sourced (public filings) | 200-page PDF |
| **Professor Viva** | **$79 one-time** | **Live sourced** | **Deployed v1** |

Two gaps, one product: the empty $29–$129 price band, and the empty "verdict → build" axis nobody occupies.

---

## 3. The three-layer product

**Layer 1 — The Validator (the moat).** User submits an idea; Viva runs live, sourced market research and returns a BUILD / PIVOT / BURY verdict in the Professor Viva personality, plus a shareable verdict card. $79 one-time. One free re-validation per purchased idea; additional ideas are new purchases — founders test 2–5 ideas before one holds, which is the repeat-revenue loop.

**Layer 2 — The Builder (the distribution).** BUILD verdicts unlock orchestrated build: Viva conducts a build engine plus the full deploy stack and hands back a live URL with auth, payments, and analytics wired — not a scaffold, not a repo dump.

**Layer 3 — The Operator (the revenue).** Viva never leaves after launch: uptime monitoring, weekly analytics digests, churn flags, next-feature suggestions ranked by observed behavior. $49–$99/month per live app. Once Viva reads your analytics and runs your infra, switching cost is the lock-in.

---

## 4. Functional requirements

### Layer 1 — Validator (MVP)
- **FR-1.1** Structured intake: problem, audience, monetization hypothesis, founder's unfair advantage. Max 3 clarifying questions before analysis begins.
- **FR-1.2** Evidence pipeline against live sources (competitors, pricing, community demand, trends, launches). Every claim stored with a source URL; unsourced claims discarded.
- **FR-1.3** Deterministic scoring rubric and hard-coded verdict thresholds (see 03-AI Rules §3). Same idea + same evidence = same verdict.
- **FR-1.4** Verdict rendered in Viva voice per the personality system (03-AI Rules), followed by exactly **3 concrete next steps** — each a specific, doable action grounded in the gathered evidence, rendered in Viva's voice at the **same sarcasm dial** as the verdict (03-AI Rules §3.1).
- **FR-1.5** Shareable verdict card: Instagram 4:5, Spearanza brand palette (cream #E9E4D6, forest green #3D5C35, charcoal #201D13, gold #C4A44A).
- **FR-1.6** Evidence receipts page — every scored claim linked to its source, viewable by the user.
- **FR-1.7** Stripe checkout — a **one-time purchase** (not a subscription) via Stripe **Checkout Sessions**.
  - **Founding launch pricing:** ₹1,499 (INR) for users detected in India, $39 (USD) for everyone else. These are introductory prices; the list prices (₹2,999 / $79) are introduced later. **Price amounts are configurable, never hardcoded** — the founding→list transition is a config change, not a code change.
  - **Currency:** fixed INR pricing for India-detected users, fixed USD pricing for everyone else, with a **visible currency selector** that lets the user override the detected region.
  - **Purchase record (Supabase):** stores the Stripe **Price ID**, **currency**, and **amount** for each completed purchase.
  - **Entitlement:** one free re-validation per idea; the **third run is blocked** pending a new purchase — the identical rule applies for both currencies.
- **FR-1.8** Time to verdict: under 10 minutes.

### Layer 2 — Builder (Phase 2)
- **FR-2.1** One-click provisioning flow: repo, deploy, database, auth, payments, email, analytics, DNS.
- **FR-2.2** Build engine behind an adapter interface — swappable without product changes.
- **FR-2.3** Output acceptance bar: deployed URL with working auth, payment flow, and analytics events firing.
- **FR-2.4** Build-mode conversation runs at coach tone (sarcasm dial 2/10 — see 03-AI Rules §2).

### Layer 3 — Operator (Phase 3)
- **FR-3.1** Uptime monitoring with incident alerts.
- **FR-3.2** Weekly analytics digest: working / bleeding / next feature, ranked from behavior data.
- **FR-3.3** Churn and retention read against comparable app benchmarks.
- **FR-3.4** Subscription billing $49–$99/mo per live app.

---

## 5. MVP scope (Phase 1, months 1–3)

**In:** Intake flow, evidence pipeline, scoring engine, verdict in Viva voice + 3 next steps, shareable verdict card, Stripe checkout (founding launch pricing, configurable — see FR-1.7), evidence receipts page.
**Out (Phase 2+):** Build orchestration, Operator daemon, team accounts, API access.

**Launch motion:** Free "Viva Roasts" — audience-submitted ideas run through Viva live on @nimratbuilds. The verdict card is the content. The content is the funnel.

---

## 6. Success metrics (90-day)

| Metric | Target |
|---|---|
| Verdict cards shared / verdicts issued | ≥ 25% |
| Free roast → paid validation conversion | ≥ 5% |
| Paid validations | 300 ($23.7K) |
| Verdict dispute rate (user challenges evidence) | < 5% |
| Time to verdict | < 10 minutes |

---

## 7. Open decisions

1. **CTO alignment** — Layer 2 scope is his lane; the $79 anchor assumes the build path ships. Confirm before positioning goes public.
2. **Build engine primary** — Claude Code Agent SDK vs. Bolt embed. Recommendation: Claude Code (deeper control, no revenue share, aligns with Claude Certified Architect prep).
3. **Verdict card watermark** — @nimratbuilds vs. professorviva.com. Recommendation: both, until the domain has its own gravity.
