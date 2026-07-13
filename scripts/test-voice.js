// Done-When demo for Step 6 (two-pass voice layer).
//
// Step 6 Done-When: the voice pass RENDERS the already-decided verdict in
// Viva's voice WITHOUT touching the score or the verdict (03-AI Rules §5
// two-pass rule). The sarcasm dial is injected in code per §2; the standing
// footer (§4.6) is appended in code; the voice prompt version is recorded on
// the verdict row (§5 versioning).
//
// Part A is hermetic (no DB/API): dial mapping, footer constant, and the
// prompt stack (evidence present, scores read-only, guardrails present).
// Part B exercises the real endpoint: it decides a verdict (Step 5), voices it
// (Step 6), and confirms the score/verdict were NOT altered, the footer is
// present, the prose is non-empty, and the prompt version persisted.

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const {
  buildSystemPrompt,
  SARCASM_DIAL,
  STANDING_FOOTER,
  VOICE_PROMPT_VERSION
} = require('../lib/viva-voice');
const { computeScores } = require('../lib/scoring');
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

// Same fixture as the scoring/verdict tests -> weighted total 49.5 -> BURY.
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
  console.log('--- Part A: dial, footer, prompt stack (no DB/API) ---');

  // §2 dial is injected in code, never the model's choice.
  assert(SARCASM_DIAL.BUILD === 8, 'BUILD dial is 8/10 (verdict delivery)');
  assert(SARCASM_DIAL.PIVOT === 8, 'PIVOT dial is 8/10 (verdict delivery)');
  assert(SARCASM_DIAL.BURY === 6, 'BURY dial is 6/10 (firm but never cruel)');

  // §4.6 standing footer is exact.
  assert(
    STANDING_FOOTER === "Viva's verdict is a data-backed opinion, not a prophecy. Founders have proven me wrong before. It's annoying every time.",
    'standing footer matches 03-AI Rules §4.6 verbatim'
  );

  const evidence = buildFixtureEvidence();
  const scores = computeScores(evidence);
  const system = buildSystemPrompt(SARCASM_DIAL.BURY, 'BURY', scores, evidence);

  // Evidence block carries the sourced facts the model may cite (pillar 2).
  assert(system.includes('demand-supports-0'), 'system prompt embeds an evidence claim');
  assert(system.includes('https://example.com/demand/supports/0'), 'system prompt embeds the claim source URL');
  assert(system.includes('[undermines]'), 'system prompt labels claim polarity/signal');

  // Two-pass rule + guardrails are present in the prompt stack.
  assert(/do not assign or change scores|not revisit it/i.test(system), 'prompt forbids the model from changing scores/verdict');
  assert(/No fabricated evidence/i.test(system), 'prompt carries the no-fabrication guardrail');
  assert(system.includes('6/10'), 'prompt injects the numeric dial for this verdict');
}

async function partB() {
  console.log('--- Part B: render voice through POST /ideas/:id/voice ---');
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
        problem: 'Placeholder problem for the voice-layer test, long enough to pass intake validation.',
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
    assert(expectedVerdict === 'BURY', `fixture resolves to BURY (got ${expectedVerdict})`);

    // Step 5: decide + persist the verdict (pure code).
    const verdictRes = await fetch(`${BASE_URL}/ideas/${ideaId}/verdict`, { method: 'POST' });
    const verdictBody = await verdictRes.json();
    assert(verdictRes.status === 200 && verdictBody.verdict === 'BURY', 'Step-5 verdict persisted as BURY');

    // Step 6: render voice. This must NOT change the score or the verdict.
    const voiceRes = await fetch(`${BASE_URL}/ideas/${ideaId}/voice`, { method: 'POST' });
    const voiceBody = await voiceRes.json();
    assert(voiceRes.status === 200, `voice endpoint returns 200 (got ${voiceRes.status})`);
    assert(voiceBody.sarcasm_dial === 6, `endpoint used BURY dial 6 (got ${voiceBody.sarcasm_dial})`);
    assert(voiceBody.voice_prompt_version === VOICE_PROMPT_VERSION, `endpoint reports prompt version ${VOICE_PROMPT_VERSION} (got ${voiceBody.voice_prompt_version})`);

    const voiceText = voiceBody.voice_pass_output || '';
    assert(voiceText.endsWith(STANDING_FOOTER), 'voice output ends with the code-appended standing footer');
    const prose = voiceText.slice(0, voiceText.length - STANDING_FOOTER.length).trim();
    assert(prose.length > 40, `voice output has non-empty prose before the footer (${prose.length} chars)`);

    // FR-1.4 / §3.1: exactly 3 concrete next steps, in Viva's voice at the same dial.
    assert(Array.isArray(voiceBody.next_steps) && voiceBody.next_steps.length === 3, `endpoint returns exactly 3 next steps (got ${voiceBody.next_steps && voiceBody.next_steps.length})`);
    assert(voiceBody.next_steps.every((s) => typeof s === 'string' && s.trim().length > 0), 'every next step is non-empty text');

    // Persistence + two-pass immutability: only voice fields changed.
    const { data: rows, error: readErr } = await supabase.from('verdicts').select('*').eq('idea_id', ideaId);
    assert(!readErr, 'querying verdicts table succeeds');
    assert(rows.length === 1, `exactly 1 verdict row (got ${rows.length})`);
    const v = rows[0];
    assert(v.verdict === 'BURY', `persisted verdict still BURY (got ${v.verdict})`);
    assert(Number(v.total_score) === expectedTotal, `persisted total_score unchanged at ${expectedTotal} (got ${v.total_score})`);
    assert(v.threshold_version === verdictBody.threshold_version, 'persisted threshold_version unchanged by the voice pass');
    assert(v.voice_pass_output === voiceText, 'voice_pass_output persisted on the verdict row');
    assert(v.voice_prompt_version === VOICE_PROMPT_VERSION, `persisted voice_prompt_version is ${VOICE_PROMPT_VERSION} (got ${v.voice_prompt_version})`);
    assert(v.card_asset_url === `/ideas/${ideaId}/card.svg`, `card_asset_url set by the delivery stage (Step 9) (got ${v.card_asset_url})`);
    assert(Array.isArray(v.next_steps) && v.next_steps.length === 3, `next_steps persisted as 3-item array on the verdict row (got ${v.next_steps && v.next_steps.length})`);

    console.log('\n--- Rendered Viva voice (BURY) ---\n' + voiceText + '\n----------------------------------');
    console.log('--- Next steps ---\n' + (voiceBody.next_steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n') + '\n------------------');

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
