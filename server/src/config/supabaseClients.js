import { createClient } from '@supabase/supabase-js';

export function createSupabaseClients({ url, publicKey, serviceKey, fetch }) {
  const options = {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetch ? { global: { fetch } } : {})
  };
  return {
    database: createClient(url, serviceKey || publicKey, options),
    admin: serviceKey ? createClient(url, serviceKey, options) : null,
    // Login stores a session on its client, so never share it with database queries.
    createAuthClient: () => createClient(url, publicKey || serviceKey, options)
  };
}
