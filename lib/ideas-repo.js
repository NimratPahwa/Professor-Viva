// Professor Viva — ideas persistence (Step 2 of the gap-closure plan)

const { getSupabase } = require('./db');

async function createIdea(payload) {
  const supabase = getSupabase();
  const row = {
    problem: payload.problem.trim(),
    audience: payload.audience.trim(),
    monetization_hypothesis: payload.monetization_hypothesis.trim(),
    unfair_advantage: payload.unfair_advantage.trim(),
    clarifying_questions: payload.clarifying_questions || []
  };
  // Lightweight account link (Step 11.5, FR-1.12) — optional so the ungated
  // test/batch paths and pre-accounts ideas still work.
  if (payload.account_id) row.account_id = payload.account_id;

  const { data, error } = await supabase
    .from('ideas')
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getIdeaById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ideas')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return null;
  return data;
}

async function updateIdeaStatus(id, status) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('ideas')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

module.exports = { createIdea, getIdeaById, updateIdeaStatus };
