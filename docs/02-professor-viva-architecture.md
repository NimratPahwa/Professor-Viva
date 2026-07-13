# Professor Viva — Architecture Document
**Version 1.0 | July 2026 | Owner: Nimrat · Implementation lead: CTO**
**Companion docs:** 01-PRD · 03-AI Rules

---

## 1. System overview

```
┌─────────────────────────────────────────────────────┐
│  Frontend (Next.js on Vercel)                       │
│  Chat UI · verdict cards · build dashboard          │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  Orchestrator API (Node/TS on Vercel functions)     │
│  Session state · pipeline state machine · billing   │
└───────┬───────────────┬───────────────┬─────────────┘
        │               │               │
┌───────▼──────┐ ┌──────▼───────┐ ┌─────▼────────────┐
│ Validation   │ │ Build        │ │ Operator         │
│ agents       │ │ orchestrator │ │ daemon           │
│ (Claude API  │ │ (Claude Code │ │ (cron + webhooks:│
│ + web search │ │ Agent SDK →  │ │ uptime, PostHog, │
│ tool)        │ │ GitHub/Vercel│ │ Stripe events)   │
└───────┬──────┘ │ /Supabase)   │ └─────┬────────────┘
        │        └──────────────┘       │
┌───────▼────────────────────────────────▼────────────┐
│  Data layer (Supabase Postgres)                     │
│  ideas · evidence · scores · verdicts · apps ·      │
│  metrics snapshots · Viva conversation memory       │
└─────────────────────────────────────────────────────┘
```

---

## 2. Architectural principles (non-negotiable)

1. **Personality is a layer, not a model.** All Viva voice lives in a versioned system-prompt stack + reply template library (03-AI Rules). Analysis agents run neutral; voice is applied at delivery. The personality can be A/B tested without touching the pipeline.
2. **Verdict logic is code, not prompt.** Scoring weights and BUILD/PIVOT/BURY thresholds live in the orchestrator. Same idea + same evidence = same verdict. No verdict roulette.
3. **Evidence store is append-only.** Every scored claim persists with its source URL and retrieval timestamp. Disputes are answered with receipts, not re-runs.
4. **Build engine is swappable.** An adapter interface abstracts Claude Code / Bolt / Lovable so the engine underneath can change without product changes.
5. **Analysis and voice are separate LLM requests.** Analysis returns structured JSON; a second pass renders it in Viva voice. Voice can never alter scores.

---

## 3. Layer 1 — Validation pipeline

Deterministic five-stage state machine; each stage persists before the next begins, so a crashed run resumes rather than restarts.

| Stage | Component | Behavior |
|---|---|---|
| 1. Intake | Frontend + orchestrator | Structured capture: problem, audience, monetization hypothesis, unfair advantage. Max 3 clarifying questions. |
| 2. Evidence | Parallel Claude agents with web search | Competitor scan, pricing scan, community demand (Reddit et al.), trend trajectory, recent launches, app store listings. Unsourced claims discarded at this boundary. |
| 3. Scoring | Orchestrator (pure function) | Rubric weights applied to evidence counts and signals. No LLM in this stage. |
| 4. Verdict | Orchestrator (pure function) | Threshold comparison → BUILD / PIVOT / BURY. |
| 5. Delivery | Voice-pass LLM + card renderer | Verdict rendered per 03-AI Rules; verdict card generated in Spearanza palette at 4:5. |

**Model allocation:** Sonnet-class for evidence gathering (volume, cost); top-tier Claude for the verdict voice pass — the shareable artifact must be excellent.

**Failure modes:** any evidence agent timing out degrades to "insufficient signal" for that dimension (scored accordingly and disclosed), never to fabricated filler. The per-dimension timeout budget is **240s** (interim beta value — see below). A dimension that exceeds it, or returns zero code-validated claims, degrades to "insufficient signal".

**Execution model — interim vs. production:**

*Interim (current beta):* Evidence gathering runs **synchronously** inside the `POST /ideas/:id/evidence` request. All five dimensions run in parallel via `Promise.all`; each is one streamed Claude call (`web_search` + structured output). Empirically a thorough web-search-grounded call takes ~3 minutes (measured: 181s for a single dimension returning 33 sourced claims), so the request blocks for ~3–5 minutes and the per-dimension timeout is 240s (not the 45s originally sketched). This is acceptable for the beta but is **not** the intended production architecture — a multi-minute synchronous HTTP request is fragile (client/proxy timeouts, no recovery on crash, no visibility).

*Production TODO — persistent async evidence job:* Move evidence gathering off the request path into a durable background job. Required properties:
- **Job status** — queued / running / partial / complete / failed, queryable by the client (poll or push).
- **Retries** — automatic, bounded retries per dimension on transient failure (5xx, rate limit, network), with backoff.
- **Idempotency** — re-triggering evidence for an idea must not duplicate claims or double-charge API cost; a stable job key per (idea, rubric version) dedupes.
- **Cancellation** — an in-flight job can be cancelled (e.g., user abandons, idea edited) and stops consuming API budget promptly.
- **Progress reporting** — per-dimension progress surfaced to the client so the UI can show which dimensions are done vs. pending.
- **Failure recovery** — a crashed worker resumes from the last persisted dimension rather than restarting all five (aligns with the §3 "each stage persists before the next begins" resumability principle).
- **Stored results** — dimension outcomes (validated claims *and* explicit "insufficient signal" flags) persist as they complete, so a partially-finished job still yields usable, receipted evidence.

---

## 4. Layer 2 — Build orchestration

**Provisioning flow (single user action):**
1. Create GitHub repo + CI from template
2. Provision Supabase project (Postgres + auth)
3. Claude Code Agent SDK build run against the validated spec
4. Deploy to Vercel; Cloudflare DNS
5. Wire Stripe (payments), Resend (transactional email), PostHog (analytics)
6. Smoke tests: auth round-trip, test payment, analytics event received
7. Hand back live URL

**Adapter contract:** `build(spec) → {repo, deployment, status}` — implemented per engine (Claude Code primary; Bolt/Lovable fallbacks). Engine choice is config, not code.

**Acceptance bar:** a build is not "done" until step 6 passes. A repo without a passing smoke test never reaches the user.

---

## 5. Layer 3 — Operator daemon

- **Uptime:** external ping monitors per app; incident webhook → alert in Viva voice (calibrated per 03-AI Rules §2 — incidents get zero sarcasm).
- **Analytics:** weekly PostHog pull → digest generation (working / bleeding / next feature ranked by observed behavior).
- **Billing events:** Stripe webhooks → churn flags, failed-payment handling (plain tone, always).
- **Benchmarks:** retention read against comparable-category baselines stored in the data layer.

---

## 6. Data model (core tables)

| Table | Purpose |
|---|---|
| `ideas` | Intake payloads, owner, status |
| `evidence` | Append-only sourced claims: claim, source_url, retrieved_at, dimension |
| `scores` | Per-dimension scores + rubric version used |
| `verdicts` | Verdict, threshold version, voice-pass output, card asset URL |
| `apps` | Built apps: repo, deployment, stack handles |
| `metrics_snapshots` | Weekly PostHog pulls per app |
| `viva_memory` | Per-user conversation context for Operator continuity |

Rubric and threshold versions are stored on every score/verdict row — verdicts remain auditable after the rubric evolves.

---

## 7. Security & privacy

- Ideas are confidential by default; evidence gathering never posts or exposes user idea text to third-party communities — search queries are derived category terms, not the idea verbatim.
- Per-user data isolation via Supabase row-level security.
- Built apps run in the user's own service accounts where possible (Stripe, GitHub) — Viva orchestrates with scoped tokens; the founder owns the assets.
- Output filter (03-AI Rules §4) runs server-side before any Viva reply renders.

---

## 8. Build sequence

| Phase | Scope | Owner |
|---|---|---|
| 1 (mo 1–3) | Validator pipeline, verdict cards, checkout, receipts page | Nimrat (prompts, rubric, brand) + CTO (pipeline, infra) |
| 2 (mo 4–9) | Build orchestrator + adapter, provisioning flow, smoke tests | CTO |
| 3 (mo 10+) | Operator daemon, subscription billing, benchmarks | CTO |
