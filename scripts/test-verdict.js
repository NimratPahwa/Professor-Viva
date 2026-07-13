// Done-When demo for Step 5 (verdict thresholds).
//
// Step 5 Done-When: the verdict is PURE CODE and DETERMINISTIC — the
// rubric-weighted total maps to BUILD/PIVOT/BURY by hard-coded thresholds
// (03-AI Rules §3: >=75 BUILD, 50-74 PIVOT, <50 BURY), boundaries included,
// and the verdict persists to the `verdicts` table via POST /ideas/:id/verdict.
//
// Part A is hermetic (no DB/API): exact threshold boundaries.
// Part B exercises the real endpoint with synthetic evidence whose weighted
// total is known (49.5 -> BURY), and confirms persistence.

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { determineVerdict, THRESHOLD_VERSION } = require('../lib/verdict');
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

// Same fixture as the scoring test -> weighted total 49.5 -> BURY.
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
  console.log('--- Part A: threshold boundaries (no DB) ---');
  const cases = [
    [100, 'BUILD'],
    [75, 'BUILD'],     // >= 75 is BUILD (inclusive lower bound)
    [74.99, 'PIVOT'],  // just below 75
    [60, 'PIVOT'],
    [50, 'PIVOT'],     // >= 50 is PIVOT (inclusive lower bound)
    [49.99, 'BURY'],   // just below 50
    [49.5, 'BURY'],    // the fixture total
    [0, 'BURY']
  ];
  for (const [total, expected] of cases) {
    assert(determineVerdict(total) === expected, `total ${total} -> ${expected} (got ${determineVerdict(total)})`);
  }
  // Non-numeric input must throw, never silently return a verdict.
  let threw = false;
  try { determineVerdict(undefined); } catch { threw = true; }
  assert(threw, 'non-numeric total throws rather than guessing a verdict');
}

async function partB() {
  console.log('--- Part B: persistence through POST /ideas/:id/verdict ---');
  const serverProc = spawn('node', ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) }
  });

  const waitForServer = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    serverProc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('ready to judge')) { clearTimeout(timeout); resolve(); }
    });
    serverProc.stderr.on('data', (chunk) => process.stderr.write(chunk));
  });

  let ideaId = null;
  const supabase = getSupabase();

  try {
    await waitForServer();

    const createRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem: 'Placeholder problem for the verdict persistence test, long enough to pass validation.',
        audience: 'Small construction firms.',
        monetization_hypothesis: 'Flat monthly subscription per active job site.',
        unfair_advantage: 'Founder ran back-office ops for a mid-size GC for six years.'
      })
    });
    const idea = await createRes.json();
    ideaId = idea.id;
    assert(createRes.status === 201 && !!ideaId, 'test idea created');

    const evidenceRows = buildFixtureEvidence().map((r) => ({
      idea_id: ideaId, dimension: r.dimension, signal: r.signal, claim: r.claim, source_url: r.source_url
    }));
    const { error: evErr } = await supabase.from('evidence').insert(evidenceRows);
    assert(!evErr, `synthetic evidence inserted (error: ${evErr ? evErr.message : 'none'})`);

    const expectedTotal = computeScores(buildFixtureEvidence()).total; // 49.5
    const expectedVerdict = determineVerdict(expectedTotal);            // BURY
    assert(expectedTotal === 49.5 && expectedVerdict === 'BURY', `fixture resolves to total 49.5 / BURY (got ${expectedTotal} / ${expectedVerdict})`);

    const verdictRes = await fetch(`${BASE_URL}/ideas/${ideaId}/verdict`, { method: 'POST' });
    const body = await verdictRes.json();
    assert(verdictRes.status === 200, `verdict endpoint returns 200 (got ${verdictRes.status})`);
    assert(body.verdict === expectedVerdict, `endpoint verdict is ${expectedVerdict} (got ${body.verdict})`);
    assert(body.total_score === expectedTotal, `endpoint total_score is ${expectedTotal} (got ${body.total_score})`);
    assert(body.threshold_version === THRESHOLD_VERSION, `endpoint carries threshold_version ${THRESHOLD_VERSION} (got ${body.threshold_version})`);

    const { data: persisted, error: readErr } = await supabase.from('verdicts').select('*').eq('idea_id', ideaId);
    assert(!readErr, 'querying verdicts table succeeds');
    assert(persisted.length === 1, `exactly 1 verdict row persisted (got ${persisted.length})`);
    const v = persisted[0];
    assert(v.verdict === expectedVerdict, `persisted verdict is ${expectedVerdict} (got ${v.verdict})`);
    assert(Number(v.total_score) === expectedTotal, `persisted total_score is ${expectedTotal} (got ${v.total_score})`);
    assert(v.threshold_version === THRESHOLD_VERSION, `persisted threshold_version is ${THRESHOLD_VERSION} (got ${v.threshold_version})`);
    assert(v.voice_pass_output === null, 'voice_pass_output left null (Step 6 owns it)');
    assert(v.card_asset_url === null, 'card_asset_url left null (Step 9 owns it)');

    const { data: finalIdea } = await supabase.from('ideas').select('status').eq('id', ideaId).single();
    assert(finalIdea.status === 'verdict', `idea status advanced to 'verdict' (got ${finalIdea && finalIdea.status})`);

  } finally {
    serverProc.kill();
    if (ideaId) {
      await supabase.from('ideas').delete().eq('id', ideaId);
      console.log(`Cleaned up test idea ${ideaId} (evidence + scores + verdict cascade).`);
    }
  }
}

async function main() {
  partA();
  await partB();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
