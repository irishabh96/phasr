import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers around Tauri commands. Components must never call
 * `invoke()` directly — go through these helpers so the contract stays
 * type-safe and discoverable.
 */
export const tauri = {
  setSession: (jwt: string) => invoke<string>("set_session", { jwt }),
  clearSession: () => invoke<void>("clear_session"),
  currentUserId: () => invoke<string | null>("current_user_id"),
};
