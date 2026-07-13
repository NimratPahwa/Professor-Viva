// Professor Viva — two-pass voice layer (Step 6 of the gap-closure plan).
// Implements 03-AI Rules §1 (pillars), §2 (dial), §4 (guardrails), §5 (prompt
// stack + two-pass rule + model allocation + versioning).
//
// SECOND PASS ONLY. The deterministic verdict and scores are already decided
// (Steps 4–5, pure code). This module renders that decision in Viva's voice.
// Per the §5 two-pass rule, scores/verdict enter the prompt as FIXED FACTS to
// narrate — never as editable values. The model chooses words, never numbers.
// Nothing this module does can change a score or flip a verdict.

const Anthropic = require('@anthropic-ai/sdk');
const { z } = require('zod');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const client = new Anthropic();

// Top-tier Claude for the verdict voice pass (03-AI Rules §5 model allocation).
const VOICE_MODEL = 'claude-opus-4-6';

// Version of the whole voice prompt stack. Recorded on the verdict row so
// personality changes are A/B-testable against share rate without touching the
// pipeline (03-AI Rules §5 "Versioning").
const VOICE_PROMPT_VERSION = 'voice-1.0.0';

// Sarcasm dial per verdict, from the §2 calibration table. Injected in CODE —
// "never left to the model's judgment" (§2). Verdict delivery is the shareable
// moment at 8/10; a BURY is firm-but-never-cruel at 6/10 (§2).
const SARCASM_DIAL = {
  BUILD: 8, // verdict delivery — the shareable moment
  PIVOT: 8, // verdict delivery — the shareable moment
  BURY: 6   // BURY verdict — the user just got bad news
};

// Verbatim standing footer (03-AI Rules §4.6). APPENDED IN CODE so guardrail 6
// ("verdicts are advisory") cannot be dropped or reworded by the model.
const STANDING_FOOTER =
  "Viva's verdict is a data-backed opinion, not a prophecy. Founders have proven me wrong before. It's annoying every time.";

// Every verdict's door is operationalized as exactly this many concrete next
// steps (03-AI Rules §3.1). Enforced in code — the count is not the model's
// choice.
const NEXT_STEPS_COUNT = 3;

// ── §5 stack part 1: viva_core_identity — character, pillars, guardrails ──
function coreIdentity() {
  return [
    'You are Professor Viva — the professor who saves founders from themselves.',
    'Sarcastic, funny, brutally honest, and always in the founder\'s corner. The',
    'sarcasm is the delivery mechanism for genuine care: you roast the idea',
    'because you don\'t want them wasting six months of their life.',
    '',
    'Voice pillars (non-negotiable):',
    '1. Roast the IDEA, never the founder. "This has been built 47 times" — yes.',
    '   "You\'re not smart enough" — never.',
    '2. Every roast carries a receipt. Sarcasm without evidence is just being',
    '   mean. Every jab must be anchored to a sourced fact from the evidence',
    '   block below.',
    '3. Every verdict ends with a door. A BURY always includes the salvageable',
    '   insight or an adjacent pivot. You kill ideas, not ambition.',
    '4. Earned warmth. When an idea genuinely scores well, drop the act for one',
    '   beat — that rare sincerity is what makes it land.',
    '',
    'Hard guardrails (non-negotiable):',
    '- No fabricated evidence. If a fact is not in the evidence block, you may',
    '  not state it. "I couldn\'t find demand signals" is a valid, damning',
    '  finding — use it rather than inventing data.',
    '- No personal attacks, no punching down: nothing about the founder\'s',
    '  background, education, finances, or circumstances. Ever.',
    '- No false hope. Never inflate the verdict to be nice. A BURY delivered',
    '  kindly is still a BURY.',
    '- No competitor defamation. Named competitors get factual, sourced',
    '  statements only. Target the idea\'s POSITION, not other companies.',
    '- You do not assign or change scores or the verdict. They are decided.',
    '  Your job is to narrate the decision, not revisit it.'
  ].join('\n');
}

// ── §5 stack part 2: viva_context_dial — sarcasm level injected per §2 ──
function contextDial(dial) {
  return [
    `Sarcasm dial for this reply: ${dial}/10.`,
    dial >= 8
      ? 'This is the verdict-delivery moment — the shareable line. Sharp, quotable, confident. Still caring underneath, still every jab on a receipt.'
      : 'The founder just got bad news. Firm and honest but never cruel — dial the sting down, keep the care up. No gloating.'
  ].join('\n');
}

// ── §5 stack part 3: task_instructions — delivery instructions ──
function taskInstructions(verdict) {
  const doorByVerdict = {
    BUILD: 'This is the rare sincere BUILD. Drop the act for a beat and mean it — but only because the evidence earns it. End by pointing at the strongest evidence-backed reason to build.',
    PIVOT: 'Name the SPECIFIC pivot the evidence points to (wrong wedge, wrong audience, too many features — whatever the signals show). The problem may be real; the current shape is not the winner. End with the concrete next move.',
    BURY: 'Deliver the BURY clearly — no false hope. Then end with a DOOR: the salvageable insight, or one adjacent direction the evidence actually supports. Kill the idea, not the ambition.'
  };
  return [
    `The verdict is ${verdict}. Deliver it in 2–4 tight paragraphs of prose (no`,
    'markdown headings, no bullet lists, no score numbers — speak the judgment).',
    doorByVerdict[verdict],
    'Every claim you make must trace to a fact in the evidence block. Do not',
    'restate the raw scores; translate what the evidence MEANS. Do not append a',
    'disclaimer or footer yourself — that is added afterward.'
  ].join('\n');
}

// ── §5 stack part 4: evidence_block — retrieved, sourced facts only ──
// Scores appear here only as read-only context (the two-pass rule): the model
// narrates them, it cannot edit them.
function evidenceBlock(scores, evidence) {
  const byDim = {};
  for (const row of evidence) {
    (byDim[row.dimension] = byDim[row.dimension] || []).push(row);
  }

  const lines = ['EVIDENCE BLOCK (the only facts you may cite):', ''];
  for (const [dim, dimScore] of Object.entries(scores.dimensions)) {
    lines.push(
      `## ${dim} — score ${dimScore.score}/100 (${dimScore.status}; ` +
      `${dimScore.supports} supporting / ${dimScore.undermines} undermining / ${dimScore.neutral} neutral)`
    );
    const rows = byDim[dim] || [];
    if (rows.length === 0) {
      lines.push('  (no validated evidence retrieved for this dimension)');
    } else {
      for (const r of rows) {
        lines.push(`  - [${r.signal}] ${r.claim} (source: ${r.source_url})`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ── §5 stack part 5: output_contract — prose for voice ──
function outputContract() {
  return [
    'OUTPUT CONTRACT: Return only Viva\'s spoken verdict as plain prose.',
    'No preamble, no headings, no lists, no score numbers, no closing',
    'disclaimer. Just the professor\'s voice.'
  ].join('\n');
}

function buildSystemPrompt(dial, verdict, scores, evidence) {
  return [
    coreIdentity(),
    contextDial(dial),
    taskInstructions(verdict),
    evidenceBlock(scores, evidence),
    outputContract()
  ].join('\n\n---\n\n');
}

function extractText(message) {
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// Renders the already-decided verdict in Viva's voice.
// Inputs (all read-only facts): verdict + scores from Steps 4–5, the evidence
// rows behind them, and the idea for context. `dial` optionally overrides the
// §2 default for this verdict — the guardrail filter (Step 7) passes dial 0
// when it forces personality off. Returns the spoken verdict with the standing
// footer appended in code, plus the metadata to persist.
async function renderVerdictVoice({ verdict, scores, evidence, idea, dial }) {
  const resolvedDial = dial === undefined ? SARCASM_DIAL[verdict] : dial;
  if (resolvedDial === undefined) {
    throw new Error(`renderVerdictVoice: unknown verdict "${verdict}"`);
  }

  const system = buildSystemPrompt(resolvedDial, verdict, scores, evidence);

  // Streaming .finalMessage(): opus voice passes can run long; streaming keeps
  // the connection alive past the SDK default request timeout. Adaptive
  // thinking lets the model reason about tone/receipt-matching before speaking.
  const message = await client.messages
    .stream({
      model: VOICE_MODEL,
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      system,
      messages: [{
        role: 'user',
        content:
          `The idea under review — problem: "${idea.problem}"; audience: ` +
          `"${idea.audience}". Deliver the ${verdict} verdict now.`
      }]
    })
    .finalMessage();

  const body = extractText(message);
  // Footer appended in code (guardrail 6) — the model never controls it.
  const voice = `${body}\n\n${STANDING_FOOTER}`;

  return {
    voice,
    sarcasm_dial: resolvedDial,
    voice_prompt_version: VOICE_PROMPT_VERSION,
    model: VOICE_MODEL
  };
}

// ── Next steps (03-AI Rules §3.1): exactly 3 concrete, evidence-grounded actions
// rendered in Viva's voice at the SAME dial as the verdict. A separate structured
// pass (two-pass rule §5): it narrates what to DO about a decision already made,
// and never touches the score or the verdict. ──

// Exactly-N contract. Length is enforced again in code below so a short/long
// model response is a hard error, not a silently-wrong verdict card.
const NextStepsSchema = z.object({
  next_steps: z.array(z.string()).min(NEXT_STEPS_COUNT).max(NEXT_STEPS_COUNT)
});

function nextStepsTaskInstructions(verdict) {
  return [
    `The ${verdict} verdict has been delivered. Now give the founder exactly ${NEXT_STEPS_COUNT} next steps.`,
    'Each step is a SINGLE, specific, doable action the founder should take next —',
    'the door made concrete (pillar 3). Every step must trace to a fact in the',
    'evidence block below; do not invent data or cite anything not present there.',
    'A step may carry Viva\'s wit at the dial above, but it must be genuinely',
    'useful and actionable — never a joke at the founder\'s expense, never a jab',
    'with no action in it. No numbering, no markdown, no score numbers — just the',
    'action text for each of the three steps.'
  ].join('\n');
}

function buildNextStepsPrompt(dial, verdict, scores, evidence) {
  return [
    coreIdentity(),
    contextDial(dial),
    nextStepsTaskInstructions(verdict),
    evidenceBlock(scores, evidence),
    `OUTPUT CONTRACT: Return exactly ${NEXT_STEPS_COUNT} next steps as an array of ` +
      'plain strings. No preamble, no headings, no numbering, no score numbers, no ' +
      'closing disclaimer.'
  ].join('\n\n---\n\n');
}

// Renders exactly NEXT_STEPS_COUNT next steps for the already-decided verdict.
// `dial` is the sarcasm level to use — callers pass the SAME dial the verdict
// voice ultimately used (so sensitive-input dial-0 verdicts get dial-0 steps).
// Returns the array plus metadata to persist. Structured output (no thinking),
// mirroring the proven evidence-pipeline pattern.
async function renderNextSteps({ verdict, scores, evidence, idea, dial }) {
  const resolvedDial = dial === undefined ? SARCASM_DIAL[verdict] : dial;
  if (resolvedDial === undefined) {
    throw new Error(`renderNextSteps: unknown verdict "${verdict}"`);
  }

  const system = buildNextStepsPrompt(resolvedDial, verdict, scores, evidence);

  const message = await client.messages
    .stream({
      model: VOICE_MODEL,
      max_tokens: 1500,
      system,
      output_config: { format: zodOutputFormat(NextStepsSchema, 'next_steps') },
      messages: [{
        role: 'user',
        content:
          `The idea under review — problem: "${idea.problem}"; audience: ` +
          `"${idea.audience}". Give the ${NEXT_STEPS_COUNT} next steps for the ` +
          `${verdict} verdict now.`
      }]
    })
    .finalMessage();

  const parsed = message.parsed_output;
  const steps = ((parsed && parsed.next_steps) || [])
    .map((s) => String(s).trim())
    .filter(Boolean);

  if (steps.length !== NEXT_STEPS_COUNT) {
    throw new Error(`renderNextSteps: expected ${NEXT_STEPS_COUNT} steps, got ${steps.length}`);
  }

  return {
    next_steps: steps,
    sarcasm_dial: resolvedDial,
    voice_prompt_version: VOICE_PROMPT_VERSION,
    model: VOICE_MODEL
  };
}

module.exports = {
  renderVerdictVoice,
  renderNextSteps,
  buildSystemPrompt,
  buildNextStepsPrompt,
  SARCASM_DIAL,
  STANDING_FOOTER,
  NEXT_STEPS_COUNT,
  VOICE_MODEL,
  VOICE_PROMPT_VERSION
};
