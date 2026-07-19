// Hermetic Done-When for The Professor's Stage — Step 4 (card data, /sample
// report, checkbox persistence). NO live LLM call. Part A is pure; Part B hits
// the public /sample endpoint (no DB, no LLM).

require('dotenv').config({ override: true });
const assert = require('assert');
const Module = require('module');
const { spawn } = require('child_process');
const path = require('path');
const fetch = require('node-fetch');

const { buildCardData } = require('../lib/card-data');
const { assembleSixAnswers } = require('../lib/report-answers');
const { buildSampleReport } = require('../lib/sample-report');

const PORT = process.env.PORT || 3000;
let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const idea = { problem: 'A CRM for dog walkers', audience: 'dog walkers', unfair_advantage: 'I walked dogs for 8 years', created_at: '2026-07-13T09:00:00Z' };
const evidence = [
  { dimension: 'demand', signal: 'supports', claim: 'walkers ask for this', source_url: 'https://reddit.com/r/dogs',
    channel: { type: 'subreddit', name: 'r/dogs', url: 'https://reddit.com/r/dogs' } },
  { dimension: 'market_gap', signal: 'undermines', claim: 'Rover and Wag exist', source_url: 'https://rover.com' },
  { dimension: 'market_gap', signal: 'undermines', claim: 'Time To Pet exists', source_url: 'https://timetopet.com' },
  { dimension: 'monetization', signal: 'neutral', claim: 'comps charge $15/mo', source_url: 'https://timetopet.com/pricing' }
];
const scores = {
  total: 40,
  dimensions: {
    demand: { score: 72, status: 'ok', supports: 1, undermines: 0, neutral: 0 },
    market_gap: { score: 22, status: 'ok', supports: 0, undermines: 2, neutral: 0 },
    monetization: { score: 50, status: 'ok', supports: 0, undermines: 0, neutral: 1 },
    founder_fit: { score: 60, status: 'ok', supports: 0, undermines: 0, neutral: 0 },
    timing: { score: 45, status: 'insufficient', supports: 0, undermines: 0, neutral: 0 }
  }
};

check('BURY card renders the obituary format with real data', () => {
  const c = buildCardData({ idea, verdict: 'BURY', scores, evidence, elapsedMs: 3 * 3600 * 1000, verdictNumber: 'V1' });
  assert.strictEqual(c.format, 'obituary');
  assert.strictEqual(c.stamp, 'BURIED');
  assert.strictEqual(c.in_memory_of, idea.problem);
  assert.strictEqual(c.lifespan, '3 hours');
  assert(c.cause_of_death.includes('Rover') || c.cause_of_death.includes('Time To Pet'), 'cause = a real undermining claim');
  assert(c.survived_by.startsWith('2 identical apps'), 'survived_by = market_gap count');
  assert.strictEqual(c.letterhead.department, 'Department of Hard Truths');
});

check('PIVOT card renders driving-test with strongest/weakest real dimensions', () => {
  const c = buildCardData({ idea, verdict: 'PIVOT', scores, evidence, elapsedMs: 0, verdictNumber: 'V2' });
  assert.strictEqual(c.format, 'driving_test');
  assert.strictEqual(c.stamp, 'RETAKE');
  assert.strictEqual(c.accent, 'gold');
  assert.strictEqual(c.passed_skill.dimension, 'demand', 'strongest scored dim');
  assert.strictEqual(c.failed_skill.dimension, 'market_gap', 'weakest scored dim');
  assert(/1 free re-validation/.test(c.retake));
});

check('BUILD card renders certificate with "1 of N this month"', () => {
  const c = buildCardData({ idea, verdict: 'BUILD', scores, evidence, elapsedMs: 0, verdictNumber: 'V3', buildsThisMonth: 7 });
  assert.strictEqual(c.format, 'certificate');
  assert.strictEqual(c.stamp, 'APPROVED');
  assert.strictEqual(c.accent, 'green');
  assert.strictEqual(c.approved_line, 'Approved: 1 of 7 this month');
  assert.strictEqual(c.seal, true);
});

check('buildCardData rejects an unknown verdict', () => {
  assert.throws(() => buildCardData({ idea, verdict: 'MAYBE', scores, evidence }));
});

check('assembleSixAnswers produces 6 ordered answers grounded in real data', () => {
  const six = assembleSixAnswers({
    idea, evidence, competitive: { sections: [], total_claims: 0 },
    sixAnswers: { acquisition: 'go to r/dogs', first_revenue: 'sell a $15/mo tier' }
  });
  assert.strictEqual(six.length, 6);
  assert.deepStrictEqual(six.map((a) => a.n), [1, 2, 3, 4, 5, 6]);
  assert(six[0].claims.length >= 1, 'Answer 1 grounded in demand claims');
  assert(six[2].competitive, 'Answer 3 carries competitive assembly');
  assert.strictEqual(six[4].body, 'go to r/dogs', 'Answer 5 = acquisition');
  assert.strictEqual(six[5].body, 'sell a $15/mo tier', 'Answer 6 = first revenue');
});

check('assembleSixAnswers tolerates a not-yet-generated report (null sixAnswers)', () => {
  const six = assembleSixAnswers({ idea, evidence, competitive: {}, sixAnswers: null });
  assert.strictEqual(six[4].body, '');
  assert.strictEqual(six[5].body, '');
});

check('sample report is a complete six-answer report', () => {
  const s = buildSampleReport();
  assert.strictEqual(s.sample, true);
  assert.strictEqual(s.six_answers.length, 6);
  assert(s.card_data && s.card_data.format);
  assert(s.evidence_receipts.total_claims > 0);
  assert(s.evidence.some((e) => e.channel), 'sample carries channel data for exports');
});

// Checkbox repo — shim ./db, verify getChecks maps rows and setCheck upserts.
let capturedUpsert = null;
const fakeSupabase = {
  from() {
    return {
      select() { return { eq() { return { eq: async () => ({ data: [{ step_index: 0, checked: true }, { step_index: 2, checked: false }], error: null }) }; } }; },
      upsert(row, opts) { capturedUpsert = { row, opts }; return { select() { return { single: async () => ({ data: row, error: null }) }; } }; }
    };
  }
};
const originalLoad = Module._load;
Module._load = function (request, parent) {
  if (request === './db' && parent && parent.filename.includes('next-step-checks-repo')) {
    return { getSupabase: () => fakeSupabase };
  }
  return originalLoad.apply(this, arguments);
};
const { getChecks, setCheck } = require('../lib/next-step-checks-repo');
Module._load = originalLoad;

async function asyncCheck(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

// Part B — public /sample over HTTP (no DB, no LLM).
async function partB() {
  const serverProc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(PORT) } });
  const waitForServer = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    serverProc.stdout.on('data', (c) => { if (c.toString().includes('ready to judge')) { clearTimeout(timeout); resolve(); } });
    serverProc.stderr.on('data', (c) => process.stderr.write(c));
  });
  try {
    await waitForServer();
    const res = await fetch(`http://localhost:${PORT}/sample`);
    const body = await res.json();
    check('GET /sample returns 200 with a complete public report', () => {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(body.tier, 'sample');
      assert.strictEqual(body.six_answers.length, 6);
      assert(body.card_data.format);
      assert(body.evidence_receipts.dimensions.length === 5);
    });
  } finally {
    serverProc.kill();
  }
}

(async () => {
  await asyncCheck('getChecks returns a { step_index: checked } map', async () => {
    const map = await getChecks('acc', 'verdict');
    assert.deepStrictEqual(map, { 0: true, 2: false });
  });
  await asyncCheck('setCheck upserts on the composite key (idempotent)', async () => {
    await setCheck('acc', 'verdict', 1, true);
    assert(capturedUpsert, 'upsert called');
    assert.strictEqual(capturedUpsert.row.step_index, 1);
    assert.strictEqual(capturedUpsert.row.checked, true);
    assert.strictEqual(capturedUpsert.opts.onConflict, 'account_id,verdict_id,step_index');
  });

  await partB();

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
