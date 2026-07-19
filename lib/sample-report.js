// Professor Viva — The Professor's Stage, the public /sample report (docs/15 §4.4).
//
// A permanently public, complete six-answer report from a SEEDED fixture, so a
// visitor can see the full paid product before paying, and so the report UI +
// exports are inspectable offline with NO LLM call (credits are empty this
// build). The DETERMINISTIC parts (scores, verdict, competitive assembly,
// receipts, card data) run through the REAL code paths over seeded evidence; the
// GENERATED prose (roast, next steps, Answers 5 & 6) is realistic static copy.
//
// TODO: replace the seeded evidence + static prose with a real captured run once
// Anthropic credits exist.

const { computeScores } = require('./scoring');
const { determineVerdict, THRESHOLD_VERSION } = require('./verdict');
const { buildCompetitiveAnalysis } = require('./competitive');
const { buildReceipts } = require('./receipts');
const { buildCardData } = require('./card-data');
const { assembleSixAnswers } = require('./report-answers');

const SAMPLE_IDEA = {
  id: 'sample',
  problem: 'A tool that turns messy meeting recordings into a shipped changelog',
  audience: 'solo founders and tiny product teams',
  monetization_hypothesis: 'flat $19/mo per workspace',
  unfair_advantage: 'I ran RevOps at two startups and hated this exact task weekly',
  created_at: '2026-07-13T09:00:00.000Z'
};

// Seeded evidence — realistic, with demand rows carrying real channels (migration
// 0009) and monetization rows carrying pricing comparables (grounds Answers 5&6).
const SAMPLE_EVIDENCE = [
  { dimension: 'demand', signal: 'supports', claim: 'Founders repeatedly ask "how do you turn calls into a changelog" in r/SaaS threads',
    source_url: 'https://www.reddit.com/r/SaaS/comments/sample1',
    channel: { type: 'subreddit', name: 'r/SaaS', url: 'https://www.reddit.com/r/SaaS' } },
  { dimension: 'demand', signal: 'supports', claim: 'Indie Hackers has a recurring "meeting notes to release notes" wishlist post',
    source_url: 'https://www.indiehackers.com/post/sample2',
    channel: { type: 'forum', name: 'Indie Hackers', url: 'https://www.indiehackers.com' } },
  { dimension: 'market_gap', signal: 'undermines', claim: 'Otter, Fathom, and Fireflies already summarize meetings',
    source_url: 'https://www.fireflies.ai/sample3' },
  { dimension: 'market_gap', signal: 'undermines', claim: 'Several changelog tools (Beamer, Released) exist but do not ingest calls',
    source_url: 'https://beamer.com/sample4' },
  { dimension: 'market_gap', signal: 'neutral', claim: 'No incumbent connects transcription directly to a public changelog',
    source_url: 'https://www.released.so/sample5' },
  { dimension: 'monetization', signal: 'supports', claim: 'Comparable meeting-AI tools charge $18–29/mo per seat',
    source_url: 'https://fathom.video/sample6' },
  { dimension: 'monetization', signal: 'neutral', claim: 'Changelog tools price $29–49/mo per workspace',
    source_url: 'https://beamer.com/pricing-sample7' },
  { dimension: 'founder_fit', signal: 'supports', claim: 'People who have run revenue operations are a credible fit to build this workflow',
    source_url: 'https://www.example.com/sample8' },
  { dimension: 'timing', signal: 'supports', claim: 'Cheap accurate transcription APIs only became viable in the last ~2 years',
    source_url: 'https://www.example.com/sample9' }
];

const SAMPLE_ROAST =
  "Here's the honest read: the pain is real and, annoyingly for you, well-documented. People genuinely " +
  "gather to complain about turning calls into changelogs. But you're walking into a room where Otter, Fathom, " +
  "and Fireflies are already handing out drinks. Your wedge isn't \"summarize meetings\" (solved); it's the one " +
  "thing none of them do: pipe the transcript straight into a public changelog. Pivot to THAT seam and you have " +
  "a shot. Keep competing on summarization and you're the 48th identical app.\n\n" +
  "Viva's verdict is a data-backed opinion, not a prophecy. Founders have proven me wrong before. It's annoying every time.";

const SAMPLE_NEXT_STEPS = [
  'Reframe the product around the changelog seam nobody owns. Not "meeting summaries," the auto-published release note.',
  'Post your build-log in r/SaaS and the Indie Hackers thread where this exact ask already lives; recruit 10 design partners.',
  'Charge from day one: a $19/mo founding tier to those first ten, so you learn willingness-to-pay before you scale.'
];

// Answers 5 & 6 grounded in the seeded channels + pricing (static but realistic).
const SAMPLE_SIX_ANSWERS = {
  acquisition:
    'Your first ten customers are already complaining in public. Go to r/SaaS and the Indie Hackers "meeting notes ' +
    'to release notes" thread this week, reply with a build-log, and DM the ten loudest askers a design-partner invite. ' +
    'You are not cold-emailing strangers, you are answering people who already raised their hand.',
  first_revenue:
    'Your first dollar is a $19/mo founding tier, priced against the $18–29/mo comparable meeting-AI tools already ' +
    'charge. Sell it to the design partners the day the changelog export works end to end. Do not wait for polish, a ' +
    'paid founding tier is the only honest signal that the changelog seam is worth building.'
};

// Assembles the full sample report through the real deterministic code paths.
function buildSampleReport() {
  const scores = computeScores(SAMPLE_EVIDENCE);
  const verdict = determineVerdict(scores.total);
  const competitive = buildCompetitiveAnalysis({ evidence: SAMPLE_EVIDENCE });

  // A verdict row-like object for receipts + card serial.
  const verdictRow = {
    id: 'sample-verdict',
    verdict,
    total_score: scores.total,
    threshold_version: THRESHOLD_VERSION,
    voice_pass_output: SAMPLE_ROAST,
    next_steps: SAMPLE_NEXT_STEPS,
    six_answers: SAMPLE_SIX_ANSWERS,
    created_at: '2026-07-13T09:00:11.000Z'
  };

  const receipts = buildReceipts({ idea: SAMPLE_IDEA, evidence: SAMPLE_EVIDENCE, verdict: verdictRow });
  const cardData = buildCardData({
    idea: SAMPLE_IDEA,
    verdict,
    scores,
    evidence: SAMPLE_EVIDENCE,
    elapsedMs: 11_000,
    verdictNumber: 'SAMPLE-001',
    buildsThisMonth: 3
  });

  // The Six Answers (Screen 5): 1–4 from evidence/competitive, 5–6 generated.
  const sixAnswers = assembleSixAnswers({
    idea: SAMPLE_IDEA, evidence: SAMPLE_EVIDENCE, competitive, sixAnswers: SAMPLE_SIX_ANSWERS
  });

  return {
    tier: 'sample',
    sample: true,
    note: 'Sample report. Seeded, realistic data. TODO: replace with a real run when credits exist.',
    idea: SAMPLE_IDEA,
    verdict,
    total_score: Number(scores.total),
    card_data: cardData,
    roast: SAMPLE_ROAST,
    next_steps: SAMPLE_NEXT_STEPS,
    six_answers: sixAnswers,
    competitive_analysis: competitive,
    evidence_receipts: receipts,
    evidence: SAMPLE_EVIDENCE
  };
}

module.exports = { buildSampleReport, SAMPLE_IDEA, SAMPLE_EVIDENCE };
