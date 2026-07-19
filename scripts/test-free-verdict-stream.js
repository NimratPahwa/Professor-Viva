// Hermetic Done-When for The Professor's Stage — Step 3 (streamed free verdict,
// Screen 3 "the wait"). NO live LLM call: Part A tests the pure stream pieces;
// Part B hits the REAL endpoint in `?mock=1` mode, which streams the seeded
// sequence and touches neither the DB nor the API.

require('dotenv').config({ override: true });
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const fetch = require('node-fetch');

const { sseFrame, findingEvent, buildMockStreamSequence } = require('../lib/free-verdict-stream');

const PORT = process.env.PORT || 3000;
let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

// ── Part A — pure ────────────────────────────────────────────────────────────
check('sseFrame emits a well-formed named event frame', () => {
  const f = sseFrame('finding', { dimension: 'demand', claim_count: 2 });
  assert.strictEqual(f, 'event: finding\ndata: {"dimension":"demand","claim_count":2}\n\n');
});

check('findingEvent reports only real observed numbers + signal mix', () => {
  const ev = findingEvent(
    { dimension: 'market_gap', status: 'ok', claims: [{ signal: 'undermines' }, { signal: 'undermines' }, { signal: 'neutral' }], sources_examined: 5 },
    12
  );
  assert.strictEqual(ev.dimension, 'market_gap');
  assert.strictEqual(ev.claim_count, 3);
  assert.strictEqual(ev.sources_examined, 5);
  assert.strictEqual(ev.total_sources_examined, 12);
  assert.deepStrictEqual(ev.signal_mix, { supports: 0, undermines: 2, neutral: 1 });
});

check('mock sequence is 5 findings → progress → verdict, in order', () => {
  const seq = buildMockStreamSequence();
  const findings = seq.filter((e) => e.event === 'finding');
  assert.strictEqual(findings.length, 5, 'one finding per rubric dimension');
  assert.strictEqual(seq[5].event, 'progress');
  assert.strictEqual(seq[6].event, 'verdict');
  assert.strictEqual(seq[seq.length - 1].event, 'verdict');
});

check('mock counter ticks up monotonically and matches progress total', () => {
  const seq = buildMockStreamSequence();
  const findings = seq.filter((e) => e.event === 'finding');
  let prev = 0;
  for (const f of findings) {
    assert(f.data.total_sources_examined >= prev, 'counter must not go backwards');
    prev = f.data.total_sources_examined;
  }
  const progress = seq.find((e) => e.event === 'progress');
  assert.strictEqual(progress.data.sources_examined, prev, 'progress total == last finding total');
});

check('mock verdict carries the blocking-endpoint shape + locked sections in order', () => {
  const v = buildMockStreamSequence().find((e) => e.event === 'verdict').data;
  assert(['BUILD', 'PIVOT', 'BURY'].includes(v.verdict));
  assert.strictEqual(typeof v.total_score, 'number');
  assert(v.roast && v.roast.length > 0);
  assert.deepStrictEqual(v.locked_sections.map((s) => s.section), ['next_steps', 'competitive_analysis', 'evidence']);
  assert.strictEqual(v.mock, true);
});

// ── Part B — real endpoint, mock mode (no DB, no LLM) ────────────────────────
async function partB() {
  const serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) }
  });
  const waitForServer = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    serverProc.stdout.on('data', (c) => { if (c.toString().includes('ready to judge')) { clearTimeout(timeout); resolve(); } });
    serverProc.stderr.on('data', (c) => process.stderr.write(c));
  });

  try {
    await waitForServer();
    const res = await fetch(`http://localhost:${PORT}/ideas/any-id/free-verdict/stream?mock=1`);
    check('mock stream responds 200 text/event-stream', () => {
      assert.strictEqual(res.status, 200);
      assert(/text\/event-stream/.test(res.headers.get('content-type')));
    });
    const body = await res.text();
    check('mock stream body contains finding, progress, verdict, done frames', () => {
      assert((body.match(/event: finding/g) || []).length === 5, 'five finding frames');
      assert(/event: progress/.test(body));
      assert(/event: verdict/.test(body));
      assert(/event: done/.test(body));
    });
    check('mock stream verdict frame parses to the expected payload', () => {
      const line = body.split('\n').find((l) => l.startsWith('data: ') && l.includes('"verdict"') && l.includes('locked_sections'));
      assert(line, 'a verdict data line exists');
      const data = JSON.parse(line.slice('data: '.length));
      assert.strictEqual(data.tier, 'free');
      assert(['BUILD', 'PIVOT', 'BURY'].includes(data.verdict));
    });
  } finally {
    serverProc.kill();
  }
}

(async () => {
  await partB();
  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
