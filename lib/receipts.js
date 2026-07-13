// Professor Viva — evidence receipts (Step 10 of the gap-closure plan).
// Implements FR-1.6 ("Evidence receipts page — every scored claim linked to its
// source, viewable by the user") and Architecture §3 ("Evidence store is
// append-only ... Disputes are answered with receipts, not re-runs").
//
// PURE CODE. No LLM. This assembles the stored, sourced evidence behind a
// verdict into a user-viewable structure, grouped by rubric dimension, with the
// deterministic score for each dimension shown alongside the claims that
// produced it. Transparency is the anti-dispute mechanism (PRD success metric:
// dispute rate < 5%).

const { computeScores, WEIGHTS, DIMENSIONS } = require('./scoring');

const DIMENSION_LABELS = {
  demand: 'Demand',
  market_gap: 'Market Gap',
  monetization: 'Monetization',
  founder_fit: 'Founder Fit',
  timing: 'Timing'
};

const SIGNAL_LABELS = {
  supports: 'Supports',
  undermines: 'Undermines',
  neutral: 'Neutral'
};

// Builds the receipts payload for one idea from its stored evidence.
//   idea      — { id, problem, audience }
//   evidence  — the idea's evidence rows ({ dimension, signal, claim, source_url })
//   verdict   — the latest verdict row, or null if not yet decided
// Scores are recomputed deterministically (single source of truth = computeScores).
function buildReceipts({ idea, evidence, verdict }) {
  const scored = computeScores(evidence);

  const byDimension = {};
  for (const dim of DIMENSIONS) byDimension[dim] = [];
  for (const row of evidence) {
    if (byDimension[row.dimension]) {
      byDimension[row.dimension].push({
        claim: row.claim,
        source_url: row.source_url,
        signal: row.signal || 'neutral'
      });
    }
  }

  const dimensions = DIMENSIONS.map((dim) => {
    const s = scored.dimensions[dim];
    return {
      dimension: dim,
      label: DIMENSION_LABELS[dim],
      weight: WEIGHTS[dim],
      score: s.score,
      status: s.status,
      supports: s.supports,
      undermines: s.undermines,
      neutral: s.neutral,
      claims: byDimension[dim]
    };
  });

  return {
    idea_id: idea.id,
    idea: { problem: idea.problem, audience: idea.audience },
    rubric_version: scored.rubric_version,
    total_score: scored.total,
    verdict: verdict
      ? { verdict: verdict.verdict, total_score: Number(verdict.total_score), threshold_version: verdict.threshold_version }
      : null,
    total_claims: evidence.length,
    dimensions
  };
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Only http(s) links are rendered as anchors — any other scheme (javascript:,
// data:, etc.) is shown as inert text. Defense in depth: source_urls were
// already validated against retrieved results in Step 3, but the receipts page
// renders user-adjacent data, so it re-checks the scheme here.
function isSafeHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function renderSourceLink(url) {
  const safe = escapeHtml(url);
  if (!isSafeHttpUrl(url)) return `<span class="source">${safe}</span>`;
  return `<a class="source" href="${safe}" target="_blank" rel="noopener noreferrer nofollow">${safe}</a>`;
}

// Server-rendered, self-contained receipts page (FR-1.6). All user-derived text
// is escaped; sources are safe links.
function renderReceiptsHTML(receipts) {
  const P = { cream: '#E9E4D6', forest: '#3D5C35', charcoal: '#201D13', gold: '#C4A44A' };
  const verdictLine = receipts.verdict
    ? `${escapeHtml(receipts.verdict.verdict)} · ${escapeHtml(String(receipts.verdict.total_score))}/100`
    : 'Verdict pending';

  const sections = receipts.dimensions.map((d) => {
    const claims = d.claims.length === 0
      ? `<p class="empty">No validated evidence retrieved for this dimension — scored as insufficient signal.</p>`
      : `<ul class="claims">` + d.claims.map((c) => `
          <li class="claim signal-${escapeHtml(c.signal)}">
            <span class="badge">${escapeHtml(SIGNAL_LABELS[c.signal] || c.signal)}</span>
            <span class="text">${escapeHtml(c.claim)}</span>
            ${renderSourceLink(c.source_url)}
          </li>`).join('') + `</ul>`;
    return `
      <section class="dimension">
        <header>
          <h2>${escapeHtml(d.label)}</h2>
          <div class="meta">
            <span class="score">${escapeHtml(String(d.score))}/100</span>
            <span class="weight">weight ${escapeHtml(String(Math.round(d.weight * 100)))}%</span>
            <span class="counts">${d.supports}↑ / ${d.undermines}↓ / ${d.neutral}·</span>
          </div>
        </header>
        ${claims}
      </section>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Evidence Receipts — Professor Viva</title>
<style>
  :root { --cream:${P.cream}; --forest:${P.forest}; --charcoal:${P.charcoal}; --gold:${P.gold}; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--cream); color:var(--charcoal); font-family: Georgia, 'Times New Roman', serif; line-height:1.5; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 48px 24px 96px; }
  .kicker { letter-spacing:4px; color:var(--gold); font-weight:700; font-size:14px; }
  h1 { margin:8px 0 4px; font-size:34px; }
  .verdict { display:inline-block; margin-top:8px; padding:6px 14px; border-radius:999px; background:var(--forest); color:var(--cream); font-weight:700; }
  .idea { margin:20px 0 8px; font-style:italic; }
  .total { color:var(--forest); font-weight:700; }
  .dimension { background:#fff8; border:1px solid var(--charcoal)22; border-radius:14px; padding:20px 22px; margin:20px 0; }
  .dimension header { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; border-bottom:1px solid var(--charcoal)22; padding-bottom:10px; }
  .dimension h2 { margin:0; font-size:22px; }
  .meta { display:flex; gap:14px; font-size:14px; opacity:.85; }
  .meta .score { color:var(--forest); font-weight:700; }
  ul.claims { list-style:none; padding:0; margin:14px 0 0; }
  li.claim { padding:12px 0; border-bottom:1px dashed var(--charcoal)22; }
  li.claim:last-child { border-bottom:none; }
  .badge { display:inline-block; font-size:11px; font-weight:700; letter-spacing:1px; text-transform:uppercase; padding:2px 8px; border-radius:6px; margin-right:8px; }
  .signal-supports .badge { background:var(--forest); color:var(--cream); }
  .signal-undermines .badge { background:var(--charcoal); color:var(--cream); }
  .signal-neutral .badge { background:var(--gold); color:var(--charcoal); }
  .text { display:block; margin:6px 0; }
  a.source, span.source { font-size:13px; word-break:break-all; color:var(--forest); }
  .empty { opacity:.7; font-style:italic; }
  footer { margin-top:32px; font-size:13px; opacity:.7; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="kicker">PROFESSOR VIVA · EVIDENCE RECEIPTS</div>
    <h1>Every claim, every source</h1>
    <div class="verdict">${verdictLine}</div>
    <p class="idea">${escapeHtml(receipts.idea.problem)}</p>
    <p>for ${escapeHtml(receipts.idea.audience)} · <span class="total">weighted total ${escapeHtml(String(receipts.total_score))}/100</span> · ${receipts.total_claims} sourced claims</p>
    ${sections}
    <footer>Scores are computed deterministically from the sourced claims above (rubric ${escapeHtml(receipts.rubric_version)}). Disputes are answered with these receipts, not re-runs.</footer>
  </div>
</body>
</html>`;
}

module.exports = { buildReceipts, renderReceiptsHTML, DIMENSION_LABELS, SIGNAL_LABELS };
