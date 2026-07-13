# Professor Viva — Evidence Receipts Page (Step 10 of gap-closure plan)
**Companion docs:** 01-PRD (FR-1.6) · 02-Architecture (§3 evidence store)

---

## 1. Principle

Receipts are the **anti-dispute mechanism**. Architecture §3: "the evidence store
is append-only ... disputes are answered with receipts, not re-runs." Every
scored claim is linked to the source it came from and shown to the user, grouped
by the rubric dimension it fed, next to the deterministic score that dimension
earned. Transparency is what keeps the dispute rate under the PRD's <5% target.

Like scoring and the card, the receipts page is **pure code** (`lib/receipts.js`).
It assembles already-stored, already-sourced evidence and re-derives the scores
via `computeScores` (the single source of truth). It never calls an LLM and never
forms a new opinion — so it costs no API credits and is byte-for-byte
deterministic.

## 2. What it assembles (FR-1.6)

`buildReceipts({ idea, evidence, verdict })` returns:

- `total_score`, `rubric_version`, `total_claims`, and the persisted `verdict`
  (or `null` when the verdict is still pending — receipts are viewable earlier in
  the pipeline).
- `dimensions[]` — the five rubric dimensions, each with its `label`, `weight`,
  deterministic `score`, `status`, the `supports`/`undermines`/`neutral` counts,
  and its `claims[]`. Each claim carries `{ claim, source_url, signal }`.

The core invariant: **every scored claim links to its source**. A dimension with
no retrieved evidence is disclosed as `insufficient_signal` (score 20), never
hidden or padded with model opinion (03-AI Rules §3).

## 3. Two views, one builder

- `GET /ideas/:id/receipts` — JSON (machines / the SPA).
- `GET /ideas/:id/receipts.html` — a self-contained, server-rendered HTML page in
  the Spearanza palette (`renderReceiptsHTML`), for a shareable human-readable
  receipt.

Both call the same `loadReceipts` (idea + evidence + latest verdict → one
`buildReceipts`), so the two views can never diverge.

## 4. Safety

The HTML page renders user-adjacent data, so it hardens twice:

- **All** user-derived text (idea problem/audience, every claim) is HTML-escaped
  before it enters the page — a `<script>` payload in a claim renders inert.
- Source links are re-checked against an `http(s)` allow-list. Any other scheme
  (`javascript:`, `data:`, …) is rendered as inert text, not an anchor. Anchors
  carry `rel="noopener noreferrer nofollow"` and `target="_blank"`. This is
  defense in depth — source URLs were already validated against retrieved results
  in Step 3.

## 5. Done-When

`scripts/test-receipts.js` (pure code + DB, no API credits):
- **Part A (hermetic):** `buildReceipts` groups by dimension, matches
  `computeScores`, surfaces per-dimension weight/score/signal counts, drops no
  claim, and — critically — every claim links to a source and carries its
  polarity. Empty dimensions are disclosed as `insufficient_signal`. A missing
  verdict is tolerated. `renderReceiptsHTML` carries the brand palette, HTML-
  escapes injected `<script>`/markup, renders non-http source schemes inert, and
  is byte-for-byte deterministic.
- **Part B (real endpoints):** a scored idea's receipts are viewable with the
  verdict pending; after the Step-5 verdict, `GET /ideas/:id/receipts` returns
  JSON carrying the persisted BURY @ 49.5 with every stored claim linked to its
  source, and `GET /ideas/:id/receipts.html` returns a `text/html` page rendering
  the verdict and its sources. Unknown ideas 404.
