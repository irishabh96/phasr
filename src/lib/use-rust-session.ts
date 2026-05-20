import { useAuth } from "@clerk/react";
import { useEffect, useRef } from "react";
import { isClerkConfigured } from "./clerk";
import { tauri } from "./tauri";

/**
 * Keeps the Rust side's session state in lockstep with Clerk's auth state.
 *
 * - When the user signs in, fetches a JWT and calls `set_session` so
 *   protected Tauri commands accept calls from this app.
 * - When the user signs out, calls `clear_session`.
 * - Refreshes the token every 45 seconds while signed in (Clerk JWTs
 *   default to a 60-second lifetime).
 *
 * In local-only mode (no Clerk configured), this hook is a no-op —
 * `useAuth()` is never called (it would throw without a ClerkProvider).
 */
export function useRustSession() {
  if (!isClerkConfigured) {
    return;
  }
  return useRustSessionInner();
}

function useRustSessionInner() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isLoaded) return;

    let cancelled = false;

    const syncToken = async () => {
      try {
        const token = await getToken();
        if (cancelled) return;
        if (token) {
          await tauri.setSession(token);
        } else {
          await tauri.clearSession();
        }
      } catch (err) {
        console.error("Failed to sync Rust session", err);
      }
    };

    if (isSignedIn) {
      void syncToken();
      intervalRef.current = setInterval(syncToken, 45_000);
    } else {
      void tauri.clearSession();
    }

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isLoaded, isSignedIn, getToken]);
}
