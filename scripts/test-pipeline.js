// Done-When demo for Step 8 (resumable state machine).
//
// Step 8 Done-When: the Layer-1 validation pipeline is a deterministic
// five-stage machine where each stage persists before the next begins, so a
// crashed/interrupted run RESUMES from the cursor rather than restarting
// (Architecture §3). `ideas.status` is the cursor.
//
// Part A is hermetic (no DB/API): the pure resume planner for every cursor
// value — proves which stages are skipped vs. run from each resume point.
// Part B exercises the REAL runner: it seeds evidence and sets the cursor to
// simulate a crash right after the evidence stage, then runs the pipeline and
// confirms it resumed at scoring (skipping evidence), ran scoring→verdict→
// delivery, reached 'complete', and that a second run is an idempotent no-op.

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const { planResume, STAGES } = require('../lib/pipeline');
const { STANDING_FOOTER } = require('../lib/viva-voice');
const { getSupabase } = require('../lib/db');

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

let failures = 0;
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function partA() {
  console.log('--- Part A: pure resume planner (no DB/API) ---');

  assert(eq(STAGES.map((s) => s.name), ['evidence', 'scoring', 'verdict', 'delivery']), 'stage order is evidence -> scoring -> verdict -> delivery');

  const fromIntake = planResume('intake');
  assert(fromIntake.completedStages === 0 && eq(fromIntake.toRun, ['evidence', 'scoring', 'verdict', 'delivery']) && eq(fromIntake.toSkip, []), 'from intake: run all four stages, skip none');

  const fromEvidence = planResume('evidence_gathering');
  assert(fromEvidence.completedStages === 1 && eq(fromEvidence.toSkip, ['evidence']) && eq(fromEvidence.toRun, ['scoring', 'verdict', 'delivery']), 'from evidence_gathering: skip evidence, run scoring onward');

  const fromScoring = planResume('scoring');
  assert(eq(fromScoring.toSkip, ['evidence', 'scoring']) && eq(fromScoring.toRun, ['verdict', 'delivery']), 'from scoring: skip evidence+scoring, run verdict+delivery');

  const fromVerdict = planResume('verdict');
  assert(eq(fromVerdict.toSkip, ['evidence', 'scoring', 'verdict']) && eq(fromVerdict.toRun, ['delivery']), 'from verdict: only delivery remains');

  const fromComplete = planResume('complete');
  assert(fromComplete.completedStages === 4 && eq(fromComplete.toRun, []), 'from complete: nothing to run (idempotent no-op)');

  let threw = false;
  try { planResume('bogus'); } catch { threw = true; }
  assert(threw, 'unknown status throws rather than guessing a resume point');
}

async function partB() {
  console.log('--- Part B: real resume-from-crash through POST /ideas/:id/run ---');
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

  // Fixture evidence -> total 49.5 -> BURY.
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
        problem: 'Placeholder problem for the pipeline resume test, long enough to pass intake validation.',
        audience: 'Small construction firms.',
        monetization_hypothesis: 'Flat monthly subscription per active job site.',
        unfair_advantage: 'Founder ran back-office ops for a mid-size GC for six years.'
      })
    });
    const idea = await createRes.json();
    ideaId = idea.id;
    assert(createRes.status === 201 && !!ideaId, 'test idea created (status intake)');

    // Simulate a crash RIGHT AFTER the evidence stage: evidence rows are
    // persisted and the cursor has advanced to 'evidence_gathering', but no
    // later stage has run. This is exactly the state a resume must recover from
    // WITHOUT re-running the expensive (real) evidence gathering.
    const rows = fixture.map((r) => ({ idea_id: ideaId, dimension: r.dimension, signal: r.signal, claim: r.claim, source_url: r.source_url }));
    const { error: evErr } = await supabase.from('evidence').insert(rows);
    assert(!evErr, `evidence seeded (error: ${evErr ? evErr.message : 'none'})`);
    await supabase.from('ideas').update({ status: 'evidence_gathering' }).eq('id', ideaId);

    // Resume.
    const runRes = await fetch(`${BASE_URL}/ideas/${ideaId}/run`, { method: 'POST' });
    const runBody = await runRes.json();
    assert(runRes.status === 200, `run endpoint returns 200 (got ${runRes.status})`);
    assert(runBody.resumed_from === 'evidence_gathering', `resumed from the evidence_gathering cursor (got ${runBody.resumed_from})`);

    const byName = Object.fromEntries((runBody.trace || []).map((t) => [t.stage, t]));
    assert(byName.evidence && byName.evidence.ran === false, 'evidence stage was SKIPPED (not re-run) on resume');
    assert(byName.scoring && byName.scoring.ran === true, 'scoring stage ran on resume');
    assert(byName.verdict && byName.verdict.ran === true, 'verdict stage ran on resume');
    assert(byName.delivery && byName.delivery.ran === true, 'delivery stage ran on resume');
    assert(runBody.status === 'complete', `cursor advanced to 'complete' (got ${runBody.status})`);

    // Each stage persisted its output.
    const { data: scoreRows } = await supabase.from('scores').select('*').eq('idea_id', ideaId);
    assert(scoreRows.length === 5, `5 score rows persisted (got ${scoreRows.length})`);
    const { data: verdictRows } = await supabase.from('verdicts').select('*').eq('idea_id', ideaId);
    assert(verdictRows.length === 1, `1 verdict row persisted (got ${verdictRows.length})`);
    const v = verdictRows[0];
    assert(v.verdict === 'BURY' && Number(v.total_score) === 49.5, `verdict BURY @ 49.5 (got ${v.verdict} @ ${v.total_score})`);
    assert(typeof v.voice_pass_output === 'string' && v.voice_pass_output.endsWith(STANDING_FOOTER), 'delivery persisted voice output ending with the footer');

    // Idempotent resume: running an already-'complete' idea does nothing and
    // creates no duplicate rows.
    const rerunRes = await fetch(`${BASE_URL}/ideas/${ideaId}/run`, { method: 'POST' });
    const rerunBody = await rerunRes.json();
    assert(rerunBody.resumed_from === 'complete' && rerunBody.trace.every((t) => t.ran === false), 'second run on a complete idea is a no-op (all stages skipped)');
    const { data: scoreRows2 } = await supabase.from('scores').select('*').eq('idea_id', ideaId);
    const { data: verdictRows2 } = await supabase.from('verdicts').select('*').eq('idea_id', ideaId);
    assert(scoreRows2.length === 5 && verdictRows2.length === 1, 'no duplicate rows created by the idempotent re-run');

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
