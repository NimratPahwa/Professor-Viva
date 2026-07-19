// Professor Viva — free-verdict ledger persistence (Step 11.5, FR-1.9).
//
// The free-verdict ledger enforces "one free verdict per idea, per account": a
// (account, idea) pair has exactly one row (DB unique constraint, migration
// 0007). A second free-verdict attempt on the same pair is blocked pending
// unlock (FR-1.10). The `payload` jsonb carries the shallow quick-pass sections
// so the free screen renders from the user's OWN real content (FR-1.11).

const { getSupabase } = require('./db');

async function getFreeVerdict(accountId, ideaId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('free_verdicts')
    .select('*')
    .eq('account_id', accountId)
    .eq('idea_id', ideaId)
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

// The most recent free verdict for an idea, across accounts. Screen 4 renders
// the verdict card straight after the free verdict, so the card-data endpoint
// needs the idea's free verdict without knowing which account produced it.
async function getLatestFreeVerdictForIdea(ideaId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('free_verdicts')
    .select('*')
    .eq('idea_id', ideaId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

// Inserts the one free verdict for this (account, idea). The unique constraint
// is the durable backstop: if a concurrent request already inserted, this throws
// with Postgres code 23505, which the caller maps to "already claimed / blocked".
async function createFreeVerdict({ accountId, ideaId, verdict, totalScore, roast, payload }) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('free_verdicts')
    .insert({
      account_id: accountId,
      idea_id: ideaId,
      verdict,
      total_score: totalScore,
      roast,
      payload: payload || {}
    })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') {
      const e = new Error('A free verdict already exists for this account and idea.');
      e.code = 'FREE_VERDICT_EXISTS';
      throw e;
    }
    throw error;
  }
  return data;
}

module.exports = { getFreeVerdict, getLatestFreeVerdictForIdea, createFreeVerdict };
