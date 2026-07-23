// Diagnostic ONLY — tests the proposed fix for the deep-tier timeout:
// split ONE dimension's evidence gathering into two calls instead of one.
//
//   Call A: web_search tool ONLY, no output_config/schema. Free-text answer.
//           This is the call that, when combined with output_config.format in
//           the same request, triggered an undeclared code-execution loop
//           (see diag-dimension-timing.js: 1017.8s / 439K input tokens on a
//           single 'demand' call). Call A never sets output_config, so it
//           should never trigger that loop.
//   Call B: takes Call A's raw text response, NO tools declared, only
//           output_config.format (the Zod schema). Pure text->JSON
//           reformatting, nothing for the model to "search" or "execute".
//
// Ground-truth URL validation still applies: Call A's response.content is
// scanned for web_search_tool_result blocks exactly as gatherDimensionEvidence
// does today; Call B's claims are filtered to only those citing a URL that
// was actually retrieved in Call A.
//
// Run ONE dimension only, to spend minimally:
//   node scripts/diag-fix2-split-call.js demand

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');
const { z } = require('zod');
const { DIMENSIONS, buildCategoryQuery, extractGroundTruthUrls, DEEP_MAX_SEARCHES } = require('../lib/evidence-pipeline');

const dimension = process.argv[2] || 'demand';
if (!DIMENSIONS[dimension]) {
  console.error(`Unknown dimension "${dimension}". Choices: ${Object.keys(DIMENSIONS).join(', ')}`);
  process.exit(1);
}

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
const baseQuery = buildCategoryQuery(idea, focus, dimension);

const t0 = Date.now();
const rel = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

function instrumentStream(stream, label) {
  let searchRoundCount = 0;
  let codeExecRounds = 0;
  stream.on('streamEvent', (event) => {
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block && block.type === 'server_tool_use') {
        if (block.name === 'web_search') {
          console.log(`[${rel()}] ${label}: server_tool_use web_search`);
        } else {
          console.log(`[${rel()}] ${label}: server_tool_use "${block.name}" (UNEXPECTED — not web_search)`);
        }
      } else if (block && (block.type === 'code_execution_tool_result' || block.type === 'bash_code_execution_tool_result')) {
        codeExecRounds++;
        console.log(`[${rel()}] ${label}: *** CODE EXECUTION ROUND #${codeExecRounds} (${block.type}) ***`);
      } else if (block && block.type === 'web_search_tool_result') {
        searchRoundCount++;
        console.log(`[${rel()}] ${label}: web_search_tool_result (round ${searchRoundCount})`);
      }
    }
  });
  return { getSearchRounds: () => searchRoundCount, getCodeExecRounds: () => codeExecRounds };
}

(async () => {
  console.log(`Dimension: ${dimension}`);
  console.log(`Fix (2): Call A (web_search, no schema) -> Call B (schema, no tools)`);
  console.log('=== CALL A: gather (web_search only, no output_config) ===');

  const callAPrompt = baseQuery +
    ` Respond in plain prose: for each claim, state the fact, the exact source URL you found it at, ` +
    `and its signal (supports / neutral / undermines) using the definitions above. List each claim on its own line.`;

  const tA0 = Date.now();
  const streamA = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: DEEP_MAX_SEARCHES }],
    messages: [{ role: 'user', content: callAPrompt }]
  });
  const instA = instrumentStream(streamA, 'CallA');

  let messageA;
  try {
    messageA = await streamA.finalMessage();
  } catch (err) {
    console.error('CALL A FAILED:', err.message);
    process.exit(1);
  }
  const callAMs = Date.now() - tA0;

  const groundTruthUrls = extractGroundTruthUrls(messageA.content);
  const callAText = messageA.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

  console.log('--- Call A done ---');
  console.log(`Call A time: ${(callAMs / 1000).toFixed(1)}s`);
  console.log(`Call A search rounds: ${instA.getSearchRounds()}`);
  console.log(`Call A code-execution rounds: ${instA.getCodeExecRounds()} ${instA.getCodeExecRounds() > 0 ? '⚠️  UNEXPECTED' : '(none, as expected)'}`);
  console.log(`Call A usage: input=${messageA.usage.input_tokens} output=${messageA.usage.output_tokens}` +
    (messageA.usage.server_tool_use ? ` web_search_requests=${messageA.usage.server_tool_use.web_search_requests}` : ''));
  console.log(`Ground-truth URLs retrieved: ${groundTruthUrls.size}`);
  console.log(`Call A text length: ${callAText.length} chars`);

  if (instA.getCodeExecRounds() > 0) {
    console.log('\n*** STOPPING: Call A alone triggered code-execution rounds. Per instructions, reporting before spending more. ***');
    process.exit(0);
  }

  console.log('\n=== CALL B: format (schema only, no tools) ===');
  const tB0 = Date.now();
  const callBPrompt = `Here is research gathered on: ${focus}\n\n` +
    `--- RESEARCH NOTES ---\n${callAText}\n--- END NOTES ---\n\n` +
    `Convert the claims above into the structured claims format. Only include a claim if its source_url ` +
    `is exactly one of these retrieved URLs (do not alter or guess URLs): ${[...groundTruthUrls].join(', ')}`;

  const streamB = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    output_config: { format: zodOutputFormat(ClaimsSchema, 'claims') },
    messages: [{ role: 'user', content: callBPrompt }]
  });
  const instB = instrumentStream(streamB, 'CallB');

  let messageB;
  try {
    messageB = await streamB.finalMessage();
  } catch (err) {
    console.error('CALL B FAILED:', err.message);
    process.exit(1);
  }
  const callBMs = Date.now() - tB0;

  console.log('--- Call B done ---');
  console.log(`Call B time: ${(callBMs / 1000).toFixed(1)}s`);
  console.log(`Call B code-execution rounds: ${instB.getCodeExecRounds()} ${instB.getCodeExecRounds() > 0 ? '⚠️  UNEXPECTED' : '(none, as expected)'}`);
  console.log(`Call B usage: input=${messageB.usage.input_tokens} output=${messageB.usage.output_tokens}`);
  console.log(`Call B parsed_output present: ${!!messageB.parsed_output}`);

  const validatedClaims = messageB.parsed_output
    ? messageB.parsed_output.claims.filter((c) => groundTruthUrls.has(c.source_url))
    : [];

  console.log(`Claims returned by Call B: ${messageB.parsed_output ? messageB.parsed_output.claims.length : 0}`);
  console.log(`Claims validated against ground-truth URLs: ${validatedClaims.length}`);

  const totalMs = callAMs + callBMs;
  const totalInput = messageA.usage.input_tokens + messageB.usage.input_tokens;
  const totalOutput = messageA.usage.output_tokens + messageB.usage.output_tokens;
  // Sonnet 4.6 pricing: $3/1M input, $15/1M output.
  const cost = (totalInput / 1e6) * 3 + (totalOutput / 1e6) * 15;

  console.log('\n=== TOTAL (Call A + Call B) ===');
  console.log(`Total time: ${(totalMs / 1000).toFixed(1)}s (target: <120s)`);
  console.log(`Total input tokens: ${totalInput} (prior single-call blowup: 439,155)`);
  console.log(`Total output tokens: ${totalOutput}`);
  console.log(`Estimated cost (Sonnet 4.6 rates): $${cost.toFixed(4)} per dimension`);
  console.log(`Projected full deep run (5 dimensions, same shape): ~${(totalMs * 5 / 1000).toFixed(0)}s, ~$${(cost * 5).toFixed(2)}`);
})();
