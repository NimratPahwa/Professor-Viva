// Professor Viva — evidence pipeline (Step 3 of the gap-closure plan)
// Matches 02-professor-viva-architecture.md §3 stage 2 and §7.
//
// Design (see docs/05-professor-viva-evidence-pipeline.md for the full writeup):
// - One Claude call per dimension, in parallel, using the web_search tool +
//   structured JSON output in the same request.
// - Claude's claimed source_url values are NOT trusted as-is. Every claim is
//   cross-checked in code against the URLs actually present in that
//   response's web_search_tool_result blocks (the ground-truth retrieved
//   set). Any claim citing a URL outside that set is discarded — this is
//   the code-level enforcement of "unsourced claims discarded at this
//   boundary" (Architecture §3) and "no fabricated evidence" (AI Rules §4.1).
// - A dimension that times out or returns zero validated claims degrades to
//   "insufficient signal" — never fabricated filler (Architecture §3
//   failure modes).
// - Per Architecture §7, the idea text is never sent to the model verbatim
//   for search — only derived category/problem-space terms.

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { usageLine, abortedUsageLine } = require('./usage-meter');

const client = new Anthropic();

// Sonnet-class for evidence gathering (volume, cost) — Architecture §3, §5.
const EVIDENCE_MODEL = 'claude-sonnet-4-6';
// Interim beta budget. A thorough web_search-grounded call empirically takes
// ~3 min (measured: 181s for a single dimension returning 33 sourced claims),
// so the original 45s budget from Architecture §3 killed every dimension
// before it could finish. Bumped from 240s to 300s (2026-07-19 live run: an
// isolated probe of the same call shape was still mid-search past 215s under
// that day's API load, so 240s was cutting it too close). This synchronous
// approach is a beta-only interim; production must move evidence gathering to
// a persistent async job (see Architecture §3 "Production TODO").
// Env-overridable so the hermetic abort test (scripts/test-evidence-abort.js)
// can run against a millisecond-scale timeout instead of waiting 300s.
const DIMENSION_TIMEOUT_MS = Number(process.env.DIMENSION_TIMEOUT_MS) || 300_000;
// How many dimension calls run concurrently. 5 (all at once) was the original
// design, but on 2026-07-19 all 5 concurrent Sonnet+web_search calls timed out
// together — concurrent load plausibly compounds per-call latency. Capped to 2
// to reduce queueing pressure; env-overridable like DEEP_MAX_SEARCHES.
const EVIDENCE_CONCURRENCY = Number(process.env.EVIDENCE_CONCURRENCY) || 2;

// Cost control (deep-run cost optimization). An UNCAPPED web_search let a single
// dimension run 30+ searches, and every retrieved page is re-injected as input
// tokens on each turn of the tool loop — the dominant driver of the ~$5 deep
// run. `max_uses` is the ONLY documented lever over web_search content volume
// (there is no max_content_tokens / max_results parameter), and it reduces BOTH
// the per-search charge AND the accumulated input-token cost. Capping searches
// per dimension bounds the re-injected content indirectly. Env-overridable so
// the cap can be tuned without a code change; 6 keeps enough breadth for sourced
// claims on every dimension while cutting the long tail of redundant searches.
const DEEP_MAX_SEARCHES = Number(process.env.DEEP_MAX_SEARCHES) || 6;

const DIMENSIONS = {
  demand: {
    focus: 'Community demand signals: forum/Reddit posts describing this exact pain point, search trend trajectory, waitlist or pre-order comparables for similar tools.'
  },
  market_gap: {
    focus: 'Competitor count and identity in this category, pricing band gaps between existing competitors, room for differentiation.'
  },
  monetization: {
    focus: 'Pricing of comparable tools in this category, willingness-to-pay signals (reviews mentioning price complaints/praise), general unit economics sanity for this category.'
  },
  founder_fit: {
    focus: 'What background/expertise/network successful founders in this category typically had, so the founder\'s stated advantage can be compared against category requirements.'
  },
  timing: {
    focus: 'Trend direction for this category (growing/shrinking), platform or technology enablers that recently made this easier/harder, relevant regulatory shifts.'
  }
};

// `signal` is the polarity of the claim relative to THIS idea's viability on
// THIS dimension. The model only classifies evidence into these buckets — the
// numeric score is computed from them in pure code (lib/scoring.js), so
// "no LLM ever assigns a score" (CLAUDE.md) still holds.
// `channel` is optional and only meaningful for the demand dimension: it
// records WHERE the demand was observed (a subreddit, forum, marketplace,
// review site) so Answer 5 ("your first ten customers") can be grounded in a
// real acquisition channel instead of an invented one (03-AI Rules: no
// fabricated facts). Other dimensions omit it; nullable so a demand claim
// without an identifiable channel is still valid.
const ChannelSchema = z.object({
  type: z.enum(['subreddit', 'forum', 'marketplace', 'review_site', 'other']),
  name: z.string(),
  url: z.string()
}).nullable();

const ClaimsSchema = z.object({
  claims: z.array(z.object({
    claim: z.string(),
    source_url: z.string(),
    signal: z.enum(['supports', 'neutral', 'undermines']),
    channel: ChannelSchema.optional()
  }))
});

function buildCategoryQuery(idea, dimensionFocus, dimension) {
  // Derived category terms, not the idea verbatim (Architecture §7).
  const channelInstruction = dimension === 'demand'
    ? ` For each demand claim, ALSO fill "channel" with the specific place where you observed that demand — the actual community or venue, not a guess: ` +
      `{ "type": one of "subreddit" | "forum" | "marketplace" | "review_site" | "other", ` +
      `"name": its human name (e.g. "r/webdev", "Indie Hackers"), "url": its URL }. ` +
      `Only set "channel" when the source you cite genuinely IS such a venue; otherwise leave it null. Never invent a community.`
    : '';
  return `Category/problem space: ${idea.audience}. General monetization approach: ${idea.monetization_hypothesis}. ` +
    `Research focus for this dimension: ${dimensionFocus} ` +
    `Do not quote or closely paraphrase the founder's specific wording in any search query — search using general category and problem-space terms only. ` +
    `For every claim, also classify its "signal" — whether the sourced fact strengthens or weakens the case for building this specific idea on THIS dimension: ` +
    `"supports" = good news for the idea here (e.g. strong demand found, a real market gap, viable pricing, favorable timing); ` +
    `"undermines" = bad news for the idea here (e.g. no demand, a crowded/saturated market, weak unit economics, a declining trend); ` +
    `"neutral" = relevant and sourced but not directionally good or bad. ` +
    `Classify honestly against the evidence — do not inflate. A damning-but-true fact must be labeled "undermines".` +
    channelInstruction;
}

function extractGroundTruthUrls(contentBlocks) {
  const urls = new Set();
  for (const block of contentBlocks) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const item of block.content) {
        if (item && item.type === 'web_search_result' && typeof item.url === 'string') {
          urls.add(item.url);
        }
      }
    }
  }
  return urls;
}

// A sentinel error class so the catch block in gatherDimensionEvidence can
// tell "we gave up and cancelled the request" apart from any other failure
// (network error, API error, schema validation error, etc.) — only the
// former is metered as abortedUsageLine(); everything else genuinely did not
// spend anything and is metered as a normal zero-usage usageLine().
class DimensionTimeoutError extends Error {
  constructor() {
    super('dimension timed out');
    this.name = 'DimensionTimeoutError';
  }
}

// Races `stream.finalMessage()` against a timeout. Critically, on timeout
// this calls `stream.abort()` — which aborts the AbortController backing the
// underlying fetch (see @anthropic-ai/sdk MessageStream#abort) — so the
// actual HTTP request to Anthropic is cancelled, not just abandoned locally.
// A bare Promise.race() (the prior implementation) let the real request keep
// running server-side after our code moved on, silently generating (and
// billing) tokens no usage line ever accounted for.
function raceWithAbort(stream, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.abort();
      reject(new DimensionTimeoutError());
    }, ms);
    stream.finalMessage().then(
      (msg) => { clearTimeout(timer); resolve(msg); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function gatherDimensionEvidence(dimension, idea) {
  const focus = DIMENSIONS[dimension].focus;

  // Streaming (via .finalMessage()) rather than a single blocking request:
  // these calls run ~3 min, long enough to hit the SDK's default request
  // timeout. Streaming keeps the connection alive for the full duration.
  // parsed_output is still populated on the final message because
  // output_config.format is set. Keeping `stream` itself (not just the
  // finalMessage() promise) is what lets raceWithAbort() cancel it.
  const stream = client.messages.stream({
    model: EVIDENCE_MODEL,
    max_tokens: 4000,
    // max_uses caps searches per dimension — the sole documented lever over
    // web_search content volume, and the main deep-run cost control.
    // allowed_callers: ['direct'] disables dynamic filtering. On
    // web_search_20260209 and later, allowed_callers defaults to
    // ['code_execution_20260120'], which invisibly attaches a server-side
    // code_execution sandbox that Claude uses to post-process search results.
    // In this pipeline that loop ran unboundedly (measured: one dimension →
    // 49 code_execution rounds, 804K input tokens, 723s wall time before the
    // 300s abort even bit). We don't need dynamic filtering — validation
    // against ground-truth URLs happens in code (extractGroundTruthUrls),
    // and structured output already trims the response. Setting the caller
    // back to 'direct' restored per-dimension time to ~65s and input to ~72K.
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: DEEP_MAX_SEARCHES, allowed_callers: ['direct'] }],
    output_config: { format: zodOutputFormat(ClaimsSchema, 'claims') },
    messages: [{ role: 'user', content: buildCategoryQuery(idea, focus, dimension) }]
  });

  try {
    const response = await raceWithAbort(stream, DIMENSION_TIMEOUT_MS);

    // Meter the real token + web_search spend of this call (Step: cost tracking).
    const usage = usageLine(`evidence:${dimension}`, EVIDENCE_MODEL, response);

    if (!response.parsed_output) {
      return { dimension, status: 'insufficient_signal', claims: [], usage };
    }

    const groundTruthUrls = extractGroundTruthUrls(response.content);
    const validatedClaims = response.parsed_output.claims.filter(
      (c) => groundTruthUrls.has(c.source_url)
    );

    if (validatedClaims.length === 0) {
      return { dimension, status: 'insufficient_signal', claims: [], usage };
    }

    return { dimension, status: 'ok', claims: validatedClaims, usage };
  } catch (err) {
    console.error(`evidence gathering failed for dimension "${dimension}":`, err.message);

    if (err instanceof DimensionTimeoutError) {
      // The request was aborted mid-flight — we do NOT know its real cost,
      // so this is recorded as untracked, never as a numeric zero.
      return {
        dimension, status: 'insufficient_signal', claims: [],
        usage: abortedUsageLine(`evidence:${dimension}`, EVIDENCE_MODEL)
      };
    }

    // A genuine failure before any generation happened (e.g. a request
    // validation error) truthfully cost nothing — zero is accurate here.
    return {
      dimension, status: 'insufficient_signal', claims: [],
      usage: usageLine(`evidence:${dimension}`, EVIDENCE_MODEL, null)
    };
  }
}

// Runs all five dimension calls with concurrency capped at EVIDENCE_CONCURRENCY
// (batches, awaited in sequence) rather than all-at-once, to avoid compounding
// per-call latency under load.
async function gatherAllEvidence(idea) {
  const dimensionNames = Object.keys(DIMENSIONS);
  const results = [];
  for (let i = 0; i < dimensionNames.length; i += EVIDENCE_CONCURRENCY) {
    const batch = dimensionNames.slice(i, i + EVIDENCE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((dimension) => gatherDimensionEvidence(dimension, idea))
    );
    results.push(...batchResults);
  }
  return results;
}

module.exports = {
  gatherAllEvidence,
  gatherDimensionEvidence,
  buildCategoryQuery,
  extractGroundTruthUrls,
  DIMENSIONS,
  EVIDENCE_MODEL,
  DEEP_MAX_SEARCHES
};
