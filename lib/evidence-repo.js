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
    signal: c.signal || 'neutral',
    // Only demand claims carry a channel (where the demand was observed); other
    // dimensions leave it null. Coerce undefined → null so the column is
    // explicit rather than relying on default absence.
    channel: c.channel || null
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

// Clears an idea's evidence rows for a single dimension. Used by the delta
// re-validation to replace ONLY the stale dimensions it re-gathers, leaving the
// fresh dimensions' rows untouched (so a re-gather that finds nothing does not
// silently erase still-valid evidence — the caller only deletes a dimension it
// successfully refreshed).
async function deleteEvidenceForDimension(ideaId, dimension) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('evidence')
    .delete()
    .eq('idea_id', ideaId)
    .eq('dimension', dimension);
  if (error) throw error;
}

module.exports = { insertEvidence, getEvidenceForIdea, deleteEvidenceForDimension };
