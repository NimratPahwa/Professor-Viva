// Professor Viva — evidence persistence (Step 3 of the gap-closure plan)

const { getSupabase } = require('./db');

async function insertEvidence(ideaId, dimension, claims) {
  if (claims.length === 0) return [];

  const supabase = getSupabase();
  const rows = claims.map((c) => ({
    idea_id: ideaId,
    dimension,
    claim: c.claim,
    source_url: c.source_url,
    signal: c.signal || 'neutral'
  }));

  const { data, error } = await supabase.from('evidence').insert(rows).select();
  if (error) throw error;
  return data;
}

async function getEvidenceForIdea(ideaId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('evidence')
    .select('*')
    .eq('idea_id', ideaId);
  if (error) throw error;
  return data;
}

module.exports = { insertEvidence, getEvidenceForIdea };
