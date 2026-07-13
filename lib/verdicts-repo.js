// Professor Viva — verdict persistence (Step 5 of the gap-closure plan).

const { getSupabase } = require('./db');

// Persists the verdict row. voice_pass_output (Step 6) and card_asset_url
// (Step 9) are intentionally left null here — this step only decides and
// records the deterministic verdict + the weighted total that produced it.
async function insertVerdict(ideaId, { verdict, totalScore, thresholdVersion }) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verdicts')
    .insert({
      idea_id: ideaId,
      verdict,
      total_score: totalScore,
      threshold_version: thresholdVersion
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getVerdictForIdea(ideaId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verdicts')
    .select('*')
    .eq('idea_id', ideaId);
  if (error) throw error;
  return data;
}

// The most recent verdict row for an idea. Step 6 renders voice for the verdict
// already decided in Step 5, so it operates on the latest row.
async function getLatestVerdictForIdea(ideaId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verdicts')
    .select('*')
    .eq('idea_id', ideaId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

// Step 6: writes the voice pass onto an existing verdict row. Only the voice
// fields change — verdict, total_score, and threshold_version (Step 5, pure
// code) are never touched here, preserving the two-pass rule (03-AI Rules §5).
// The next_steps array (FR-1.4 / §3.1) is a voice-side field and is written here
// alongside the prose when provided.
async function updateVerdictVoice(verdictId, { voicePassOutput, voicePromptVersion, nextSteps }) {
  const supabase = getSupabase();
  const update = {
    voice_pass_output: voicePassOutput,
    voice_prompt_version: voicePromptVersion
  };
  if (nextSteps !== undefined) update.next_steps = nextSteps;

  const { data, error } = await supabase
    .from('verdicts')
    .update(update)
    .eq('id', verdictId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Step 9: records the shareable verdict card's asset URL on the verdict row.
// Card generation is part of the delivery stage (FR-1.5).
async function updateVerdictCard(verdictId, cardAssetUrl) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('verdicts')
    .update({ card_asset_url: cardAssetUrl })
    .eq('id', verdictId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = {
  insertVerdict,
  getVerdictForIdea,
  getLatestVerdictForIdea,
  updateVerdictVoice,
  updateVerdictCard
};
