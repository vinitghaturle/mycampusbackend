const { createClient } = require("@supabase/supabase-js");

let supabaseAdmin = null;

if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE) {
  supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE,
    { auth: { persistSession: false } }
  );
}

module.exports = { supabaseAdmin };
