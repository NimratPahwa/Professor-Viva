// Professor Viva — The Professor's Stage, Screen 3 ("the wait"): the live
// free-verdict stream (Server-Sent Events).
//
// The blocking POST /ideas/:id/free-verdict returns one payload after the whole
// quick pass finishes. Screen 3 instead wants to watch the professor work: each
// dimension's finding as it settles, a ticking "sources examined" counter, then
// the verdict. This module holds the PURE pieces of that stream — SSE framing,
// the real dimension→finding mapping, and a seeded credit-free mock sequence —
// so the wait screen is inspectable offline (no LLM call) and hermetically
// testable. The server endpoint (GET /ideas/:id/free-verdict/stream) wires these
// to a response; `?mock=1` replays the seeded sequence.

// One SSE frame: named event + JSON data. Two trailing newlines terminate a
// frame per the text/event-stream grammar.
function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Maps a settled quick-pass dimension result to a `finding` event payload. Only
// real, observed numbers — claim count, sources examined, and the signal mix —
// never invented (03-AI Rules §4.1). `cumulativeSources` is the running total
// the counter shows.
function findingEvent(result, cumulativeSources) {
  const mix = { supports: 0, undermines: 0, neutral: 0 };
  for (const c of result.claims || []) {
    const s = c.signal || 'neutral';
    if (mix[s] !== undefined) mix[s] += 1;
  }
  return {
    dimension: result.dimension,
    status: result.status,
    claim_count: (result.claims || []).length,
    sources_examined: result.sources_examined || 0,
    total_sources_examined: cumulativeSources,
    signal_mix: mix
  };
}

// The five rubric dimensions, in the order the wait screen reveals them.
const STREAM_DIMENSIONS = ['demand', 'market_gap', 'monetization', 'founder_fit', 'timing'];

// A seeded, credit-free event sequence for `?mock=1`: five `finding` events
// (running counter), a terminal `progress`, then a `verdict` carrying the same
// shape the blocking endpoint returns (verdict, score, roast, locked_sections).
// Deterministic so the wait screen — and the Done-When test — can inspect it
// with no LLM call. Numbers are realistic but explicitly synthetic.
function buildMockStreamSequence() {
  const perDim = [
    { dimension: 'demand', status: 'ok', claims: [{ signal: 'supports' }, { signal: 'supports' }], sources_examined: 4 },
    { dimension: 'market_gap', status: 'ok', claims: [{ signal: 'undermines' }, { signal: 'undermines' }, { signal: 'neutral' }], sources_examined: 5 },
    { dimension: 'monetization', status: 'ok', claims: [{ signal: 'neutral' }], sources_examined: 3 },
    { dimension: 'founder_fit', status: 'insufficient_signal', claims: [], sources_examined: 2 },
    { dimension: 'timing', status: 'ok', claims: [{ signal: 'supports' }], sources_examined: 3 }
  ];

  const events = [];
  let cumulative = 0;
  for (const r of perDim) {
    cumulative += r.sources_examined;
    events.push({ event: 'finding', data: findingEvent(r, cumulative) });
  }

  events.push({ event: 'progress', data: { sources_examined: cumulative, dimensions_complete: perDim.length } });

  events.push({
    event: 'verdict',
    data: {
      tier: 'free',
      mock: true,
      quick_pass_label: 'quick evidence pass',
      verdict: 'PIVOT',
      total_score: 54,
      roast:
        "Quick pass, first read: the pain is real, people genuinely gather to complain about this, " +
        "but you're walking into a crowded room wearing the same shirt as everyone else. The specific reason " +
        "this dies in its current shape is in the full report. Pivot the wedge, don't bury the ambition.\n\n" +
        "Viva's verdict is a data-backed opinion, not a prophecy. Founders have proven me wrong before. It's annoying every time.",
      locked_sections: [
        { section: 'next_steps', label: 'Your first move (blurred)', teaser: 'Go where they already ga\u2588\u2588\u2588\u2588\u2588\u2588 and \u2588\u2588\u2588\u2588\u2588 the wedge before you build.' },
        { section: 'competitive_analysis', label: 'Your competitors, priced (blurred)', teaser: 'At least \u2588 comparable tools already charge $\u2588\u2588\u2013\u2588\u2588/mo for this.' },
        { section: 'evidence', label: 'The receipts (blurred)', teaser: 'Founders keep asking for this on r/\u2588\u2588\u2588\u2588, sourced in the full report.' }
      ],
      unlock: { action: 'Unlock your next steps + full report' }
    }
  });

  return events;
}

module.exports = { sseFrame, findingEvent, buildMockStreamSequence, STREAM_DIMENSIONS };
