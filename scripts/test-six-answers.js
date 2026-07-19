// Hermetic Done-When for The Professor's Stage — Step 2 (schema-enforced
// Answers 5 & 6). NO live LLM calls: the only generative call
// (renderReportActions) is exercised only through its PURE parts — prompt
// building (grounding) and parse/validate (schema enforcement) — plus the
// persistence mapping via a shimmed Supabase client.
//
// Proves:
//   1. The six-answers prompt GROUNDS Answer 5 in real demand channels and
//      Answer 6 in real pricing evidence (mocked evidence).
//   2. Empty channels / pricing degrade honestly (no invented facts).
//   3. The schema rejects an omitted/empty answer; parseSixAnswers throws.
//   4. A well-formed pair validates through.
//   5. updateVerdictVoice persists six_answers on the verdict row.

const assert = require('assert');
const Module = require('module');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

const {
  buildSixAnswersPrompt, parseSixAnswers, SixAnswersSchema, demandChannels
} = require('../lib/viva-voice');

// Mocked deep evidence: a demand row carrying a real channel + a monetization
// pricing row + unrelated rows.
const evidence = [
  { dimension: 'demand', signal: 'supports', claim: 'Founders keep asking for this',
    source_url: 'https://reddit.com/r/SaaS/c/1',
    channel: { type: 'subreddit', name: 'r/SaaS', url: 'https://reddit.com/r/SaaS' } },
  { dimension: 'demand', signal: 'supports', claim: 'Same ask, different thread',
    source_url: 'https://reddit.com/r/SaaS/c/2',
    channel: { type: 'subreddit', name: 'r/SaaS', url: 'https://reddit.com/r/SaaS' } },
  { dimension: 'monetization', signal: 'neutral',
    claim: 'Comparable tools charge $19–29/mo', source_url: 'https://competitor.com/pricing' },
  { dimension: 'market_gap', signal: 'undermines', claim: 'Crowded', source_url: 'https://x.com/a' }
];
const scores = {
  dimensions: {
    demand: { score: 70, status: 'ok', supports: 2, undermines: 0, neutral: 0 },
    market_gap: { score: 30, status: 'ok', supports: 0, undermines: 1, neutral: 0 },
    monetization: { score: 50, status: 'ok', supports: 0, undermines: 0, neutral: 1 },
    founder_fit: { score: 40, status: 'insufficient', supports: 0, undermines: 0, neutral: 0 },
    timing: { score: 50, status: 'insufficient', supports: 0, undermines: 0, neutral: 0 }
  },
  total: 52
};

check('demandChannels dedupes to the real channels only', () => {
  const chans = demandChannels(evidence);
  assert.strictEqual(chans.length, 1, 'r/SaaS appears twice, dedupes to 1');
  assert.strictEqual(chans[0].url, 'https://reddit.com/r/SaaS');
});

check('prompt grounds Answer 5 in the real demand channel', () => {
  const p = buildSixAnswersPrompt(8, 'PIVOT', scores, evidence);
  assert(p.includes('r/SaaS'), 'prompt must name the demand channel');
  assert(p.includes('https://reddit.com/r/SaaS'), 'prompt must carry the channel url');
  assert(/first ten customers/i.test(p), 'prompt frames Answer 5');
});

check('prompt grounds Answer 6 in the real pricing evidence', () => {
  const p = buildSixAnswersPrompt(8, 'PIVOT', scores, evidence);
  assert(p.includes('$19–29/mo'), 'prompt must carry the pricing comparable');
  assert(/first dollar/i.test(p), 'prompt frames Answer 6');
});

check('prompt degrades honestly when no channel/pricing surfaced', () => {
  const bare = [{ dimension: 'timing', signal: 'neutral', claim: 'meh', source_url: 'https://x.com' }];
  const p = buildSixAnswersPrompt(8, 'BURY', scores, bare);
  assert(/no specific channel surfaced/i.test(p), 'must state no channel honestly');
  assert(/no pricing comparable surfaced/i.test(p), 'must state no pricing honestly');
  assert(/do not invent/i.test(p), 'must forbid inventing');
});

check('schema rejects an omitted answer', () => {
  assert.throws(() => SixAnswersSchema.parse({ acquisition: 'go to r/SaaS' }));
});

check('schema rejects an empty answer', () => {
  assert.throws(() => SixAnswersSchema.parse({ acquisition: 'x', first_revenue: '' }));
});

check('parseSixAnswers throws on an empty model response', () => {
  assert.throws(() => parseSixAnswers({ parsed_output: { acquisition: '  ', first_revenue: '' } }));
});

check('parseSixAnswers returns a well-formed, trimmed pair', () => {
  const r = parseSixAnswers({ parsed_output: {
    acquisition: '  Post a build-log in r/SaaS this week.  ',
    first_revenue: 'Offer a $19/mo founding tier to the first ten.'
  } });
  assert.strictEqual(r.acquisition, 'Post a build-log in r/SaaS this week.');
  assert(r.first_revenue.includes('$19/mo'));
});

// Persistence mapping — shim ./db before requiring the repo.
let captured = null;
const fakeSupabase = {
  from() {
    return {
      update(u) { captured = u; return { eq() { return { select() { return { single: async () => ({ data: u, error: null }) }; } }; } }; }
    };
  }
};
const originalLoad = Module._load;
Module._load = function (request, parent) {
  if (request === './db' && parent && parent.filename.includes('verdicts-repo')) {
    return { getSupabase: () => fakeSupabase };
  }
  return originalLoad.apply(this, arguments);
};
const { updateVerdictVoice } = require('../lib/verdicts-repo');
Module._load = originalLoad;

async function asyncCheck(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); }
  catch (err) { failures++; console.log(`  FAIL  ${name}\n        ${err.message}`); }
}

(async () => {
  await asyncCheck('updateVerdictVoice persists six_answers on the verdict row', async () => {
    await updateVerdictVoice('verdict-1', {
      voicePassOutput: 'the verdict prose',
      voicePromptVersion: 'voice-1.0.0',
      nextSteps: ['a', 'b', 'c'],
      sixAnswers: { acquisition: 'r/SaaS build-log', first_revenue: '$19/mo tier' }
    });
    assert(captured, 'update should have been captured');
    assert.deepStrictEqual(captured.six_answers, { acquisition: 'r/SaaS build-log', first_revenue: '$19/mo tier' });
  });

  await asyncCheck('updateVerdictVoice omits six_answers when not provided (free verdict path)', async () => {
    captured = null;
    await updateVerdictVoice('verdict-2', {
      voicePassOutput: 'x', voicePromptVersion: 'voice-1.0.0', nextSteps: ['a', 'b', 'c']
    });
    assert(!('six_answers' in captured), 'six_answers must be absent when undefined');
  });

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
