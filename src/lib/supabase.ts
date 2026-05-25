export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as
  | string
  | undefined;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export const SUPABASE_CONFIG_ERROR =
  "Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Phasr requires Supabase cloud sync metadata.";

const MACHINE_ID_KEY = "phasr.machine_id";

/**
 * Stable per-install identifier used to scope local-clone paths in
 * the cloud `workspaces.local_paths` map. Currently lives in
 * localStorage; we'll upgrade to the OS keychain in Phase 7.
 */
export function getMachineId(): string {
  let id = localStorage.getItem(MACHINE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(MACHINE_ID_KEY, id);
  }
  return id;
}
