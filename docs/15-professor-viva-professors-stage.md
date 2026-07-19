# Professor Viva — The Professor's Stage (Experience Redesign)
**Version 1.0 | July 2026 | Owner: Nimrat**
**Companion docs:** 01-PRD · 02-Architecture · 03-AI Rules · 14-Freemium**

This document is the source of truth for the **complete front-of-house experience
redesign**, "The Professor's Stage." It re-skins and re-sequences the existing
Layer-1 freemium product (docs 04–14) into a minimal comic-book stage where the
professor is the protagonist. It changes **presentation and flow**; it does not
change the verdict logic, scoring, or guardrails — those remain pure code
(CLAUDE.md, 02-Architecture §2, 03-AI Rules §3/§4).

> **Verification constraint (this build).** The Anthropic balance is empty. Every
> "Done When" below is satisfied by **hermetic checks, mocked verdict/pipeline
> data, and manual UI inspection**. No verification path may make a live LLM
> call. Endpoints that would spend credits gain a **mock/sample mode** so the UI
> and data-shape can be inspected offline.

---

## 1. Design language (strict)

A **minimal comic-book panel on cream**. The whole page is one panel — no cards,
no containers, no boxes-within-boxes.

**Palette (only these):**

| Token | Hex | Use |
|---|---|---|
| Cream (background) | `#E9E4D6` | full-page background, no panels/cards |
| Charcoal (ink) | `#201D13` | ALL ink: text, borders, shadows |
| Green (primary) | `#3D5C35` | primary buttons ONLY — exactly one per screen |
| Gold (PIVOT) | `#C4A44A` | PIVOT elements only |
| Hairline | `#c9c3b2` | borders/dividers |
| Muted | `#9a9587` | muted/secondary text |
| Caption fill | `#f5f2e8` | caption box / speech bubble fill |

**Comic grammar:**
- **Caption boxes** — `#f5f2e8` fill, `1.5px` charcoal border, **hard 3px offset
  charcoal shadow** (no blur), tilted `~-1.2deg`.
- **Speech bubbles** — same fill/border/shadow, `border-radius: 16px`, with a
  **tail angled to the speaker**. User bubbles' tails point **off-panel toward
  the reader**; professor bubbles' tails point **to his mouth**.
- **Buttons** — comic treatment: `1.5px` charcoal border + hard offset shadow.
  Primary = green fill; all others = cream/transparent with charcoal ink.
- **Type** — a display serif for the professor's voice + captions; a clean text
  face for body/form. (Playfair Display + Inter, already loaded.)

One primary (green) action per screen. Gold appears only when the verdict is
PIVOT.

---

## 2. The professor (the protagonist)

Assets already at `public/professor/`: `idle.png`, `thinking.png`, `build.png`,
`pivot.png`, `bury.png`. These ship in this commit (already gitignored:
`.DS_Store`).

**Sizing.** LARGE — `300–380px` tall on desktop, `~40vh` on mobile. He is the
dominant object on Screens 1–4. On Screen 5 he is a **~44px header cameo only**
(build pose), never overlapping content.

**Pose ↔ state map:**

| Pose asset | When |
|---|---|
| `idle.png` | Screen 1 entrance/ambient, Screen 2 between beats |
| `thinking.png` | Screen 2 questioning, Screen 3 the wait |
| `build.png` | BUILD reveal, Screen 5 cameo |
| `pivot.png` | PIVOT reveal |
| `bury.png` | BURY reveal |

**Motion system (two independent layers):**
- **Entrance.** On every load he **walks in from a RANDOM direction**
  (left / right / bottom), `~2s` ease-out with a step-bob. Caption, bubble, and
  button pop in **after** he arrives.
- **Reactive.** On idea-input focus/typing, his **eyes shift toward the bubble
  and brows lift** (pose swap or CSS class). Deterministic, event-driven.
- **Ambient.** Every **4–6s (randomized interval)** one random micro-motion from
  a set (subtle wiggle, tilt, bob variants). **Never the same twice
  consecutively.** Independent of the reactive layer.

All motion is CSS-driven; JS only toggles classes / swaps the pose `src` and
schedules the randomized ambient timer.

---

## 3. Screens

### Screen 1 — Entrance
Elements ONLY (nothing else):
1. Caption box, top-left: *"Ask Professor Viva if your idea deserves six months
   of your life."*
2. The professor, LARGE (dominant object).
3. Idea input rendered **as a speech bubble**, mid-left, placeholder
   *"Professor, my idea is..."*
4. One green button: **"Present to the Professor"**.
5. One muted price line.

Entrance choreography: professor walks in (random direction) → caption/bubble/
button pop in after him. Reactive pose on input focus. Ambient micro-motions on
the 4–6s randomized loop.

### Screen 2 — Questioning
The four intake fields (`problem`, `audience`, `monetization_hypothesis`,
`unfair_advantage`) presented **as comic dialogue, one at a time**, professor in
`thinking` pose. **Exact question copy (static, dial 5):**

- **Q1 →** maps to `problem`: *"A whole app in one sentence. Bold. Now — what
  problem does it actually solve, and how badly does it hurt?"*
- **Q2 →** maps to `audience`: *"And who exactly pays for this? Not who uses it —
  who enters the credit card. They are rarely the same person."*
- **Q3 →** maps to `monetization_hypothesis`: *"What will you charge, and how? A
  guess is acceptable. 'I'll figure it out later' is also an answer — just not a
  good one."*
- **Q4 →** maps to `unfair_advantage`: *"Last one. Why you? What do you know,
  own, or have lived that the other fourteen people building this do not?"*

After each answer, a **canned micro-roast reaction** (small italic bubble,
keyword-routed from a static library of ~8 reactions per question — adapted from
the original hardcoded roast arrays in the legacy `/roast` handler) fires before
the next question.

`Q3` and `Q4` each show a skip link: *"Skip — the professor will judge
accordingly."* Skipped fields enter the pipeline as the string **"not
provided"**. (Q1 = idea sentence from Screen 1 is already captured; the four
fields together form the `POST /ideas` payload.)

Completed exchanges fade to **~38% opacity** and compact upward. Progress
indicator: **four dots + "N of 4"**.

### Screen 3 — The wait
Caption: *"Meanwhile, in the professor's study..."*, professor in `thinking`
pose. His bubble **STREAMS findings live** as the quick evidence pass emits them.

- **Real pipeline events** drive it. Each finding renders as a short Viva-voiced
  line from a **per-dimension template**, e.g. *"...found [N] competitors. Oh
  dear."* — templates filled from **real event data, never invented**.
- A ticking counter **"Sources examined: [N]"** from real search events.
- Near completion, one **cliffhanger** line in bold: *"I found something...
  unfortunate. One moment."* (template varies by verdict direction).

**Backend delta.** The free verdict is today a single blocking POST. Add a
**streaming variant** `GET /ideas/:id/free-verdict/stream` (Server-Sent Events)
that runs the quick pass and emits, in order: `finding` events (one per dimension
as it resolves, carrying `{dimension, claim_count, sources_examined, signal_mix}`),
a `progress` event with the running source count, then a terminal `verdict` event
carrying the same payload the blocking endpoint returns (verdict, score, roast,
locked_sections). The quick pass already runs dimensions in parallel
(`gatherQuickEvidence`); the stream emits each as it settles.
**Mock mode:** `?mock=1` streams a seeded, credit-free event sequence so the wait
screen is inspectable offline (satisfies the Done-When without an LLM call).

### Screen 4 — The reveal (card first)
Sequence (strict order):
1. Line: *"The professor has reached a verdict."*
2. The verdict **CARD** animates in (slide-up + settle, `~0.7s`).
3. Beat.
4. The verdict **STAMP** slams on (scale `3.2 → 1` punch, `~0.45s`) with a `0.3s`
   `2px` panel shake.
5. THEN share/download buttons and the rest fade in.

**Card formats** — all **4:5**, in-palette, with a **professor letterhead on
every card**: small portrait of the matching verdict pose + "PROFESSOR VIVA /
Department of Hard Truths" + verdict number + footer "Get your verdict ·
professorviva.com". **Every comedic field is filled from REAL pipeline data,
never invented.**

- **BURY = obituary.** *"In loving memory of [idea]"*; lifespan = actual
  submission-to-verdict elapsed time; *"Cause of death"* = top evidence finding
  in Viva's voice; *"Survived by: [N] identical apps, all also unwell"* (N from
  market_gap competitor count); *"In lieu of flowers: please validate your next
  idea first."* Crooked **BURIED** stamp.
- **PIVOT = driving-test result.** *"Failed: parallel parking into the market"*;
  one skill **passed** (strongest scored dimension) / one **failed** (weakest
  scored dimension); *"Retake permitted: 1 free re-validation."* **RETAKE**
  stamp. Gold accent.
- **BUILD = certificate of approval.** Seal; *"Approved: 1 of [N] this month"*
  (N from real verdict counts); signature line; **APPROVED** stamp. Green accent.

Below the card:
- **Share + download** buttons (free tier — **no payment required**).
- In-character transition line (BURY: *"The card is yours. The autopsy is
  extra."* — variants per verdict).
- Locked sections, ordered **next steps → competitive analysis → evidence**,
  as **blurred teasers drawn from the user's real shallow-pass content**
  (`locked_sections` from the free verdict), teaser labels adopting the card's
  comedic frame.
- Green unlock button: **"Unlock your next steps + full report · ₹1,499 / $39"**.
- Beneath it, a link: **"See a full sample report first →"** → `/sample`.

**Backend delta.** `GET /ideas/:id/card-data` returns the comedic, real-data
fields for the matching verdict format (obituary / driving-test / certificate)
plus letterhead info and the "1 of N this month" count. The card is rendered
client-side in-palette at 4:5 and is downloadable/shareable without payment.
`/sample` serves one **permanently public complete report** seeded with
**mocked-but-realistic** data (flagged `TODO: replace with a real run when
credits exist`).

### Screen 5 — Full report ("The Six Answers")
Professor appears ONLY as a **~44px header cameo** (`build` pose), never
overlapping content. Clean single-column document. The unlocked report is
restructured as **The Six Answers**:

1. **The problem, evidenced** — from `demand` + problem evidence.
2. **Your customer, sharpened** — from `audience` + demand evidence.
3. **Your competitors, priced** — deterministic competitive assembly
   (`buildCompetitiveAnalysis`: market_gap + monetization).
4. **Why anyone switches to you** — from `founder_fit` + differentiation
   evidence.
5. **Your first ten customers — a concrete plan** — a customer-acquisition action
   **grounded in the channels where demand evidence was found**.
6. **Your first dollar — the path** — a first-revenue action **grounded in
   comparable pricing evidence**.

Sections 1–4 render from existing evidence + deterministic competitive assembly.
Sections **5 and 6 are two NEW schema-enforced report fields** the deep run
ALWAYS produces (see §4). Next steps render as **checkboxes with persisted
checked-state per user**.

Header download buttons (**unlocked reports only**):
- **PDF** — full formatted six-answer report, source URLs, `professorviva.com`
  footer per page.
- **Excel** — `.xlsx` evidence table: `dimension, claim, source_url,
  retrieved_at, signal, channel` (channel where present).

Locked-section labels (Screen 4) and unlock subtext become: *"The six answers
every investor will ask you for."* All paid copy leads with the next steps.

---

## 4. Backend deltas (data + generation)

All verdict/score logic stays pure code. These deltas add **structured data** and
**presentation/export**, each hermetically testable with mocked evidence.

1. **Channel data on demand evidence.** The `demand` dimension search strategy is
   updated to explicitly capture **WHERE** demand was found (communities, forums,
   directories, associations) as structured `channel` data on the evidence rows.
   - Migration: add `channel jsonb` (nullable) to `evidence`.
   - `ClaimsSchema` for the demand dimension gains an optional `channel` object
     (e.g. `{ type, name, url }`); `insertEvidence` persists it.
   - Answer 5 grounds its acquisition plan in these real channels.
   - **Hermetic test:** a mocked demand pass yields rows carrying `channel`
     data, and Answer 5 renders grounded in it.

2. **Six-answers schema-enforced fields (Answers 5 & 6).** The deep-run report
   generation ALWAYS produces:
   - `acquisition` (Answer 5) — grounded in demand channels.
   - `first_revenue` (Answer 6) — grounded in comparable pricing evidence.
   These are **schema-enforced** (zod `.min/.max`, non-empty) so a run can never
   omit them. Persisted on the verdict row (migration: add
   `six_answers jsonb`). **Hermetic test** with mocked evidence asserts both
   fields are present and non-empty and reference real evidence.

3. **Checkbox state persistence.** Migration for a `next_step_checks` table
   keyed by `(free_verdict_or_verdict, step_index, account)`; `GET`/`PUT`
   endpoints read/write checked-state per user.

4. **/sample public report.** `GET /sample` serves a complete six-answer report
   from a seeded fixture (mock data). Public, no auth, no payment.

5. **PDF + Excel export.** `GET /ideas/:id/report.pdf` and
   `GET /ideas/:id/report.xlsx`, **unlocked reports only** (same 402 gate as the
   report). Generated from report data (mocked data in tests). Dependencies added
   for PDF and XLSX generation. **Hermetic test:** both generate a valid,
   non-empty file from mocked data.

**Migrations to apply manually** (service-role key cannot run DDL — project
constraint): `evidence.channel`, `verdicts.six_answers`, `next_step_checks`.
Bundled as new numbered files under `supabase/migrations/`.

---

## 5. Done When (hermetic + manual UI only)

- Professor renders at the specified size and **enters from a random direction**
  across reloads; **input focus triggers the reactive pose**; **ambient motions
  fire at randomized 4–6s intervals**.
- All four questions display with **micro-roasts firing from the static library**
  and **skips recording "not provided."**
- The wait screen renders **streamed mock events into voiced lines** with a
  **ticking counter** and a **cliffhanger**.
- Each verdict type produces its **distinct card format** with letterhead,
  **real-data fields (mocked pipeline data)**, and the **slide → stamp → shake**
  sequence in order **before** share buttons appear.
- Share/download work **without payment**; `/sample` serves a **complete public
  report**.
- The unlocked report renders **all six answer sections** with **checkbox next
  steps persisting state**, and **both PDF and Excel** downloads generate
  correctly from mocked data.
- The **six-answers schema test passes** with mocked evidence.
- **Evidence rows from a mocked demand pass include structured channel data** and
  **Answer 5 renders grounded in it**.
- **No live LLM call occurs anywhere in verification.**

---

## 6. Non-goals / invariants

- No change to scoring weights, verdict thresholds, or the two-pass rule.
- No LLM ever assigns a score or a verdict (CLAUDE.md).
- Guardrails (03-AI Rules §4) still run server-side on all generated prose,
  including teasers; no fabricated teaser or card field.
- Cards, competitive analysis, and the six-answer structure are deterministic
  assemblies of real pipeline data; the ONLY generative parts remain the voiced
  prose/next-steps, unchanged in mechanism.
