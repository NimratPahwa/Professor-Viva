// Professor Viva — Supabase client (Step 2 of the gap-closure plan)
// Server-side only. SUPABASE_SERVICE_ROLE_KEY bypasses RLS — never expose
// this client or the key to the browser.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client = null;

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.');
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }
    });
  }
  return client;
}

module.exports = { getSupabase };
