// Done-When demo for Step 10 (evidence receipts page, FR-1.6).
//
// Step 10 Done-When: every scored claim is linked to its source and viewable by
// the user, grouped by rubric dimension, with the deterministic per-dimension
// score shown alongside the claims that produced it (Architecture §3: "Disputes
// are answered with receipts, not re-runs"). PURE CODE — no LLM, so no API
// credits are spent here; receipts are assembled from stored evidence + the
// persisted verdict.
//
// Part A is hermetic (no DB/API): buildReceipts grouping + scores + the
// every-claim-carries-a-source invariant, and renderReceiptsHTML escaping +
// safe-link rendering (non-http schemes rendered inert).
// Part B exercises the real endpoints: a scored idea is decided (Step 5), then
// GET /ideas/:id/receipts (JSON) and GET /ideas/:id/receipts.html (HTML).

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { buildReceipts, renderReceiptsHTML } = require('../lib/receipts');
const { computeScores, WEIGHTS } = require('../lib/scoring');
const { determineVerdict } = require('../lib/verdict');
const { getSupabase } = require('../lib/db');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

let failures = 0;
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}

// Same fixture as the scoring/verdict/voice tests -> weighted total 49.5 -> BURY.
function buildFixtureEvidence() {
  const rows = [];
  const add = (dimension, signal, count) => {
    for (let i = 0; i < count; i++) {
      rows.push({ dimension, signal, claim: `${dimension}-${signal}-${i}`, source_url: `https://example.com/${dimension}/${signal}/${i}` });
    }
  };
  add('demand', 'supports', 4);
  add('demand', 'undermines', 1);
  add('market_gap', 'supports', 1);
  add('market_gap', 'undermines', 3);
  add('monetization', 'supports', 2);
  add('monetization', 'undermines', 2);
  add('monetization', 'neutral', 1);
  add('timing', 'neutral', 3);
  return rows;
}

function partA() {
  console.log('--- Part A: buildReceipts + renderReceiptsHTML (no DB/API) ---');

  const idea = { id: 'idea-A', problem: 'Reconciling invoices by hand', audience: 'Small construction firms' };
  const evidence = buildFixtureEvidence();
  const verdict = { verdict: 'BURY', total_score: 49.5, threshold_version: 'threshold-1.0.0' };
  const receipts = buildReceipts({ idea, evidence, verdict });

  // Scores are recomputed deterministically — single source of truth.
  const scored = computeScores(evidence);
  assert(receipts.total_score === scored.total, `receipts total matches computeScores (${scored.total})`);
  assert(receipts.rubric_version === scored.rubric_version, 'receipts carry the rubric version');
  assert(receipts.total_claims === evidence.length, `every stored claim counted (${evidence.length})`);
  assert(receipts.verdict && receipts.verdict.verdict === 'BURY', 'receipts carry the persisted verdict');

  // Grouped by rubric dimension — all five present, each with its weight + score.
  assert(receipts.dimensions.length === 5, 'all five rubric dimensions present');
  const demand = receipts.dimensions.find((d) => d.dimension === 'demand');
  assert(demand.weight === WEIGHTS.demand, 'dimension carries its rubric weight');
  assert(demand.score === scored.dimensions.demand.score, 'dimension score matches computeScores');
  assert(demand.claims.length === 5, 'demand groups its 5 claims (4 supports + 1 undermines)');
  assert(demand.supports === 4 && demand.undermines === 1, 'signal counts surfaced per dimension');

  // FR-1.6 core invariant: EVERY scored claim is linked to its source.
  const allClaims = receipts.dimensions.flatMap((d) => d.claims);
  assert(allClaims.length === evidence.length, 'no claim dropped in grouping');
  assert(allClaims.every((c) => typeof c.source_url === 'string' && c.source_url.length > 0), 'every claim links to a source URL');
  assert(allClaims.every((c) => ['supports', 'undermines', 'neutral'].includes(c.signal)), 'every claim carries its polarity signal');

  // A dimension with no evidence (founder_fit) is disclosed, not hidden.
  const founder = receipts.dimensions.find((d) => d.dimension === 'founder_fit');
  assert(founder.claims.length === 0 && founder.status === 'insufficient_signal', 'empty dimension disclosed as insufficient_signal');

  // Verdict-pending receipts (no verdict row yet).
  const pending = buildReceipts({ idea, evidence, verdict: null });
  assert(pending.verdict === null, 'receipts tolerate a missing verdict (pending)');

  // --- HTML rendering ---
  const html = renderReceiptsHTML(receipts);
  assert(html.includes('<!DOCTYPE html>') && html.includes('Evidence Receipts'), 'renders a full HTML receipts page');
  assert(html.includes('#3D5C35') && html.includes('#E9E4D6'), 'HTML carries the Spearanza brand palette');
  assert(html.includes('demand-supports-0'), 'a claim appears in the HTML');
  assert(html.includes('https://example.com/demand/supports/0'), 'the claim source URL appears in the HTML');

  // Injection safety: user-derived text is HTML-escaped.
  const evil = buildReceipts({
    idea: { id: 'x', problem: 'Tom & Jerry <script>alert(1)</script>', audience: '"quotes" & <b>' },
    evidence: [{ dimension: 'demand', signal: 'supports', claim: '<img src=x onerror=alert(1)>', source_url: 'https://ok.example/1' }],
    verdict: null
  });
  const evilHtml = renderReceiptsHTML(evil);
  assert(!evilHtml.includes('<script>alert(1)</script>'), 'raw <script> from user text does not appear (escaped)');
  assert(!evilHtml.includes('<img src=x onerror'), 'raw claim markup does not appear (escaped)');
  assert(evilHtml.includes('&amp;') && evilHtml.includes('&lt;script&gt;'), 'user text is HTML-escaped');

  // Non-http(s) source schemes are rendered inert (defense in depth).
  const nasty = buildReceipts({
    idea: { id: 'y', problem: 'p', audience: 'a' },
    evidence: [{ dimension: 'demand', signal: 'supports', claim: 'c', source_url: 'javascript:alert(1)' }],
    verdict: null
  });
  const nastyHtml = renderReceiptsHTML(nasty);
  assert(!/href="javascript:/i.test(nastyHtml), 'javascript: source is not rendered as a live link');
  assert(nastyHtml.includes('<span class="source">javascript:alert(1)</span>'), 'unsafe scheme rendered as inert text');

  // Determinism.
  assert(renderReceiptsHTML(receipts) === html, 'same receipts produce byte-identical HTML (deterministic)');
}

async function partB() {
  console.log('--- Part B: real endpoints GET /receipts + /receipts.html ---');
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

  try {
    await waitForServer();

    const createRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem: 'Placeholder problem for the receipts test, long enough to pass intake validation.',
        audience: 'Small construction firms.',
        monetization_hypothesis: 'Flat monthly subscription per active job site.',
        unfair_advantage: 'Founder ran back-office ops for a mid-size GC for six years.'
      })
    });
    const idea = await createRes.json();
    ideaId = idea.id;
    assert(createRes.status === 201 && !!ideaId, 'test idea created');

    const rows = buildFixtureEvidence().map((r) => ({ idea_id: ideaId, dimension: r.dimension, signal: r.signal, claim: r.claim, source_url: r.source_url }));
    const { error: evErr } = await supabase.from('evidence').insert(rows);
    assert(!evErr, `synthetic evidence inserted (error: ${evErr ? evErr.message : 'none'})`);

    // Receipts are viewable before a verdict (verdict pending), FR-1.6.
    const pendingRes = await fetch(`${BASE_URL}/ideas/${ideaId}/receipts`);
    const pending = await pendingRes.json();
    assert(pendingRes.status === 200 && pending.verdict === null, 'receipts available with verdict pending');
    assert(pending.total_claims === rows.length, 'pending receipts count every stored claim');

    // Decide the verdict (Step 5) so receipts carry it.
    const verdictRes = await fetch(`${BASE_URL}/ideas/${ideaId}/verdict`, { method: 'POST' });
    const verdictBody = await verdictRes.json();
    const expectedTotal = computeScores(buildFixtureEvidence()).total; // 49.5
    assert(verdictRes.status === 200 && verdictBody.verdict === determineVerdict(expectedTotal), 'verdict decided (BURY @ 49.5)');

    // JSON receipts.
    const jsonRes = await fetch(`${BASE_URL}/ideas/${ideaId}/receipts`);
    assert(jsonRes.status === 200, `GET /receipts returns 200 (got ${jsonRes.status})`);
    assert((jsonRes.headers.get('content-type') || '').includes('application/json'), 'receipts served as JSON');
    const receipts = await jsonRes.json();
    assert(receipts.total_score === expectedTotal, `served receipts total is ${expectedTotal}`);
    assert(receipts.verdict && receipts.verdict.verdict === 'BURY', 'served receipts carry the persisted BURY verdict');
    const served = receipts.dimensions.flatMap((d) => d.claims);
    assert(served.length === rows.length, 'served receipts link every stored claim');
    assert(served.every((c) => c.source_url && c.source_url.startsWith('https://example.com/')), 'every served claim carries its source URL');

    // HTML receipts.
    const htmlRes = await fetch(`${BASE_URL}/ideas/${ideaId}/receipts.html`);
    assert(htmlRes.status === 200, `GET /receipts.html returns 200 (got ${htmlRes.status})`);
    assert((htmlRes.headers.get('content-type') || '').includes('text/html'), 'receipts.html served as text/html');
    const html = await htmlRes.text();
    assert(html.includes('<!DOCTYPE html>') && html.includes('BURY'), 'HTML page renders the verdict');
    assert(html.includes('https://example.com/demand/supports/0'), 'HTML page links a source URL');

    // Unknown idea -> 404.
    const missing = await fetch(`${BASE_URL}/ideas/00000000-0000-0000-0000-000000000000/receipts`);
    assert(missing.status === 404, `receipts 404 for unknown idea (got ${missing.status})`);

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
