// Professor Viva — lightweight account persistence (Step 11.5, FR-1.12).
//
// A lightweight account identifies the user so the one-free-verdict-per-idea
// rule (FR-1.9) and the unlock entitlement (FR-1.10, reusing the Step-11 ledger)
// are enforced per account. There is no auth yet — the account is keyed by a
// stable `external_ref` (email, anon token, or handle) the caller supplies.

const { getSupabase } = require('./db');

// Idempotent: returns the existing account for this external_ref, or creates it.
// A concurrent double-insert is resolved by re-reading on the unique-violation.
async function findOrCreateAccount(externalRef) {
  const ref = String(externalRef || '').trim();
  if (!ref) {
    const e = new Error('account external_ref is required');
    e.code = 'ACCOUNT_REF_REQUIRED';
    throw e;
  }

  const supabase = getSupabase();

  const existing = await getAccountByRef(ref);
  if (existing) return existing;

  const { data, error } = await supabase
    .from('accounts')
    .insert({ external_ref: ref })
    .select()
    .single();

  if (error) {
    // Lost a race — the row now exists; read it back.
    const raced = await getAccountByRef(ref);
    if (raced) return raced;
    throw error;
  }
  return data;
}

async function getAccountByRef(externalRef) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('external_ref', String(externalRef || '').trim())
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

async function getAccountById(id) {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', id)
    .limit(1);
  if (error) throw error;
  return data && data.length ? data[0] : null;
}

module.exports = { findOrCreateAccount, getAccountByRef, getAccountById };
