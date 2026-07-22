// Done-When demo for Step 2 (data layer).
// 1. Starts the real server and POSTs a valid intake payload to /ideas
//    (proves "an idea submitted via the API round-trips" into the ideas table).
// 2. Manually inserts a linked evidence row via the Supabase client
//    (proves the foreign key + retrieved_at work).
// 3. Reads both rows back and asserts the link holds.

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { getSupabase } = require('../lib/db');

// Note: server.js uses dotenv's { override: true }, which means .env's
// PORT=3000 wins over any PORT we pass through spawn's env — so we run on
// the .env default port instead of trying to override it (same workaround as
// test-evidence-pipeline.js).
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

function waitForServer(proc) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start in time')), 10000);
    proc.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('ready to judge')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
    proc.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Server exited early with code ${code}`));
    });
  });
}

let failures = 0;
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}

async function main() {
  const serverProc = spawn('node', ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) }
  });

  try {
    await waitForServer(serverProc);

    // Step A: submit an idea via the real API
    const payload = {
      problem: 'Small contractors lose 10+ hours a week reconciling paper change orders against invoices.',
      audience: 'Independent general contractors running 2-10 active residential jobs at a time.',
      monetization_hypothesis: 'Usage-based SaaS, $49/mo per active job site, billed monthly.',
      unfair_advantage: 'Ten years running field ops for a mid-size GC; personal relationships with 40+ contractors.',
      clarifying_questions: [
        { question: 'Who exactly wakes up angry about this problem?', answer: 'The GC, not their office admin.' }
      ]
    };

    const createRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const idea = await createRes.json();

    assert(createRes.status === 201, `POST /ideas -> 201 (got ${createRes.status})`);
    assert(!!idea.id, `POST /ideas -> response has an id (got ${idea.id})`);
    assert(idea.problem === payload.problem, 'POST /ideas -> persisted problem matches submitted payload');

    // Step B: confirm the row actually landed in Supabase (not just echoed back)
    const supabase = getSupabase();
    const { data: fetchedIdea, error: fetchIdeaErr } = await supabase
      .from('ideas')
      .select('*')
      .eq('id', idea.id)
      .single();

    assert(!fetchIdeaErr, `ideas table row exists for id ${idea.id}`);
    assert(fetchedIdea && fetchedIdea.audience === payload.audience, 'ideas row audience matches submitted payload');

    // Step C: manually insert a linked evidence row
    const { data: evidenceRow, error: evidenceErr } = await supabase
      .from('evidence')
      .insert({
        idea_id: idea.id,
        dimension: 'demand',
        claim: 'Reddit r/Construction has 30+ threads in the last 90 days complaining about change-order reconciliation.',
        source_url: 'https://reddit.com/r/Construction/example-thread'
      })
      .select()
      .single();

    assert(!evidenceErr, `evidence row insert succeeded (error: ${evidenceErr ? evidenceErr.message : 'none'})`);
    assert(evidenceRow && evidenceRow.idea_id === idea.id, 'evidence row idea_id matches the created idea (FK link)');
    assert(evidenceRow && !!evidenceRow.retrieved_at, `evidence row retrieved_at is populated (got ${evidenceRow && evidenceRow.retrieved_at})`);

    // Step D: read the evidence back via the FK to prove the link resolves both ways
    const { data: linkedEvidence, error: linkErr } = await supabase
      .from('evidence')
      .select('*')
      .eq('idea_id', idea.id);

    assert(!linkErr, 'querying evidence by idea_id succeeds');
    assert(linkedEvidence && linkedEvidence.length === 1, `exactly 1 evidence row found for idea ${idea.id} (got ${linkedEvidence && linkedEvidence.length})`);

    // Cleanup: remove the test rows (evidence cascades on idea delete)
    await supabase.from('ideas').delete().eq('id', idea.id);
    const { data: afterDelete } = await supabase.from('evidence').select('*').eq('idea_id', idea.id);
    assert(afterDelete && afterDelete.length === 0, 'deleting idea cascades to evidence (cleanup verified)');

  } finally {
    serverProc.kill();
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
