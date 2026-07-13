# Professor Viva — Shareable Verdict Card (Step 9 of gap-closure plan)
**Companion docs:** 01-PRD (FR-1.5) · 02-Architecture (§3 stage 5) · 03-AI Rules (§2)

---

## 1. Principle

The verdict card is the **growth artifact** — "verdict delivery is the shareable
moment. This is the growth engine" (03-AI Rules §2). It is generated as **pure
code** (`lib/verdict-card.js`): given the same verdict + score + idea, it returns
byte-identical SVG. The card *renders* the already-decided verdict; it never
forms a new opinion.

## 2. Format (FR-1.5)

- **Canvas:** Instagram portrait **4:5** at 1080×1350.
- **Palette (Spearanza):** cream `#E9E4D6`, forest `#3D5C35`, charcoal `#201D13`,
  gold `#C4A44A`. Each verdict draws its accent from the palette
  (BUILD→forest, PIVOT→gold, BURY→charcoal).
- **Content:** the verdict word, the weighted score `/100`, the idea's problem +
  audience (XML-escaped), the five rubric dimensions as mini score-bars, and the
  watermark `@nimratbuilds · professorviva.com` — **both** handles per PRD §7
  open decision 3.

User-supplied idea text is XML-escaped before it enters the SVG, so idea fields
cannot inject markup into the card.

## 3. Generation & retrieval

Card generation is part of the **delivery stage** (Architecture §3 stage 5). When
`runDeliveryStage` finishes the voice pass, it sets `verdicts.card_asset_url` to
the stable path `/ideas/:id/card.svg`. `GET /ideas/:id/card.svg` renders the SVG
on demand from the persisted verdict + recomputed scores and serves it as
`image/svg+xml`. Because rendering is deterministic pure code, on-demand
rendering and a stored asset are equivalent.

**Beta note:** the asset is served as on-demand SVG from the orchestrator.
Production would rasterize to PNG and upload to storage/CDN (stable public URL,
Open Graph friendly) — the `card_asset_url` column already accommodates that
without a pipeline change.

## 4. Done-When

`scripts/test-card.js`:
- **Part A (hermetic):** the pure renderer — output is SVG at 4:5 (1080×1350 +
  viewBox), all four brand colors present, verdict/score/dimension-labels/
  watermark present, byte-for-byte determinism, unknown verdict throws, and
  user text is XML-escaped (a `</text><script>` payload does not survive raw).
- **Part B (real endpoint):** a scored idea 404s on the card before a verdict
  exists; after verdict + delivery, `card_asset_url` is persisted on the verdict
  row and `GET /ideas/:id/card.svg` returns a 200 `image/svg+xml` card showing
  the persisted BURY @ 49.5 with brand palette, 4:5 canvas, and watermark.
