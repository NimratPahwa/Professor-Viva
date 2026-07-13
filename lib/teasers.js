// Professor Viva — locked-section teasers (Step 11.5, FR-1.11).
//
// PURE CODE. No LLM. The free verdict screen shows the paid sections LOCKED, in
// this exact order: (1) next steps, (2) competitive analysis, (3) evidence. Each
// locked section shows a BLURRED TEASER FRAGMENT drawn from THAT user's OWN real
// quick-pass content — NEVER fabricated (FR-1.11, 03-AI Rules §3.2 / guardrail 1).
//
// "Blurred" here is a server-side contract: we emit a short real fragment
// (`preview`) plus `blurred: true` and `locked: true` so the client renders the
// visible sliver under a blur and gates the rest behind unlock. A section with no
// real content does NOT get an invented teaser — it truthfully reports that the
// quick pass found nothing there.

// Fixed teaser order (FR-1.11): next steps first, then competitive, then evidence.
const TEASER_ORDER = ['next_steps', 'competitive_analysis', 'evidence'];

const SECTION_LABELS = {
  next_steps: 'Your 3 next steps',
  competitive_analysis: 'Competitive analysis',
  evidence: 'Evidence receipts'
};

// Real fragment, not a summary: the first ~12 words of actual content, then cut.
// Nothing is added that was not in the source text.
function blurFragment(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const words = clean.split(' ');
  const preview = words.slice(0, 12).join(' ');
  const truncated = words.length > 12;
  return { preview: truncated ? `${preview}…` : preview, blurred: true };
}

function lockedSection(section, { fragment, count, emptyNote }) {
  const base = {
    section,
    order: TEASER_ORDER.indexOf(section) + 1,
    label: SECTION_LABELS[section],
    locked: true
  };
  if (fragment) {
    return { ...base, has_content: true, item_count: count, teaser: fragment };
  }
  // No fabricated teaser — honest emptiness (guardrail 1 / §3.2).
  return { ...base, has_content: false, item_count: 0, teaser: null, note: emptyNote };
}

// Builds the ordered locked-section teasers for the free screen.
//   nextSteps    — the 3 shallow next steps (strings) from the quick verdict
//   competitive  — buildCompetitiveAnalysis(...) output for the quick evidence
//   evidenceRows — the quick-pass evidence rows ({ claim, source_url, ... })
function buildTeasers({ nextSteps, competitive, evidenceRows }) {
  const steps = (nextSteps || []).map((s) => String(s).trim()).filter(Boolean);
  const competitiveClaims = ((competitive && competitive.sections) || [])
    .flatMap((s) => s.claims || []);
  const evidence = evidenceRows || [];

  const sections = [
    lockedSection('next_steps', {
      fragment: steps.length ? blurFragment(steps[0]) : null,
      count: steps.length,
      emptyNote: 'Even a quick pass could not ground a next step here yet.'
    }),
    lockedSection('competitive_analysis', {
      fragment: competitiveClaims.length ? blurFragment(competitiveClaims[0].claim) : null,
      count: competitiveClaims.length,
      emptyNote: 'The quick pass found no competitor or pricing signal to show.'
    }),
    lockedSection('evidence', {
      fragment: evidence.length ? blurFragment(evidence[0].claim) : null,
      count: evidence.length,
      emptyNote: 'The quick pass validated no sourced claims to show.'
    })
  ];

  return sections;
}

module.exports = { buildTeasers, blurFragment, TEASER_ORDER, SECTION_LABELS };
