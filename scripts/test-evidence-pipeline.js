// Done-When demo for Step 3 (evidence pipeline).
// Step 3 Done-When criterion: submitting a real idea produces >=1 evidence
// row per dimension (or an explicit "insufficient signal" flag) in the
// `evidence` table, each with a working, non-null source_url.
//
// This hits the REAL Anthropic API (web_search + structured output), so it
// makes real network calls and can take up to ~45s per dimension.

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { getSupabase } = require('../lib/db');

// Note: server.js uses dotenv's { override: true }, which means .env's
// PORT=3000 wins over any PORT we pass through spawn's env — so we run on
// the .env default port instead of trying to override it.
const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;
const EXPECTED_DIMENSIONS = ['demand', 'market_gap', 'monetization', 'founder_fit', 'timing'];

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

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const serverProc = spawn('node', ['server.js'], {
    cwd: require('path').join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) }
  });

  let ideaId = null;

  try {
    await waitForServer(serverProc);
    const supabase = getSupabase();

    // Step A: submit a real idea via the API
    const payload = {
      problem: 'Small contractors lose 10+ hours a week reconciling paper change orders against invoices.',
      audience: 'Independent general contractors and small construction firms managing under 10 active job sites.',
      monetization_hypothesis: 'Flat monthly subscription per active job site, billed to the contractor.',
      unfair_advantage: 'Founder spent 6 years running back-office ops for a mid-size GC and has direct relationships with 40+ contractors.',
      clarifying_questions: []
    };

    const createRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const idea = await createRes.json();
    assert(createRes.status === 201, `idea creation returns 201 (got ${createRes.status})`);
    ideaId = idea.id;

    // Step B: trigger evidence gathering (real API calls, can take a while)
    console.log('Calling /ideas/:id/evidence — this makes real Claude + web_search calls and may take a few minutes (dimensions run in parallel, ~3 min each)...');
    const evidenceRes = await fetch(`${BASE_URL}/ideas/${ideaId}/evidence`, { method: 'POST' });
    const body = await evidenceRes.json();
    assert(evidenceRes.status === 200, `evidence endpoint returns 200 (got ${evidenceRes.status})`);

    // Step C: every dimension is accounted for, with either ok+claims or insufficient_signal
    assert(Array.isArray(body.dimensions) && body.dimensions.length === 5, `response reports exactly 5 dimensions (got ${body.dimensions && body.dimensions.length})`);

    const seenDimensions = new Set();
    for (const d of body.dimensions) {
      seenDimensions.add(d.dimension);
      const validStatus = d.status === 'ok' || d.status === 'insufficient_signal';
      assert(validStatus, `dimension "${d.dimension}" has a valid status (got "${d.status}")`);
      if (d.status === 'ok') {
        assert(d.claim_count >= 1, `dimension "${d.dimension}" status=ok has >=1 claim (got ${d.claim_count})`);
      }
    }
    for (const expected of EXPECTED_DIMENSIONS) {
      assert(seenDimensions.has(expected), `expected dimension "${expected}" is present in the response`);
    }

    // Step D: every persisted evidence row has a working, non-null source_url
    assert(Array.isArray(body.evidence), 'response includes an evidence array');
    const okDimensionCount = body.dimensions.filter((d) => d.status === 'ok').length;
    console.log(`${okDimensionCount}/5 dimensions returned validated evidence; ${5 - okDimensionCount} returned insufficient_signal.`);

    for (const row of body.evidence) {
      assert(!!row.source_url && isValidUrl(row.source_url), `evidence row (dimension=${row.dimension}) has a well-formed, non-null source_url (got "${row.source_url}")`);
      assert(row.idea_id === ideaId, `evidence row (dimension=${row.dimension}) is linked to the created idea via idea_id`);
    }

    // Step E: cross-check directly against Supabase (not just the API response)
    const { data: persistedRows, error: readErr } = await supabase
      .from('evidence')
      .select('*')
      .eq('idea_id', ideaId);

    assert(!readErr, 'querying evidence table directly succeeds');
    assert(persistedRows.length === body.evidence.length, `evidence rows persisted in Supabase (${persistedRows.length}) match rows returned by API (${body.evidence.length})`);

    const claimedOkClaimCount = body.dimensions.filter((d) => d.status === 'ok').reduce((sum, d) => sum + d.claim_count, 0);
    assert(persistedRows.length === claimedOkClaimCount, `persisted evidence row count (${persistedRows.length}) matches sum of claim_count for status=ok dimensions (${claimedOkClaimCount})`);

    // Step F: idea status was advanced
    const { data: finalIdea } = await supabase.from('ideas').select('status').eq('id', ideaId).single();
    assert(finalIdea.status === 'evidence_gathering', `idea status was updated to "evidence_gathering" (got "${finalIdea && finalIdea.status}")`);

  } finally {
    serverProc.kill();
    if (ideaId) {
      const supabase = getSupabase();
      await supabase.from('ideas').delete().eq('id', ideaId);
      console.log(`Cleaned up test idea ${ideaId} (evidence cascades).`);
    }
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
