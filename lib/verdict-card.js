// Professor Viva — shareable verdict card (Step 9 of the gap-closure plan).
// Implements FR-1.5 and Architecture §3 stage 5 ("verdict card generated in
// Spearanza palette at 4:5").
//
// PURE CODE. No LLM. Given the same verdict + score + idea, this returns the
// exact same SVG — the card is a deterministic rendering of the already-decided
// verdict, never a fresh opinion. The card is the growth artifact (03-AI Rules
// §2: verdict delivery is "the shareable moment"), so it is generated as part
// of the delivery stage and its URL persists on the verdict row.
//
// Format: Instagram portrait 4:5 at 1080x1350. Spearanza brand palette (FR-1.5).
// Beta note: the asset is rendered on demand as SVG and served from the
// orchestrator; production would rasterize to PNG and upload to storage/CDN.
// Watermark carries BOTH handles per PRD §7 open decision 3.

// FR-1.5 palette.
const PALETTE = {
  cream: '#E9E4D6',
  forest: '#3D5C35',
  charcoal: '#201D13',
  gold: '#C4A44A'
};

// 4:5 Instagram portrait.
const CARD = { width: 1080, height: 1350 };

const WATERMARK = '@nimratbuilds  ·  professorviva.com';

// Per-verdict accent, all drawn from the brand palette.
const VERDICT_STYLE = {
  BUILD: { accent: PALETTE.forest, kicker: 'THE VERDICT IS' },
  PIVOT: { accent: PALETTE.gold, kicker: 'THE VERDICT IS' },
  BURY: { accent: PALETTE.charcoal, kicker: 'THE VERDICT IS' }
};

const DIMENSION_LABELS = {
  demand: 'Demand',
  market_gap: 'Market Gap',
  monetization: 'Monetization',
  founder_fit: 'Founder Fit',
  timing: 'Timing'
};

// XML-escape all user-derived text before it enters the SVG (prevents markup
// injection from idea fields — the idea text is user input).
function escapeXml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(str, max) {
  const s = String(str == null ? '' : str).trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// Renders the verdict card as an SVG string.
//   verdict     — 'BUILD' | 'PIVOT' | 'BURY'
//   totalScore  — the rubric-weighted total (0–100)
//   idea        — { audience, problem } (user text; escaped here)
//   dimensions  — computeScores(...).dimensions (per-dimension { score })
function renderVerdictCardSVG({ verdict, totalScore, idea, dimensions }) {
  const style = VERDICT_STYLE[verdict];
  if (!style) throw new Error(`renderVerdictCardSVG: unknown verdict "${verdict}"`);

  const { width: W, height: H } = CARD;
  const score = Math.round(Number(totalScore) * 10) / 10;
  const audience = escapeXml(truncate(idea && idea.audience, 46));
  const problem = escapeXml(truncate(idea && idea.problem, 68));

  // Dimension bars.
  const barX = 120;
  const barW = W - barX * 2; // full inner width
  const rowH = 92;
  const barsTop = 840;
  const dimRows = Object.keys(DIMENSION_LABELS).map((dim, i) => {
    const s = dimensions && dimensions[dim] ? Number(dimensions[dim].score) : 0;
    const y = barsTop + i * rowH;
    const fillW = Math.max(0, Math.min(1, s / 100)) * barW;
    const label = DIMENSION_LABELS[dim];
    return `
      <text x="${barX}" y="${y - 14}" font-size="30" font-weight="600" fill="${PALETTE.charcoal}">${label}</text>
      <text x="${barX + barW}" y="${y - 14}" font-size="30" font-weight="700" fill="${PALETTE.forest}" text-anchor="end">${Math.round(s)}</text>
      <rect x="${barX}" y="${y}" width="${barW}" height="16" rx="8" fill="${PALETTE.charcoal}" opacity="0.12"/>
      <rect x="${barX}" y="${y}" width="${fillW.toFixed(1)}" height="16" rx="8" fill="${style.accent}"/>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Georgia, 'Times New Roman', serif">
  <rect width="${W}" height="${H}" fill="${PALETTE.cream}"/>
  <rect x="0" y="0" width="${W}" height="18" fill="${style.accent}"/>
  <rect x="0" y="${H - 18}" width="${W}" height="18" fill="${style.accent}"/>

  <text x="${W / 2}" y="150" font-size="34" letter-spacing="6" fill="${PALETTE.gold}" text-anchor="middle" font-weight="700">PROFESSOR VIVA</text>
  <text x="${W / 2}" y="300" font-size="34" letter-spacing="4" fill="${PALETTE.charcoal}" text-anchor="middle">${escapeXml(style.kicker)}</text>

  <text x="${W / 2}" y="500" font-size="200" fill="${style.accent}" text-anchor="middle" font-weight="800" letter-spacing="4">${escapeXml(verdict)}</text>

  <text x="${W / 2}" y="620" font-size="52" fill="${PALETTE.forest}" text-anchor="middle" font-weight="700">${score} / 100</text>

  <text x="${W / 2}" y="710" font-size="34" fill="${PALETTE.charcoal}" text-anchor="middle" font-style="italic">${problem}</text>
  <text x="${W / 2}" y="758" font-size="30" fill="${PALETTE.charcoal}" text-anchor="middle" opacity="0.75">for ${audience}</text>

  ${dimRows}

  <text x="${W / 2}" y="${H - 70}" font-size="30" letter-spacing="2" fill="${PALETTE.charcoal}" text-anchor="middle" opacity="0.85">${escapeXml(WATERMARK)}</text>
</svg>`;
}

module.exports = { renderVerdictCardSVG, PALETTE, CARD, WATERMARK };
