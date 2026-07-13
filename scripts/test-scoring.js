// Done-When demo for Step 4 (scoring engine).
//
// Step 4 Done-When: the scoring engine is PURE CODE and DETERMINISTIC — the
// same stored evidence always yields the same per-dimension scores and the
// same rubric-weighted total, with no LLM involved; and those scores persist
// to the `scores` table via POST /ideas/:id/score.
//
// Part A is hermetic (no DB, no API): it asserts exact scores for a known
// evidence set and proves determinism across repeated runs.
// Part B exercises the real endpoint: it inserts synthetic evidence rows with
// known signals, scores via the API, and confirms persistence matches.

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { computeScores, WEIGHTS } = require('../lib/scoring');
const { getSupabase } = require('../lib/db');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

let failures = 0;
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}

// A fixed evidence set with hand-computed expected scores.
//   demand:       4 supports, 1 undermines            -> 80
//   market_gap:   1 supports, 3 undermines            -> 30
//   monetization: 2 supports, 2 undermines, 1 neutral -> 50
//   founder_fit:  (no rows)                            -> 20 (insufficient)
//   timing:       3 neutral                            -> 50
// weighted total = 80*.30 + 30*.25 + 50*.20 + 20*.15 + 50*.10 = 49.5
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

const EXPECTED = {
  demand: 80,
  market_gap: 30,
  monetization: 50,
  founder_fit: 20,
  timing: 50,
  total: 49.5
};

function partA() {
  console.log('--- Part A: pure-function determinism & exact scores (no DB) ---');
  const evidence = buildFixtureEvidence();

  const r1 = computeScores(evidence);
  assert(r1.dimensions.demand.score === EXPECTED.demand, `demand scored ${EXPECTED.demand} (got ${r1.dimensions.demand.score})`);
  assert(r1.dimensions.market_gap.score === EXPECTED.market_gap, `market_gap scored ${EXPECTED.market_gap} (got ${r1.dimensions.market_gap.score})`);
  assert(r1.dimensions.monetization.score === EXPECTED.monetization, `monetization scored ${EXPECTED.monetization} (got ${r1.dimensions.monetization.score})`);
  assert(r1.dimensions.founder_fit.score === EXPECTED.founder_fit, `founder_fit (no evidence) scored ${EXPECTED.founder_fit} (got ${r1.dimensions.founder_fit.score})`);
  assert(r1.dimensions.founder_fit.status === 'insufficient_signal', `founder_fit disclosed as insufficient_signal (got ${r1.dimensions.founder_fit.status})`);
  assert(r1.dimensions.timing.score === EXPECTED.timing, `timing (neutral-only) scored ${EXPECTED.timing} (got ${r1.dimensions.timing.score})`);
  assert(r1.total === EXPECTED.total, `rubric-weighted total is ${EXPECTED.total} (got ${r1.total})`);

  // Determinism: same input, repeated, must be byte-identical.
  const r2 = computeScores(evidence);
  const r3 = computeScores(buildFixtureEvidence());
  assert(JSON.stringify(r1) === JSON.stringify(r2), 'identical input yields identical output (same array)');
  assert(JSON.stringify(r1) === JSON.stringify(r3), 'identical input yields identical output (rebuilt array)');

  // Weights sum to 1 (guards against a rubric typo skewing every verdict).
  const weightSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert(Math.abs(weightSum - 1) < 1e-9, `rubric weights sum to 1.0 (got ${weightSum})`);

  // Polarity extremes clamp correctly.
  const allSupport = computeScores([
    { dimension: 'demand', signal: 'supports' }, { dimension: 'demand', signal: 'supports' },
    { dimension: 'demand', signal: 'supports' }, { dimension: 'demand', signal: 'supports' },
    { dimension: 'demand', signal: 'supports' }
  ]);
  assert(allSupport.dimensions.demand.score === 100, `5 all-supporting claims max the dimension at 100 (got ${allSupport.dimensions.demand.score})`);
  const allUndermine = computeScores([
    { dimension: 'demand', signal: 'undermines' }, { dimension: 'demand', signal: 'undermines' },
    { dimension: 'demand', signal: 'undermines' }, { dimension: 'demand', signal: 'undermines' },
    { dimension: 'demand', signal: 'undermines' }
  ]);
  assert(allUndermine.dimensions.demand.score === 0, `5 all-undermining claims floor the dimension at 0 (got ${allUndermine.dimensions.demand.score})`);
}

async function partB() {
  console.log('--- Part B: persistence through POST /ideas/:id/score ---');
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

    // Create an idea straight through the API.
    const createRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem: 'Placeholder problem for the scoring persistence test, long enough to pass validation.',
        audience: 'Small construction firms.',
        monetization_hypothesis: 'Flat monthly subscription per active job site.',
        unfair_advantage: 'Founder ran back-office ops for a mid-size GC for six years.'
      })
    });
    const idea = await createRes.json();
    ideaId = idea.id;
    assert(createRes.status === 201 && !!ideaId, 'test idea created');

    // Insert the SAME fixture evidence (with signals) directly into Supabase.
    const evidenceRows = buildFixtureEvidence().map((r) => ({
      idea_id: ideaId, dimension: r.dimension, signal: r.signal, claim: r.claim, source_url: r.source_url
    }));
    const { error: evErr } = await supabase.from('evidence').insert(evidenceRows);
    assert(!evErr, `synthetic evidence inserted (error: ${evErr ? evErr.message : 'none'})`);

    // Score via the real endpoint.
    const scoreRes = await fetch(`${BASE_URL}/ideas/${ideaId}/score`, { method: 'POST' });
    const body = await scoreRes.json();
    assert(scoreRes.status === 200, `scoring endpoint returns 200 (got ${scoreRes.status})`);

    // Endpoint result must equal the pure-function result on the same evidence.
    const expected = computeScores(buildFixtureEvidence());
    assert(body.total_score === expected.total, `endpoint total_score matches pure engine (${expected.total}, got ${body.total_score})`);
    assert(body.total_score === EXPECTED.total, `endpoint total_score is the hand-computed ${EXPECTED.total} (got ${body.total_score})`);
    for (const dim of Object.keys(WEIGHTS)) {
      assert(body.dimensions[dim].score === expected.dimensions[dim].score, `endpoint ${dim} score matches engine (${expected.dimensions[dim].score}, got ${body.dimensions[dim].score})`);
    }

    // Scores persisted: exactly 5 rows, values matching.
    const { data: persisted, error: readErr } = await supabase.from('scores').select('*').eq('idea_id', ideaId);
    assert(!readErr, 'querying scores table succeeds');
    assert(persisted.length === 5, `exactly 5 per-dimension score rows persisted (got ${persisted.length})`);
    for (const row of persisted) {
      assert(Number(row.score) === expected.dimensions[row.dimension].score, `persisted ${row.dimension} score = ${expected.dimensions[row.dimension].score} (got ${row.score})`);
      assert(row.rubric_version === expected.rubric_version, `persisted ${row.dimension} carries rubric_version ${expected.rubric_version} (got ${row.rubric_version})`);
    }

    // Idea status advanced to 'scoring'.
    const { data: finalIdea } = await supabase.from('ideas').select('status').eq('id', ideaId).single();
    assert(finalIdea.status === 'scoring', `idea status advanced to 'scoring' (got ${finalIdea && finalIdea.status})`);

  } finally {
    serverProc.kill();
    if (ideaId) {
      await supabase.from('ideas').delete().eq('id', ideaId);
      console.log(`Cleaned up test idea ${ideaId} (evidence + scores cascade).`);
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
