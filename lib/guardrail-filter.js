// Professor Viva — server-side guardrail filter (Step 7 of the gap-closure plan).
// Implements 03-AI Rules §4 ("Guardrails 1–3 are checked by a rule-based
// server-side filter before any reply renders. A filtered reply regenerates at
// dial 0.") and Architecture §7 ("Output filter runs server-side before any
// Viva reply renders.").
//
// PURE CODE. No LLM. This is the deterministic safety net that sits AROUND the
// voice pass (Step 6): the model is told the guardrails in its prompt, but this
// filter enforces them regardless of what the model does.
//
// Three enforced guardrails:
//   G1 No fabricated evidence  (output side): any source the reply CITES must
//      exist in the stored evidence for this idea. The voice contract already
//      forbids raw citations, so a clean reply cites nothing; this catches a
//      model that cites a URL not in the evidence store (03-AI Rules §4.1).
//   G2 No personal attacks     (output side): the reply may roast the idea but
//      never punch down at the founder (intelligence, education, English,
//      finances, background) — 03-AI Rules §4.2, pillar 1.
//   G3 No sarcasm on sensitive input (input side): if the founder discloses
//      job loss, financial desperation, health issues, or distress, personality
//      yields immediately — the dial is forced to 0 (03-AI Rules §4.3).

// ── G3: sensitive-disclosure detection on the founder's own words ──
// Kept deliberately conservative — these are strong distress signals, not mild
// negativity, because forcing dial 0 changes the product's tone entirely.
const SENSITIVE_PATTERNS = [
  // Job loss / unemployment
  /\b(laid off|lay ?offs?|got fired|was fired|lost my job|losing my job|unemployed|out of work|redundan(t|cy))\b/i,
  // Financial desperation
  /\b(broke|bankrupt|can'?t afford|cannot afford|last (of my )?savings|life savings|out of money|no money left|in debt|drowning in debt|evicted|foreclosure|desperate|financially desperate|need this to work to survive)\b/i,
  // Health / medical distress
  /\b(cancer|terminal|terminally ill|diagnosed with|chronic illness|disab(led|ility)|hospital(ised|ized)|depression|depressed|anxiety attack|suicidal|breakdown)\b/i,
  // Acute distress
  /\b(this is my last (shot|chance|hope)|nothing left to lose|about to give up|at rock bottom|can'?t go on)\b/i
];

// ── G2: punching-down patterns that target the FOUNDER, not the idea ──
// Tight by design: idea-roasts like "this idea has been built 47 times" or
// "your market doesn't exist" must NOT trip. Only attacks on the person do.
const PERSONAL_ATTACK_PATTERNS = [
  /\byou('?re| are)\s+(an?\s+)?(idiot|stupid|dumb|moron|fool|clueless|incompetent|delusional|lazy|pathetic|worthless|a joke|a clown|a failure)\b/i,
  /\byou('?re| are)\s+not\s+(smart|clever|intelligent|talented|good|capable)\s+enough\b/i,
  /\b(too|so)\s+(stupid|dumb|slow|incompetent|clueless)\s+to\b/i,
  /\bwhat'?s\s+wrong\s+with\s+you\b/i,
  // Attacks on the person's attributes rather than the idea. "your idea",
  // "your market", "your solution" are fine; these person-attributes are not.
  /\byour\s+(english|grammar|accent|education|degree|intelligence|iq|upbringing|background|family)\b/i
];

const URL_RE = /https?:\/\/[^\s)\]]+/gi;

// G3 — scans the founder's intake for distress disclosure.
function detectSensitiveInput(idea) {
  const text = [idea.problem, idea.audience, idea.monetization_hypothesis, idea.unfair_advantage]
    .filter(Boolean)
    .join(' ');
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

// G1 — any URL the reply cites that is not a stored evidence source_url.
function findFabricatedSources(replyText, evidence) {
  const allowed = new Set((evidence || []).map((e) => e.source_url));
  const cited = replyText.match(URL_RE) || [];
  return cited
    .map((u) => u.replace(/[.,;:)\]]+$/, '')) // strip trailing punctuation
    .filter((u) => !allowed.has(u));
}

// G2 — punch-down patterns present in the reply.
function findPersonalAttacks(replyText) {
  return PERSONAL_ATTACK_PATTERNS
    .filter((re) => re.test(replyText))
    .map((re) => re.source);
}

// Output-side screen (G1 + G2). Returns { ok, violations }.
function screenReply(replyText, evidence) {
  const violations = [];
  const fabricated = findFabricatedSources(replyText, evidence);
  if (fabricated.length) {
    violations.push({ guardrail: 'no_fabricated_evidence', detail: fabricated });
  }
  const attacks = findPersonalAttacks(replyText);
  if (attacks.length) {
    violations.push({ guardrail: 'no_personal_attacks', detail: attacks });
  }
  return { ok: violations.length === 0, violations };
}

// Orchestrates the full guardrail flow around a voice render.
//   `render` is an async (dial) => replyText — dependency-injected so the flow
//   is testable in pure code without an LLM.
// Behavior (03-AI Rules §4):
//   1. G3: sensitive input forces dial 0 on the FIRST render.
//   2. Render, then G1+G2 screen the output.
//   3. If the reply is filtered, it regenerates ONCE at dial 0.
// Returns the final reply plus an audit trail of what the filter did.
async function renderWithGuardrails({ idea, evidence, baseDial, render }) {
  const sensitiveInput = detectSensitiveInput(idea);
  const firstDial = sensitiveInput ? 0 : baseDial;

  let dialUsed = firstDial;
  let reply = await render(firstDial);
  let screen = screenReply(reply, evidence);
  let regenerated = false;

  if (!screen.ok) {
    // A filtered reply regenerates at dial 0 (03-AI Rules §4).
    regenerated = true;
    dialUsed = 0;
    reply = await render(0);
    screen = screenReply(reply, evidence);
  }

  return {
    reply,
    dialUsed,
    sensitiveInput,
    regenerated,
    // Any violations that SURVIVED regeneration (should be empty in practice;
    // surfaced so the endpoint can log a hard failure rather than hide it).
    residualViolations: screen.violations
  };
}

module.exports = {
  detectSensitiveInput,
  screenReply,
  findFabricatedSources,
  findPersonalAttacks,
  renderWithGuardrails,
  SENSITIVE_PATTERNS,
  PERSONAL_ATTACK_PATTERNS
};
