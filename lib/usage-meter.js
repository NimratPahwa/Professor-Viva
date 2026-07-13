// Professor Viva — API usage + cost metering (pure code, no I/O, no LLM).
//
// Every Claude call in the pipeline reports its real token usage back through
// this module so the cost of a run is measured, not estimated. It reads exactly
// three observable quantities off an Anthropic message's `usage` block —
// input_tokens, output_tokens, and server_tool_use.web_search_requests — and
// prices them from the published per-model rates. The orchestrators aggregate
// the per-call lines into a run summary; the deep run's summary is persisted on
// the validation_runs record and the free run's on the free_verdicts payload.
//
// Prices are the published list rates (Claude models table, cached 2026-02-17)
// in USD. Kept here as the single source of truth so a price change is a
// one-line edit, never a hunt through the pipeline.

// USD per 1,000,000 tokens.
const MODEL_PRICING = {
  'claude-opus-4-6': { input_per_mtok: 5.00, output_per_mtok: 25.00 },
  'claude-sonnet-4-6': { input_per_mtok: 3.00, output_per_mtok: 15.00 },
  'claude-haiku-4-5': { input_per_mtok: 1.00, output_per_mtok: 5.00 }
};

// The web_search server tool bills per request: $10 per 1,000 searches.
const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

// Micro-dollar precision — enough to keep sub-cent per-call costs, small enough
// to drop IEEE-754 float noise from the summed totals.
function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

// Pulls the three tracked quantities off an Anthropic message.usage, defensively
// (a null/short-circuited message — e.g. a timed-out call that never returned —
// meters as zero, which is truthful: we only bill what we observed).
function extractUsage(message) {
  const u = (message && message.usage) || {};
  const serverTool = u.server_tool_use || {};
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    web_search_requests: serverTool.web_search_requests || 0
  };
}

// Prices a usage quantity for a model. An unknown model prices tokens at 0 (and
// flags `priced: false`) rather than guessing — web_search still bills, since
// that rate is model-independent.
function costFor(model, usage) {
  const { input_tokens = 0, output_tokens = 0, web_search_requests = 0 } = usage || {};
  const pricing = MODEL_PRICING[model];
  const input_cost = pricing ? (input_tokens / 1e6) * pricing.input_per_mtok : 0;
  const output_cost = pricing ? (output_tokens / 1e6) * pricing.output_per_mtok : 0;
  const web_search_cost = web_search_requests * WEB_SEARCH_USD_PER_REQUEST;
  return {
    input_cost: round6(input_cost),
    output_cost: round6(output_cost),
    web_search_cost: round6(web_search_cost),
    total_cost: round6(input_cost + output_cost + web_search_cost),
    priced: !!pricing
  };
}

// One metered call = a labeled line carrying its tokens, searches, and cost.
// `message` may be null (a call that produced no final message meters as zero).
function usageLine(label, model, message) {
  const usage = extractUsage(message);
  const cost = costFor(model, usage);
  return { label, model, ...usage, ...cost };
}

// Folds an array of usageLine() lines into a run summary: the raw lines, the
// grand totals (tokens, searches, and each cost component), and a per-model
// breakdown. This is the object persisted on a run record and logged.
function summarizeUsage(lines) {
  const safe = Array.isArray(lines) ? lines.filter(Boolean) : [];
  const totals = {
    calls: safe.length,
    input_tokens: 0,
    output_tokens: 0,
    web_search_requests: 0,
    input_cost: 0,
    output_cost: 0,
    web_search_cost: 0,
    total_cost: 0
  };
  const byModel = {};

  for (const l of safe) {
    totals.input_tokens += l.input_tokens;
    totals.output_tokens += l.output_tokens;
    totals.web_search_requests += l.web_search_requests;
    totals.input_cost += l.input_cost;
    totals.output_cost += l.output_cost;
    totals.web_search_cost += l.web_search_cost;
    totals.total_cost += l.total_cost;

    const m = (byModel[l.model] = byModel[l.model] || {
      model: l.model, calls: 0, input_tokens: 0, output_tokens: 0, web_search_requests: 0, total_cost: 0
    });
    m.calls += 1;
    m.input_tokens += l.input_tokens;
    m.output_tokens += l.output_tokens;
    m.web_search_requests += l.web_search_requests;
    m.total_cost = round6(m.total_cost + l.total_cost);
  }

  for (const k of ['input_cost', 'output_cost', 'web_search_cost', 'total_cost']) {
    totals[k] = round6(totals[k]);
  }

  return { lines: safe, totals, by_model: Object.values(byModel) };
}

// A one-line, human-readable log string for a run summary.
function formatUsageLog(summary) {
  const t = (summary && summary.totals) || {};
  return `${t.calls || 0} calls, ${t.input_tokens || 0} in + ${t.output_tokens || 0} out tok, ` +
    `${t.web_search_requests || 0} web searches → $${(t.total_cost || 0).toFixed(4)}`;
}

module.exports = {
  MODEL_PRICING,
  WEB_SEARCH_USD_PER_REQUEST,
  extractUsage,
  costFor,
  usageLine,
  summarizeUsage,
  formatUsageLog
};
