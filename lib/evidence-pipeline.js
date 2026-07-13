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

const client = new Anthropic();

// Sonnet-class for evidence gathering (volume, cost) — Architecture §3, §5.
const EVIDENCE_MODEL = 'claude-sonnet-4-6';
// Interim beta budget. A thorough web_search-grounded call empirically takes
// ~3 min (measured: 181s for a single dimension returning 33 sourced claims),
// so the original 45s budget from Architecture §3 killed every dimension
// before it could finish. 240s accommodates real latency. This synchronous
// approach is a beta-only interim; production must move evidence gathering to
// a persistent async job (see Architecture §3 "Production TODO").
const DIMENSION_TIMEOUT_MS = 240_000;

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
const ClaimsSchema = z.object({
  claims: z.array(z.object({
    claim: z.string(),
    source_url: z.string(),
    signal: z.enum(['supports', 'neutral', 'undermines'])
  }))
});

function buildCategoryQuery(idea, dimensionFocus) {
  // Derived category terms, not the idea verbatim (Architecture §7).
  return `Category/problem space: ${idea.audience}. General monetization approach: ${idea.monetization_hypothesis}. ` +
    `Research focus for this dimension: ${dimensionFocus} ` +
    `Do not quote or closely paraphrase the founder's specific wording in any search query — search using general category and problem-space terms only. ` +
    `For every claim, also classify its "signal" — whether the sourced fact strengthens or weakens the case for building this specific idea on THIS dimension: ` +
    `"supports" = good news for the idea here (e.g. strong demand found, a real market gap, viable pricing, favorable timing); ` +
    `"undermines" = bad news for the idea here (e.g. no demand, a crowded/saturated market, weak unit economics, a declining trend); ` +
    `"neutral" = relevant and sourced but not directionally good or bad. ` +
    `Classify honestly against the evidence — do not inflate. A damning-but-true fact must be labeled "undermines".`;
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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('dimension timed out')), ms))
  ]);
}

async function gatherDimensionEvidence(dimension, idea) {
  const focus = DIMENSIONS[dimension].focus;

  try {
    // Streaming (via .finalMessage()) rather than a single blocking request:
    // these calls run ~3 min, long enough to hit the SDK's default request
    // timeout. Streaming keeps the connection alive for the full duration.
    // parsed_output is still populated on the final message because
    // output_config.format is set.
    const response = await withTimeout(
      client.messages.stream({
        model: EVIDENCE_MODEL,
        max_tokens: 4000,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        output_config: { format: zodOutputFormat(ClaimsSchema, 'claims') },
        messages: [{ role: 'user', content: buildCategoryQuery(idea, focus) }]
      }).finalMessage(),
      DIMENSION_TIMEOUT_MS
    );

    if (!response.parsed_output) {
      return { dimension, status: 'insufficient_signal', claims: [] };
    }

    const groundTruthUrls = extractGroundTruthUrls(response.content);
    const validatedClaims = response.parsed_output.claims.filter(
      (c) => groundTruthUrls.has(c.source_url)
    );

    if (validatedClaims.length === 0) {
      return { dimension, status: 'insufficient_signal', claims: [] };
    }

    return { dimension, status: 'ok', claims: validatedClaims };
  } catch (err) {
    console.error(`evidence gathering failed for dimension "${dimension}":`, err.message);
    return { dimension, status: 'insufficient_signal', claims: [] };
  }
}

async function gatherAllEvidence(idea) {
  const dimensionNames = Object.keys(DIMENSIONS);
  const results = await Promise.all(
    dimensionNames.map((dimension) => gatherDimensionEvidence(dimension, idea))
  );
  return results;
}

module.exports = {
  gatherAllEvidence,
  gatherDimensionEvidence,
  buildCategoryQuery,
  extractGroundTruthUrls,
  DIMENSIONS
};
