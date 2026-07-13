// Professor Viva — Step 11: entitlement logic (FR-1.7), pure code.
//
// One paid purchase grants TWO validation runs for an idea: the initial run
// plus one free re-validation. The third run is blocked pending a new purchase.
// The rule is currency-agnostic — identical for INR and USD buyers — because it
// counts purchases, not money.
//
// This module is intentionally free of I/O so the rule can be unit-tested
// hermetically. The repo layer supplies the two counts.

const RUNS_PER_PURCHASE = 2; // initial validation + one free re-validation

// Given how many paid purchases exist for an idea and how many validation runs
// have already been recorded, decide whether another run is allowed.
function evaluateEntitlement({ paidPurchases, runsUsed }) {
  const paid = Number(paidPurchases) || 0;
  const used = Number(runsUsed) || 0;
  const runsAllowed = paid * RUNS_PER_PURCHASE;
  const runsRemaining = Math.max(0, runsAllowed - used);
  const allowed = runsRemaining > 0;

  return {
    allowed,
    paidPurchases: paid,
    runsUsed: used,
    runsAllowed,
    runsRemaining,
    // Reason codes let the API return a precise 402 vs 200 without re-deriving.
    reason: allowed
      ? (used === 0 ? 'initial' : 'free_revalidation')
      : (paid === 0 ? 'no_purchase' : 'runs_exhausted')
  };
}

module.exports = {
  RUNS_PER_PURCHASE,
  evaluateEntitlement
};
