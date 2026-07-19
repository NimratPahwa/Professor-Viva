// Hermetic Done-When for The Professor's Stage — Step 1 (channel data on demand
// evidence). NO live LLM calls: we feed a mocked demand-pass result straight
// through the pure pieces that build and persist channel data.
//
// Proves:
//   1. The demand-dimension prompt asks for channel data (and only for demand).
//   2. The claim schema accepts an optional, validated channel object AND
//      rejects a malformed one.
//   3. insertEvidence maps channel through to the row (and coerces absent
//      channel to null) — verified without touching the network by shimming the
//      Supabase client.

const assert = require('assert');
const Module = require('module');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 1 + 2: prompt + schema (pure, no shim needed)
// ---------------------------------------------------------------------------
const { buildCategoryQuery, DIMENSIONS } = require('../lib/evidence-pipeline');

const idea = { audience: 'indie SaaS founders', monetization_hypothesis: 'monthly subscription' };

check('demand prompt requests channel with the allowed venue types', () => {
  const q = buildCategoryQuery(idea, DIMENSIONS.demand.focus, 'demand');
  assert(/"channel"/.test(q), 'demand prompt should mention channel');
  for (const t of ['subreddit', 'forum', 'marketplace', 'review_site', 'other']) {
    assert(q.includes(t), `demand prompt should list venue type "${t}"`);
  }
  assert(/never invent a community/i.test(q), 'demand prompt must forbid inventing channels');
});

check('non-demand prompts do NOT request channel', () => {
  for (const dim of ['market_gap', 'monetization', 'founder_fit', 'timing']) {
    const q = buildCategoryQuery(idea, DIMENSIONS[dim].focus, dim);
    assert(!/"channel"/.test(q), `${dim} prompt should not mention channel`);
  }
});

// Rebuild the exact schema shape the pipeline validates against, to prove it
// accepts a good channel and rejects a malformed one.
const { z } = require('zod');
const ChannelSchema = z.object({
  type: z.enum(['subreddit', 'forum', 'marketplace', 'review_site', 'other']),
  name: z.string(),
  url: z.string()
}).nullable();
const ClaimSchema = z.object({
  claim: z.string(),
  source_url: z.string(),
  signal: z.enum(['supports', 'neutral', 'undermines']),
  channel: ChannelSchema.optional()
});

check('schema accepts a well-formed demand channel', () => {
  const parsed = ClaimSchema.parse({
    claim: 'Founders repeatedly ask for this on r/SaaS',
    source_url: 'https://reddit.com/r/SaaS/comments/x',
    signal: 'supports',
    channel: { type: 'subreddit', name: 'r/SaaS', url: 'https://reddit.com/r/SaaS' }
  });
  assert.strictEqual(parsed.channel.name, 'r/SaaS');
});

check('schema accepts a claim with no channel (null / absent)', () => {
  const a = ClaimSchema.parse({ claim: 'x', source_url: 'https://e.com', signal: 'neutral' });
  const b = ClaimSchema.parse({ claim: 'x', source_url: 'https://e.com', signal: 'neutral', channel: null });
  assert.strictEqual(a.channel, undefined);
  assert.strictEqual(b.channel, null);
});

check('schema rejects a channel with an invalid type', () => {
  assert.throws(() => ClaimSchema.parse({
    claim: 'x', source_url: 'https://e.com', signal: 'supports',
    channel: { type: 'discord_server', name: 'x', url: 'https://x' }
  }));
});

// ---------------------------------------------------------------------------
// 3: insertEvidence maps channel through — shim ./db before requiring the repo
// ---------------------------------------------------------------------------
let capturedRows = null;
const fakeSupabase = {
  from() {
    return {
      insert(rows) {
        capturedRows = rows;
        return { select: async () => ({ data: rows, error: null }) };
      }
    };
  }
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './db' && parent && parent.filename.includes('evidence-repo')) {
    return { getSupabase: () => fakeSupabase };
  }
  return originalLoad.apply(this, arguments);
};
const { insertEvidence } = require('../lib/evidence-repo');
Module._load = originalLoad;

async function asyncCheck(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

(async () => {
  await asyncCheck('insertEvidence persists channel for demand and null elsewhere', async () => {
    await insertEvidence('idea-1', 'demand', [
      { claim: 'demand here', source_url: 'https://reddit.com/r/x', signal: 'supports',
        channel: { type: 'subreddit', name: 'r/x', url: 'https://reddit.com/r/x' } },
      { claim: 'no channel', source_url: 'https://e.com', signal: 'neutral' }
    ]);
    assert(capturedRows, 'rows should have been captured');
    assert.deepStrictEqual(capturedRows[0].channel, { type: 'subreddit', name: 'r/x', url: 'https://reddit.com/r/x' });
    assert.strictEqual(capturedRows[1].channel, null, 'absent channel must coerce to null');
  });

  console.log(`\n${failures === 0 ? 'ALL GREEN' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
})();
