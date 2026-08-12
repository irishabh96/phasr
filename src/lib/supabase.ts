export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export const SUPABASE_CONFIG_ERROR =
  "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Phasr requires Supabase cloud sync metadata.";

// The machine id that used to live here (localStorage "phasr.machine_id")
// is gone: a wiped profile minted a new id and every cloud repository
// pulled down with local_path = NULL. The id is now derived from the
// hardware on the Rust side (sync::effective_machine_id).
