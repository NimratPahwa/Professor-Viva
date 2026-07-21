// Hermetic test — proves the AbortController fix in lib/evidence-pipeline.js.
//
// ZERO live API calls: the Anthropic SDK is replaced in require.cache with a
// fake client BEFORE lib/evidence-pipeline.js (and lib/pipeline.js) are
// required, so `new Anthropic()` inside those modules returns our fake, which
// exposes a `.messages.stream()` that returns a controllable "hung" stream —
// its `finalMessage()` promise never resolves, simulating a request that is
// still generating past the timeout.
//
// What this proves, per the request:
//   1. When a dimension call exceeds DIMENSION_TIMEOUT_MS, stream.abort() is
//      actually invoked on that call's controller (not just abandoned via
//      Promise.race) — checked for all five evidence dimensions.
//   2. The same is true through the delta re-validation path
//      (lib/pipeline.js's runDeltaEvidenceStage), which calls the exact same
//      gatherDimensionEvidence() — confirming the fix is not duplicated
//      per-call-site but lives in the one function both paths share.
//   3. A timed-out/aborted call is metered as abortedUsageLine() — status
//      'aborted', tracked: false — never as a plain $0 usageLine() that would
//      be indistinguishable from a real free call.
//   4. summarizeUsage() surfaces aborted calls in the rolled-up totals
//      (aborted_calls, cost_understated) instead of silently absorbing them.
//
// DIMENSION_TIMEOUT_MS is set to 50ms via env var before requiring the
// pipeline modules, so this whole test runs in well under a second.

process.env.DIMENSION_TIMEOUT_MS = '50';
// Dummy so `new Anthropic()` (in the real SDK's constructor path, before we
// swap it) never gets a chance to complain — irrelevant once the fake is
// installed, but keeps this script runnable standalone without a real key.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-test-hermetic-not-real';

const sdkPath = require.resolve('@anthropic-ai/sdk');

// ---- Fake Anthropic SDK ----------------------------------------------
// Every `client.messages.stream(params)` call is recorded (so we can assert
// per-dimension), and returns a fake MessageStream whose `finalMessage()`
// never resolves (simulating a call still running past the timeout) and
// whose `abort()` flips a flag we can assert on — mirroring the real SDK's
// MessageStream#abort() semantics (lib/MessageStream.ts: abort() calls
// controller.abort() on the AbortController backing the underlying fetch).
const recordedCalls = [];

class FakeMessageStream {
  constructor(params) {
    this.params = params;
    this.aborted = false;
  }
  abort() {
    this.aborted = true;
  }
  finalMessage() {
    // Never resolves and never rejects on its own — only raceWithAbort()'s
    // timeout can move this forward, exactly like a real hung request.
    return new Promise(() => {});
  }
}

class FakeAnthropic {
  constructor() {
    this.messages = {
      stream: (params) => {
        const fakeStream = new FakeMessageStream(params);
        recordedCalls.push(fakeStream);
        return fakeStream;
      }
    };
  }
}

require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: FakeAnthropic
};

// zodOutputFormat is imported from '@anthropic-ai/sdk/helpers/zod' — a real
// subpath, safe to leave untouched (it's a pure schema-building helper, no
// network I/O).

const { gatherDimensionEvidence, DIMENSIONS } = require('../lib/evidence-pipeline');
const { runDeltaEvidenceStage } = require('../lib/pipeline');
const { summarizeUsage } = require('../lib/usage-meter');

let failures = 0;
function assert(condition, label) {
  const status = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`[${status}] ${label}`);
}

const IDEA = {
  id: 'test-idea-hermetic',
  audience: 'Small construction subcontractors and their back-office bookkeepers.',
  monetization_hypothesis: 'Flat monthly SaaS fee per company.'
};

async function main() {
  console.log('·· asserting abort() fires on timeout for all five evidence dimensions ··');
  const dimensionNames = Object.keys(DIMENSIONS);
  assert(dimensionNames.length === 5, `five dimensions defined (got ${dimensionNames.length})`);

  for (const dimension of dimensionNames) {
    const beforeCount = recordedCalls.length;
    const result = await gatherDimensionEvidence(dimension, IDEA);
    const call = recordedCalls[beforeCount];

    assert(!!call, `[${dimension}] stream() was called`);
    assert(call && call.aborted === true, `[${dimension}] stream.abort() was called on timeout`);
    assert(result.status === 'insufficient_signal', `[${dimension}] degrades to insufficient_signal, not fabricated claims`);
    assert(Array.isArray(result.claims) && result.claims.length === 0, `[${dimension}] claims array is empty`);
    assert(result.usage && result.usage.status === 'aborted', `[${dimension}] usage.status === 'aborted' (got '${result.usage && result.usage.status}')`);
    assert(result.usage && result.usage.tracked === false, `[${dimension}] usage.tracked === false`);
    assert(result.usage && typeof result.usage.note === 'string' && result.usage.note.includes('cost untracked'), `[${dimension}] usage.note says "cost untracked"`);
  }

  console.log('\n·· asserting the delta re-validation path shares the same fix ··');
  const beforeDeltaCount = recordedCalls.length;
  const delta = await runDeltaEvidenceStage(IDEA, ['demand']);
  const deltaCall = recordedCalls[beforeDeltaCount];

  assert(!!deltaCall, 'delta path: stream() was called via runDeltaEvidenceStage');
  assert(deltaCall && deltaCall.aborted === true, 'delta path: stream.abort() was called on timeout');
  assert(Array.isArray(delta.usage) && delta.usage.length === 1, 'delta path: returns one usage line for the one stale dimension');
  assert(delta.usage[0].status === 'aborted', `delta path: usage line status === 'aborted' (got '${delta.usage[0].status}')`);
  assert(delta.usage[0].tracked === false, 'delta path: usage line tracked === false');

  console.log('\n·· asserting summarizeUsage() surfaces aborted calls, never silently absorbs them ··');
  const summary = summarizeUsage(delta.usage);
  assert(summary.totals.aborted_calls === 1, `summarizeUsage: aborted_calls === 1 (got ${summary.totals.aborted_calls})`);
  assert(summary.totals.cost_understated === true, 'summarizeUsage: cost_understated === true');
  assert(summary.totals.total_cost === 0, 'summarizeUsage: total_cost is numerically 0 (honest lower bound, flagged as understated above)');

  console.log(`\nrecorded ${recordedCalls.length} fake stream() calls total, all aborted: ${recordedCalls.every((c) => c.aborted)}`);

  console.log(failures === 0 ? '\nAll checks passed. Zero live API calls made.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
