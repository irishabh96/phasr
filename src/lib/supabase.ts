import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/**
 * Creates a Supabase client bound to a Clerk JWT provider. The
 * `accessToken` callback is invoked for every request, so Clerk's
 * own refresh logic keeps the token fresh — we never cache a
 * specific JWT here.
 *
 * RLS in the Phasr schema enforces `user_id = auth.jwt() ->> 'sub'`
 * per table, so the JWT itself is the access boundary.
 */
export function createPhasrSupabase(
  getToken: () => Promise<string | null>,
): SupabaseClient {
  if (!isSupabaseConfigured) {
    throw new Error(
      "Supabase env vars are missing. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local.",
    );
  }
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    accessToken: async () => (await getToken()) ?? "",
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    realtime: {
      params: { eventsPerSecond: 5 },
    },
  });
}

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
