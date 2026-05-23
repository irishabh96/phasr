import { useAuth } from "@clerk/react";
import { useEffect, useRef, useState } from "react";
import {
  SUPABASE_ANON_KEY,
  SUPABASE_URL,
  isSupabaseConfigured,
} from "./supabase";
import { getMachineId } from "./supabase";
import { tauri } from "./tauri";

type RustSessionState =
  | { state: "loading" }
  | { state: "signedOut" }
  | { state: "ready"; userId: string }
  | { state: "error"; message: string };

/**
 * Keeps Rust's auth gate and cloud-sync worker in lockstep with Clerk.
 * The app shell is not rendered until `set_session` verifies the JWT.
 */
export function useRustSession(): RustSessionState {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const [state, setState] = useState<RustSessionState>({ state: "loading" });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      setState({ state: "loading" });
      return;
    }

    let cancelled = false;

    const clearRustSession = async () => {
      await tauri.stopCloudSync().catch(() => {});
      await tauri.clearSession().catch(() => {});
      if (!cancelled) setState({ state: "signedOut" });
    };

    const syncToken = async () => {
      try {
        if (!isSupabaseConfigured) {
          throw new Error("Supabase configuration is missing.");
        }
        const token = await getToken();
        if (cancelled) return;
        if (!token) {
          await clearRustSession();
          return;
        }
        const userId = await tauri.setSession(token);
        await tauri.startCloudSync({
          supabaseUrl: SUPABASE_URL!,
          supabaseAnonKey: SUPABASE_ANON_KEY!,
          machineId: getMachineId(),
        });
        if (!cancelled) setState({ state: "ready", userId });
      } catch (err) {
        console.error("Failed to sync Rust session", err);
        if (!cancelled) {
          setState({
            state: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    if (isSignedIn) {
      setState({ state: "loading" });
      void syncToken();
      intervalRef.current = setInterval(syncToken, 45_000);
    } else {
      void clearRustSession();
    }

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [isLoaded, isSignedIn, getToken]);

  return state;
}
