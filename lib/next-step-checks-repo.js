// Professor Viva — persisted next-step checkbox state (The Professor's Stage,
// Screen 5). Reads/writes the per-user checked-state for the unlocked report's
// next steps. Pure persistence — no verdict/score logic here.

const { getSupabase } = require('./db');

// All checked-states for one (account, verdict), as a { [step_index]: boolean }
// map the report renders directly. Absent steps default unchecked client-side.
async function getChecks(accountId, verdictId) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('next_step_checks')
    .select('step_index, checked')
    .eq('account_id', accountId)
    .eq('verdict_id', verdictId);
  if (error) throw error;
  const map = {};
  for (const row of data) map[row.step_index] = row.checked;
  return map;
}

// Idempotent upsert of one step's checked-state (unique on
// account_id+verdict_id+step_index — a re-check is a no-op update).
async function setCheck(accountId, verdictId, stepIndex, checked) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('next_step_checks')
    .upsert(
      { account_id: accountId, verdict_id: verdictId, step_index: stepIndex, checked, updated_at: new Date().toISOString() },
      { onConflict: 'account_id,verdict_id,step_index' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

module.exports = { getChecks, setCheck };
