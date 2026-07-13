// Professor Viva — scores persistence (Step 4 of the gap-closure plan).

const { getSupabase } = require('./db');

// Persists the per-dimension scores for an idea. The rubric-weighted total is
// NOT stored here — it belongs to the verdict row (Step 5), per the schema in
// Architecture §6 (scores table = per-dimension; verdicts table = total_score).
async function insertScores(ideaId, computed) {
  const supabase = getSupabase();
  const rows = Object.entries(computed.dimensions).map(([dimension, result]) => ({
    idea_id: ideaId,
    dimension,
    score: result.score,
    rubric_version: computed.rubric_version
  }));

  const { data, error } = await supabase.from('scores').insert(rows).select();
  if (error) throw error;
  return data;
}

async function getScoresForIdea(ideaId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('scores')
    .select('*')
    .eq('idea_id', ideaId);
  if (error) throw error;
  return data;
}

module.exports = { insertScores, getScoresForIdea };
