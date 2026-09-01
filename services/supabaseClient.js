'use strict';

const config = require('../config/env');

/**
 * Lazily-created Supabase client, shared across the transaction and
 * catalog stores. Returns `false` (not `null`, to distinguish "checked and
 * not configured" from "haven't checked yet") when SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY aren't set - callers (store/*.js) use that to
 * fall back to the in-memory store instead of throwing.
 *
 * The @supabase/supabase-js require() is deliberately inside the function,
 * not at the top of the file - so the app never even loads that package's
 * code path when Supabase isn't configured, keeping the zero-setup
 * in-memory-only case as light as possible.
 */
let client;

function getClient() {
  if (client !== undefined) return client;

  if (!config.supabase.isConfigured) {
    client = false;
    return client;
  }

  // eslint-disable-next-line global-require
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(config.supabase.url, config.supabase.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

module.exports = { getClient };
