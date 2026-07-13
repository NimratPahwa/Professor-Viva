// Done-When demo for Step 9 (shareable verdict card, FR-1.5).
//
// Step 9 Done-When: a deterministic, shareable verdict card is generated in the
// Spearanza brand palette at Instagram 4:5, its URL persists on the verdict row
// during delivery, and it is retrievable as an SVG asset.
//
// Part A is hermetic (no DB/API): the pure SVG renderer — 4:5 dimensions, all
// four brand colors, verdict + score + watermark present, user text XML-escaped
// (injection-safe), and byte-for-byte determinism.
// Part B exercises the real delivery + retrieval: a scored idea is voiced (which
// sets the card URL), then GET /ideas/:id/card.svg returns the SVG.

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { renderVerdictCardSVG, PALETTE, CARD, WATERMARK } = require('../lib/verdict-card');
const { computeScores } = require('../lib/scoring');
const { getSupabase } = require('../lib/db');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

let failures = 0;
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}

const DIMS = {
  demand: { score: 80 }, market_gap: { score: 30 }, monetization: { score: 50 },
  founder_fit: { score: 20 }, timing: { score: 50 }
};

function partA() {
  console.log('--- Part A: pure SVG renderer (no DB/API) ---');

  const svg = renderVerdictCardSVG({
    verdict: 'BURY', totalScore: 49.5,
    idea: { audience: 'Small construction firms', problem: 'Reconciling invoices by hand' },
    dimensions: DIMS
  });

  assert(svg.trimStart().startsWith('<?xml') || svg.includes('<svg'), 'output is an SVG document');
  // FR-1.5: Instagram 4:5.
  assert(CARD.width === 1080 && CARD.height === 1350, 'card constant is 1080x1350');
  assert(CARD.width / CARD.height === 4 / 5, 'card aspect ratio is exactly 4:5');
  assert(svg.includes(`width="1080"`) && svg.includes(`height="1350"`) && svg.includes(`viewBox="0 0 1080 1350"`), 'SVG carries 4:5 dimensions + viewBox');

  // FR-1.5: full Spearanza palette present.
  assert(svg.includes(PALETTE.cream), 'palette: cream present');
  assert(svg.includes(PALETTE.forest), 'palette: forest green present');
  assert(svg.includes(PALETTE.charcoal), 'palette: charcoal present');
  assert(svg.includes(PALETTE.gold), 'palette: gold present');

  // Content: verdict, score, dimensions, watermark (both handles — PRD §7.3).
  assert(svg.includes('>BURY<'), 'verdict word rendered');
  assert(svg.includes('49.5 / 100'), 'weighted score rendered');
  assert(svg.includes('Demand') && svg.includes('Market Gap') && svg.includes('Monetization'), 'dimension labels rendered');
  assert(svg.includes('@nimratbuilds') && svg.includes('professorviva.com'), 'watermark carries both handles');

  // Determinism.
  const svg2 = renderVerdictCardSVG({ verdict: 'BURY', totalScore: 49.5, idea: { audience: 'Small construction firms', problem: 'Reconciling invoices by hand' }, dimensions: DIMS });
  assert(svg === svg2, 'same inputs produce byte-identical SVG (deterministic)');

  // Each verdict renders with its palette accent.
  const build = renderVerdictCardSVG({ verdict: 'BUILD', totalScore: 88, idea: {}, dimensions: DIMS });
  assert(build.includes('>BUILD<') && build.includes('88 / 100'), 'BUILD card renders');
  let threw = false;
  try { renderVerdictCardSVG({ verdict: 'NONSENSE', totalScore: 10, idea: {}, dimensions: DIMS }); } catch { threw = true; }
  assert(threw, 'unknown verdict throws rather than rendering garbage');

  // Injection safety: user text is XML-escaped.
  const evil = renderVerdictCardSVG({
    verdict: 'PIVOT', totalScore: 60,
    idea: { audience: '</text><script>alert(1)</script>', problem: 'Tom & Jerry "quotes" <b>' },
    dimensions: DIMS
  });
  assert(!evil.includes('<script>'), 'raw <script> from user text does not appear (escaped)');
  assert(evil.includes('&lt;script&gt;') && evil.includes('&amp;'), 'user text is XML-escaped');
}

async function partB() {
  console.log('--- Part B: real delivery sets card URL + GET renders it ---');
  const serverProc = spawn('node', ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) }
  });

  const waitForServer = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    serverProc.stdout.on('data', (chunk) => { if (chunk.toString().includes('ready to judge')) { clearTimeout(timeout); resolve(); } });
    serverProc.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });

  let ideaId = null;
  const supabase = getSupabase();

  const fixture = [];
  const add = (dimension, signal, count) => { for (let i = 0; i < count; i++) fixture.push({ dimension, signal, claim: `${dimension}-${signal}-${i}`, source_url: `https://example.com/${dimension}/${signal}/${i}` }); };
  add('demand', 'supports', 4); add('demand', 'undermines', 1);
  add('market_gap', 'supports', 1); add('market_gap', 'undermines', 3);
  add('monetization', 'supports', 2); add('monetization', 'undermines', 2); add('monetization', 'neutral', 1);
  add('timing', 'neutral', 3);

  try {
    await waitForServer();

    const createRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem: 'Placeholder problem for the verdict-card test, long enough to pass intake validation.',
        audience: 'Small construction firms.',
        monetization_hypothesis: 'Flat monthly subscription per active job site.',
        unfair_advantage: 'Founder ran back-office ops for a mid-size GC for six years.'
      })
    });
    const idea = await createRes.json();
    ideaId = idea.id;
    assert(createRes.status === 201 && !!ideaId, 'test idea created');

    const rows = fixture.map((r) => ({ idea_id: ideaId, dimension: r.dimension, signal: r.signal, claim: r.claim, source_url: r.source_url }));
    const { error: evErr } = await supabase.from('evidence').insert(rows);
    assert(!evErr, `synthetic evidence inserted (error: ${evErr ? evErr.message : 'none'})`);

    // Card retrieval before a verdict exists -> 404.
    const earlyCard = await fetch(`${BASE_URL}/ideas/${ideaId}/card.svg`);
    assert(earlyCard.status === 404, `card 404s before a verdict exists (got ${earlyCard.status})`);

    // Decide verdict (Step 5) then deliver (voice + card, Step 9).
    await fetch(`${BASE_URL}/ideas/${ideaId}/verdict`, { method: 'POST' });
    const voiceRes = await fetch(`${BASE_URL}/ideas/${ideaId}/voice`, { method: 'POST' });
    assert(voiceRes.status === 200, `delivery (voice) returns 200 (got ${voiceRes.status})`);

    // Delivery persisted the card URL on the verdict row.
    const { data: verdictRows } = await supabase.from('verdicts').select('*').eq('idea_id', ideaId);
    assert(verdictRows.length === 1 && verdictRows[0].card_asset_url === `/ideas/${ideaId}/card.svg`, `card_asset_url persisted on the verdict row (got ${verdictRows[0] && verdictRows[0].card_asset_url})`);

    // The card is retrievable as an SVG.
    const cardRes = await fetch(`${BASE_URL}${verdictRows[0].card_asset_url}`);
    assert(cardRes.status === 200, `card endpoint returns 200 (got ${cardRes.status})`);
    assert((cardRes.headers.get('content-type') || '').includes('image/svg+xml'), 'card served as image/svg+xml');
    const svg = await cardRes.text();
    assert(svg.includes('>BURY<') && svg.includes('49.5 / 100'), 'served card shows the persisted BURY @ 49.5');
    assert(svg.includes(PALETTE.forest) && svg.includes('viewBox="0 0 1080 1350"'), 'served card carries brand palette + 4:5 canvas');
    assert(svg.includes(WATERMARK.split('·')[0].trim()), 'served card carries the watermark');

  } finally {
    serverProc.kill();
    if (ideaId) {
      await supabase.from('ideas').delete().eq('id', ideaId);
      console.log(`Cleaned up test idea ${ideaId} (evidence + verdict cascade).`);
    }
  }
}

async function main() {
  partA();
  await partB();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
