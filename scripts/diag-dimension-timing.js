// Diagnostic ONLY — instruments a SINGLE live dimension call, replicating
// lib/evidence-pipeline.js's gatherDimensionEvidence() call shape exactly
// (same model, same tools/max_uses, same output_config), but listens to the
// raw SSE stream to report where the ~300s goes:
//   - time to first search round starting
//   - time per search round (server_tool_use -> its web_search_tool_result)
//   - number of search rounds actually used
//   - time spent in structured-output generation (after the last search
//     result, until the stream closes)
//
// Run ONE dimension only, to spend minimally:
//   node scripts/diag-dimension-timing.js demand
//
// Makes exactly one real API call. No DB writes, no server needed.

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod');
const { DIMENSIONS, buildCategoryQuery, DEEP_MAX_SEARCHES } = require('../lib/evidence-pipeline');

const dimension = process.argv[2] || 'demand';
if (!DIMENSIONS[dimension]) {
  console.error(`Unknown dimension "${dimension}". Choices: ${Object.keys(DIMENSIONS).join(', ')}`);
  process.exit(1);
}

// Same VerifyPoint idea used for the earlier client-call live run, so this
// diagnosis reflects a realistic real-world call shape.
const idea = {
  problem: 'VerifyPoint is an Ontario-focused property due diligence and development feasibility platform built for brokers and developers to instantly assess site viability before committing capital.',
  audience: 'Commercial and land realtors, developers, investors, landowners, lenders, and brokerages evaluating development or redevelopment opportunities in Ontario.',
  monetization_hypothesis: 'Mix of pay-per-report and subscription. Basic property screening $199 to $299 per report, detailed feasibility and highest-and-best-use reports priced higher, enterprise and brokerage plans on subscription.',
  unfair_advantage: '13-plus years working on Ontario land, development, zoning, feasibility, and transactions.'
};

const ClaimsSchema = z.object({
  claims: z.array(z.object({
    claim: z.string(),
    source_url: z.string(),
    signal: z.enum(['supports', 'neutral', 'undermines']),
    channel: z.object({
      type: z.enum(['subreddit', 'forum', 'marketplace', 'review_site', 'other']),
      name: z.string(),
      url: z.string()
    }).nullable().optional()
  }))
});

const client = new Anthropic();
const focus = DIMENSIONS[dimension].focus;
const query = buildCategoryQuery(idea, focus, dimension);

const t0 = Date.now();
const rel = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

const log = [];
function record(kind, extra) {
  const entry = { t: Date.now() - t0, kind, ...extra };
  log.push(entry);
  console.log(`[${rel()}] ${kind}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

console.log(`Dimension: ${dimension}`);
console.log(`Model: claude-sonnet-4-6, max_uses: ${DEEP_MAX_SEARCHES}`);
console.log('---');

const stream = client.messages.stream({
  model: 'claude-sonnet-4-6',
  max_tokens: 4000,
  tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: DEEP_MAX_SEARCHES, allowed_callers: ['direct'] }],
  output_config: { format: zodOutputFormat(ClaimsSchema, 'claims') },
  messages: [{ role: 'user', content: query }]
});

let searchRoundStartT = null;
let searchRoundCount = 0;
let lastSearchResultT = null;
let sawTextOrToolAfterSearch = false;

stream.on('streamEvent', (event) => {
  if (event.type === 'content_block_start') {
    const block = event.content_block;
    if (block && block.type === 'server_tool_use' && block.name === 'web_search') {
      searchRoundCount++;
      searchRoundStartT = Date.now();
      record('search_round_start', { round: searchRoundCount });
    } else if (block && block.type === 'text') {
      record('text_block_start');
    } else if (block) {
      record('content_block_start', { blockType: block.type });
    }
  } else if (event.type === 'content_block_stop') {
    // We don't get the resolved block type here directly; rely on message snapshot via 'contentBlock'.
  } else if (event.type === 'message_delta') {
    if (event.delta && event.delta.stop_reason) {
      record('message_delta_stop_reason', { stop_reason: event.delta.stop_reason });
    }
  }
});

stream.on('contentBlock', (block) => {
  if (block.type === 'web_search_tool_result') {
    const roundMs = searchRoundStartT ? Date.now() - searchRoundStartT : null;
    lastSearchResultT = Date.now();
    const resultCount = Array.isArray(block.content) ? block.content.length : 0;
    record('search_round_done', { round: searchRoundCount, round_ms: roundMs, results: resultCount });
  }
});

(async () => {
  try {
    const message = await stream.finalMessage();
    const totalMs = Date.now() - t0;
    const structuredOutputMs = lastSearchResultT ? (Date.now() - lastSearchResultT) : null;

    console.log('---');
    console.log(`TOTAL: ${(totalMs / 1000).toFixed(1)}s`);
    console.log(`Search rounds used: ${searchRoundCount} (cap was ${DEEP_MAX_SEARCHES})`);
    const searchDoneEvents = log.filter((e) => e.kind === 'search_round_done');
    for (const e of searchDoneEvents) {
      console.log(`  round ${e.round}: ${(e.round_ms / 1000).toFixed(1)}s, ${e.results} results`);
    }
    const totalSearchMs = searchDoneEvents.reduce((s, e) => s + (e.round_ms || 0), 0);
    console.log(`Total time in search rounds: ${(totalSearchMs / 1000).toFixed(1)}s`);
    if (structuredOutputMs !== null) {
      console.log(`Time from last search result to stream close (structured-output + any trailing text gen): ${(structuredOutputMs / 1000).toFixed(1)}s`);
    }
    console.log(`Usage: input=${message.usage.input_tokens} output=${message.usage.output_tokens}` +
      (message.usage.server_tool_use ? ` web_search_requests=${message.usage.server_tool_use.web_search_requests}` : ''));
    console.log(`parsed_output present: ${!!message.parsed_output}`);
    if (message.parsed_output) {
      console.log(`Claims returned: ${message.parsed_output.claims.length}`);
    }
  } catch (err) {
    console.error('FAILED:', err.message);
    console.log(`(failed at ${rel()})`);
    process.exit(1);
  }
})();
