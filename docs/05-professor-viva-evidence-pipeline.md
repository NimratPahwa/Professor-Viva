# Professor Viva — Evidence Pipeline (Step 3 of gap-closure plan)
**Companion docs:** 01-PRD (FR-1.2) · 02-Architecture (§3 stage 2, §7)

---

## 1. Design

One Claude call per dimension (demand, market_gap, monetization, founder_fit,
timing), run in parallel via `Promise.all`. Each call:

1. Uses the `web_search_20260209` server-side tool to search and ground its
   answer.
2. Simultaneously constrained via `output_config.format` (structured
   outputs) to return `{ claims: [{ claim, source_url }] }` in the same
   request — no separate voice/formatting pass needed at this stage.

Model: `claude-sonnet-4-6` — "Sonnet-class for evidence gathering (volume,
cost)" per Architecture §3/§5.

Each call is made with the **streaming** helper (`client.messages.stream(...)
.finalMessage()`) rather than a single blocking request. A thorough
web-search-grounded call runs ~3 minutes (measured: 181s for one dimension
returning 33 sourced claims), which is long enough to hit the SDK's default
request timeout on a non-streamed call. Streaming keeps the connection alive
for the full duration; `parsed_output` is still populated on the final
message because `output_config.format` is set. The per-dimension timeout is
`DIMENSION_TIMEOUT_MS = 240_000` (240s) — the original 45s sketch killed every
dimension before it could finish.

### Interim vs. production execution model

This synchronous, in-request design is a **beta-only interim**. The
`POST /ideas/:id/evidence` request blocks for ~3–5 minutes while all five
dimensions run in parallel — acceptable for the beta, but fragile for
production (client/proxy timeouts, no crash recovery, no progress visibility).
Architecture §3 ("Execution model — interim vs. production") records the
scoped Production TODO to move evidence gathering to a persistent async job
with job status, bounded retries, idempotency, cancellation, per-dimension
progress reporting, crash/failure recovery, and incrementally stored results.

## 2. Why claims are re-validated in code, not trusted from the model

Claude's `source_url` field in the structured output is free text — the
model could in principle cite a URL it didn't actually retrieve. To close
that gap, every response's `web_search_tool_result` content blocks are
parsed for the **actual URLs Anthropic's search infrastructure returned**
(the ground-truth retrieved set). Any claim whose `source_url` is not a
member of that set is discarded before it ever reaches the `evidence` table.

This is the code-level enforcement of:
- Architecture §3: "Unsourced claims discarded at this boundary"
- 03-AI Rules §4.1: "No fabricated evidence"

This was verified empirically (see exploration transcript) — the model does
return only URLs from the retrieved set, but the code check exists
independent of that observed behavior since guardrails must be
code-enforced, not model-trusted.

## 3. Failure mode

Per Architecture §3, a dimension that times out (240s — see interim budget
above) or produces zero validated claims degrades to
`status: "insufficient_signal"` — never fabricated filler. Dimension calls run in parallel and are independent: one
dimension failing does not block or fail the others (`Promise.all` over
per-dimension try/catch, not a single throw).

## 4. Idea-text privacy (Architecture §7)

"Evidence gathering never posts or exposes user idea text to third-party
communities — search queries are derived category terms, not the idea
verbatim."

Enforcement here is prompt-level: the model is given the idea's `audience`
and `monetization_hypothesis` fields as category context plus an explicit
instruction not to quote the founder's specific wording in search queries.
This is not code-enforced (the model chooses its own search query text
internally via the web_search tool) — flagging this as a known limitation.
A stronger enforcement (e.g., inspecting actual `web_search` tool_use query
strings post-hoc for verbatim substring matches against `problem`) is not
implemented in this step and could be added later if this becomes a
concern.

## 5. Endpoint

`POST /ideas/:id/evidence` — loads the idea, runs all 5 dimensions in
parallel, persists validated claims to `evidence`, sets idea status to
`evidence_gathering`, returns a per-dimension status summary plus the full
evidence rows.
