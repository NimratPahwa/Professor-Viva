// Done-When demo for Step 7 (server-side guardrail filter).
//
// Step 7 Done-When: guardrails 1–3 (03-AI Rules §4) are enforced by a
// rule-based server-side filter BEFORE any reply renders, and a filtered reply
// regenerates at dial 0.
//   G1 no fabricated evidence — a cited source not in the evidence store is
//      caught. G2 no personal attacks — punching down at the founder is caught
//      while idea-roasts pass. G3 no sarcasm on sensitive input — founder
//      distress forces the dial to 0.
//
// Part A is hermetic (no DB/API): the pure filter functions + the
// render-with-guardrails control flow, using an injected fake renderer so the
// regeneration path is proven deterministically.
// Part B exercises the real endpoint: a sensitive-disclosure idea is voiced
// through POST /ideas/:id/voice and must come back at dial 0 (G3 end-to-end).

require('dotenv').config({ override: true });
const { spawn } = require('child_process');
const fetch = require('node-fetch');
const {
  detectSensitiveInput,
  screenReply,
  renderWithGuardrails
} = require('../lib/guardrail-filter');
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

const EVIDENCE = [
  { dimension: 'demand', signal: 'undermines', claim: 'x', source_url: 'https://example.com/a' },
  { dimension: 'market_gap', signal: 'undermines', claim: 'y', source_url: 'https://example.com/b' }
];

async function partA() {
  console.log('--- Part A: pure filter logic + control flow (no DB/API) ---');

  // G3 — sensitive-disclosure detection on the founder's intake.
  assert(detectSensitiveInput({ problem: 'I just got laid off and need income fast.' }) === true, 'G3 detects job loss');
  assert(detectSensitiveInput({ problem: 'This is my last savings and I am desperate.' }) === true, 'G3 detects financial desperation');
  assert(detectSensitiveInput({ unfair_advantage: 'I was recently diagnosed with cancer.' }) === true, 'G3 detects health distress');
  assert(detectSensitiveInput({
    problem: 'Small builders waste hours reconciling invoices.',
    audience: 'Construction firms.', monetization_hypothesis: 'SaaS subscription.', unfair_advantage: 'Ten years in AEC ops.'
  }) === false, 'G3 does NOT trip on an ordinary idea');

  // G1 — a cited source not in the evidence store is a violation.
  const cleanNoUrl = screenReply('This idea has been built 47 times. The market is saturated.', EVIDENCE);
  assert(cleanNoUrl.ok, 'G1/G2 pass a clean idea-roast with no citations');

  const inEvidence = screenReply('Demand is thin (source: https://example.com/a).', EVIDENCE);
  assert(inEvidence.ok, 'G1 passes a reply citing an in-evidence source');

  const fabricated = screenReply('Trust me, see https://totally-made-up.example.org/proof for the numbers.', EVIDENCE);
  assert(!fabricated.ok && fabricated.violations.some((v) => v.guardrail === 'no_fabricated_evidence'), 'G1 flags a fabricated (non-evidence) source URL');

  // G2 — punch-down at the founder is caught; roasting the idea is not.
  const attack = screenReply("Honestly, you're an idiot for thinking this would work.", EVIDENCE);
  assert(!attack.ok && attack.violations.some((v) => v.guardrail === 'no_personal_attacks'), 'G2 flags a personal attack on the founder');

  const attack2 = screenReply('Your English is the least of your problems here.', EVIDENCE);
  assert(!attack2.ok && attack2.violations.some((v) => v.guardrail === 'no_personal_attacks'), 'G2 flags punching down at the founder\'s attributes');

  const ideaRoast = screenReply("Your idea has been built 47 times and your market doesn't want it. That's the idea's problem, not yours.", EVIDENCE);
  assert(ideaRoast.ok, 'G2 does NOT trip on a hard idea-roast ("your idea", "your market")');

  // Control flow — sensitive input forces the FIRST render to dial 0.
  const dialsSeen = [];
  const flow1 = await renderWithGuardrails({
    idea: { problem: 'I lost my job and this is my last shot.' },
    evidence: EVIDENCE,
    baseDial: 6,
    render: async (dial) => { dialsSeen.push(dial); return `A calm, plain reply.\n\n${STANDING_FOOTER}`; }
  });
  assert(flow1.sensitiveInput === true && dialsSeen[0] === 0, 'sensitive input forces the first render to dial 0');
  assert(flow1.regenerated === false, 'no regeneration needed when the dial-0 reply is clean');

  // Control flow — a clean, non-sensitive reply renders once at the base dial.
  const dialsSeen2 = [];
  const flow2 = await renderWithGuardrails({
    idea: { problem: 'Ordinary idea about invoice reconciliation.' },
    evidence: EVIDENCE,
    baseDial: 6,
    render: async (dial) => { dialsSeen2.push(dial); return 'This idea has been built 47 times.'; }
  });
  assert(flow2.sensitiveInput === false && flow2.dialUsed === 6 && flow2.regenerated === false && dialsSeen2.length === 1, 'clean non-sensitive reply renders once at the base dial');

  // Control flow — a first reply that violates regenerates ONCE at dial 0.
  const dialsSeen3 = [];
  const flow3 = await renderWithGuardrails({
    idea: { problem: 'Ordinary idea about invoice reconciliation.' },
    evidence: EVIDENCE,
    baseDial: 8,
    // First render (dial 8) punches down; second render (dial 0) is clean.
    render: async (dial) => { dialsSeen3.push(dial); return dial === 0 ? 'Plain, respectful analysis.' : "you're an idiot"; }
  });
  assert(flow3.regenerated === true && flow3.dialUsed === 0, 'a filtered reply regenerates once at dial 0');
  assert(dialsSeen3[0] === 8 && dialsSeen3[1] === 0 && dialsSeen3.length === 2, 'regeneration path renders exactly twice: base dial then 0');
  assert(flow3.residualViolations.length === 0, 'no residual violations after the dial-0 regeneration');
}

async function partB() {
  console.log('--- Part B: G3 through POST /ideas/:id/voice (sensitive input -> dial 0) ---');
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

  // Fixture evidence -> total 49.5 -> BURY (base dial would be 6).
  const fixture = [];
  const add = (dimension, signal, count) => { for (let i = 0; i < count; i++) fixture.push({ dimension, signal, claim: `${dimension}-${signal}-${i}`, source_url: `https://example.com/${dimension}/${signal}/${i}` }); };
  add('demand', 'supports', 4); add('demand', 'undermines', 1);
  add('market_gap', 'supports', 1); add('market_gap', 'undermines', 3);
  add('monetization', 'supports', 2); add('monetization', 'undermines', 2); add('monetization', 'neutral', 1);
  add('timing', 'neutral', 3);

  try {
    await waitForServer();

    // Idea whose intake discloses distress -> G3 must force dial 0.
    const createRes = await fetch(`${BASE_URL}/ideas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        problem: 'I was just laid off and this app is my last shot at income before I lose my apartment.',
        audience: 'Freelance tradespeople.',
        monetization_hypothesis: 'Small monthly subscription.',
        unfair_advantage: 'I spent years doing this work myself.'
      })
    });
    const idea = await createRes.json();
    ideaId = idea.id;
    assert(createRes.status === 201 && !!ideaId, 'sensitive-disclosure idea created');

    const rows = fixture.map((r) => ({ idea_id: ideaId, dimension: r.dimension, signal: r.signal, claim: r.claim, source_url: r.source_url }));
    const { error: evErr } = await supabase.from('evidence').insert(rows);
    assert(!evErr, `synthetic evidence inserted (error: ${evErr ? evErr.message : 'none'})`);

    const verdictRes = await fetch(`${BASE_URL}/ideas/${ideaId}/verdict`, { method: 'POST' });
    const verdictBody = await verdictRes.json();
    assert(verdictRes.status === 200 && verdictBody.verdict === 'BURY', 'Step-5 verdict persisted as BURY (base dial would be 6)');

    const voiceRes = await fetch(`${BASE_URL}/ideas/${ideaId}/voice`, { method: 'POST' });
    const voiceBody = await voiceRes.json();
    assert(voiceRes.status === 200, `voice endpoint returns 200 (got ${voiceRes.status})`);
    assert(voiceBody.sensitive_input === true, 'endpoint flagged sensitive input (G3)');
    assert(voiceBody.sarcasm_dial === 0, `G3 forced the dial to 0 despite BURY default 6 (got ${voiceBody.sarcasm_dial})`);

    const voiceText = voiceBody.voice_pass_output || '';
    assert(voiceText.endsWith(STANDING_FOOTER), 'voice output still ends with the standing footer');
    const prose = voiceText.slice(0, voiceText.length - STANDING_FOOTER.length).trim();
    assert(prose.length > 40, `voice output has non-empty prose (${prose.length} chars)`);
    // The rendered reply must itself survive the output screen.
    assert(screenReply(voiceText, rows).ok, 'rendered dial-0 reply passes G1+G2 output screening');

    console.log('\n--- Rendered Viva voice (sensitive input, dial 0) ---\n' + voiceText + '\n-----------------------------------------------------');

  } finally {
    serverProc.kill();
    if (ideaId) {
      await supabase.from('ideas').delete().eq('id', ideaId);
      console.log(`Cleaned up test idea ${ideaId} (evidence + verdict cascade).`);
    }
  }
}

async function main() {
  await partA();
  await partB();
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
