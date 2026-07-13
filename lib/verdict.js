// Professor Viva — verdict thresholds (Step 5 of the gap-closure plan).
// Implements 03-AI Rules §3 and Architecture §3 stage 4.
//
// PURE CODE. No LLM. The verdict is a hard-coded threshold comparison over the
// rubric-weighted total from the scoring engine (lib/scoring.js), so the same
// idea + same evidence always yields the same verdict (CLAUDE.md).
//
// Thresholds (03-AI Rules §3):
//   >= 75          -> BUILD   (unlocks the Layer 2 offer)
//   50 .. 74.99    -> PIVOT   (Viva names the pivot; re-validation is free)
//   < 50           -> BURY    (salvageable insight + one adjacent direction)

const THRESHOLD_VERSION = '1.0.0';

const THRESHOLDS = {
  BUILD: 75, // total >= 75
  PIVOT: 50  // 50 <= total < 75 ; below 50 is BURY
};

function determineVerdict(total) {
  if (typeof total !== 'number' || Number.isNaN(total)) {
    throw new TypeError(`determineVerdict expects a numeric total, got ${total}`);
  }
  if (total >= THRESHOLDS.BUILD) return 'BUILD';
  if (total >= THRESHOLDS.PIVOT) return 'PIVOT';
  return 'BURY';
}

module.exports = { determineVerdict, THRESHOLDS, THRESHOLD_VERSION };
