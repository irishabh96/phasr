import { useClerk } from "@clerk/react";
import { useEffect, useRef, useState } from "react";
import {
  type ClerkDesktopAuthClient,
  clearDesktopSession,
  commitDesktopSession,
  desktopSessionKey,
  desktopSessionRefreshState,
  onDesktopSessionChanged,
  readDesktopSession,
  refreshDesktopSessionFromClerk,
  syncRustSession,
} from "./desktopAuth";
import {
  AUTH_ERROR_CODES,
  AUTH_ERROR_MESSAGES,
  type AuthErrorCode,
  classifyAuthError,
} from "./authErrorCodes";
import { queryClient } from "./query";
import { reportP0Error } from "./sentry";
import { useUiStore } from "./store";
import { isSupabaseConfigured } from "./supabase";
import { tauri } from "./tauri";
import { showToast } from "./toast";

/**
 * Drop all of the previous account's in-memory state when the signed-in
 * identity changes (or on sign-out). The local DB reads are user-scoped,
 * but the React Query cache + UI tab store would otherwise keep showing
 * the prior account's repositories/tabs until a refetch lands.
 */
function clearAccountScopedState() {
  queryClient.clear();
  useUiStore.getState().resetForAccountSwitch();
}

type RustSessionState =
  | { state: "loading" }
  | { state: "signedOut" }
  | { state: "ready"; userId: string }
  | { state: "error"; message: string };

const CLERK_READY_TIMEOUT_MS = 8_000;
const CLERK_REFRESH_TIMEOUT_MS = 5_000;
const RUST_SESSION_SYNC_TIMEOUT_MS = 12_000;
const SIGN_OUT_CLEANUP_TIMEOUT_MS = 2_000;
const DESKTOP_SESSION_SYNC_INTERVAL_MS = 60 * 60 * 1000;

type SessionCandidate = {
  session: NonNullable<ReturnType<typeof readDesktopSession>>;
  shouldCommit: boolean;
};

function authTimeoutError(code: AuthErrorCode, message: string) {
  return new Error(`${code}: ${message}`);
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  code: AuthErrorCode,
  message: string,
) {
  let timeoutId: number | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => {
      reject(authTimeoutError(code, message));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
  });
}

/**
 * Keeps Rust's auth gate and cloud-sync worker in lockstep with the
 * desktop session extracted from Clerk's deep-link handshake.
 * The app shell is not rendered until `set_session` verifies the JWT.
 */
export function useRustSession(): RustSessionState {
  const clerk = useClerk();
  const [state, setState] = useState<RustSessionState>({ state: "loading" });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSessionKeyRef = useRef<string | null>(null);
  // The last account we became "ready" for, so we can detect a switch to
  // a different account and purge the prior one's cached data.
  const lastReadyUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const clearAuthState = () => {
      lastSessionKeyRef.current = null;
      if (lastReadyUserIdRef.current !== null) {
        clearAccountScopedState();
        lastReadyUserIdRef.current = null;
      }
      clearDesktopSession({ emitChange: false });
      void withTimeout(
        tauri.stopCloudSync().catch(() => {}),
        SIGN_OUT_CLEANUP_TIMEOUT_MS,
        AUTH_ERROR_CODES.BOOTSTRAP_TIMEOUT,
        "Timed out stopping cloud sync during sign-out cleanup.",
      ).catch(() => {});
      void withTimeout(
        tauri.clearSession().catch(() => {}),
        SIGN_OUT_CLEANUP_TIMEOUT_MS,
        AUTH_ERROR_CODES.BOOTSTRAP_TIMEOUT,
        "Timed out clearing the Rust session during sign-out cleanup.",
      ).catch(() => {});
      if (!cancelled) setState({ state: "signedOut" });
    };

    const refreshSession = async () =>
      withTimeout(
        refreshDesktopSessionFromClerk(clerk as ClerkDesktopAuthClient),
        CLERK_REFRESH_TIMEOUT_MS,
        AUTH_ERROR_CODES.BOOTSTRAP_TIMEOUT,
        "Timed out refreshing the Clerk desktop session.",
      );

    const readOrRefreshSession = async (): Promise<SessionCandidate | null> => {
      const storedSession = readDesktopSession({ allowExpired: true });
      if (!storedSession) return null;

      const refreshState = desktopSessionRefreshState(storedSession);
      if (
        refreshState === "expired" &&
        !clerk.loaded
      ) {
        await delay(CLERK_READY_TIMEOUT_MS);
        if (cancelled) return null;
        if (!clerk.loaded) {
          throw authTimeoutError(
            AUTH_ERROR_CODES.CLERK_READY_TIMEOUT,
            "Clerk did not become ready before the saved desktop session expired.",
          );
        }
      }

      if (refreshState === "fresh") {
        return { session: storedSession, shouldCommit: false };
      }

      if (refreshState === "refresh") {
        try {
          const refreshedSession = clerk.loaded ? await refreshSession() : null;
          if (cancelled) return null;
          if (refreshedSession) {
            return { session: refreshedSession, shouldCommit: true };
          }
        } catch (error) {
          reportP0Error("Failed to refresh desktop session; using stored token", error, {
            area: "auth",
            operation: "desktop_session_refresh",
            errorCode: classifyAuthError(error, AUTH_ERROR_CODES.BOOTSTRAP_TIMEOUT),
            refreshState,
            fallbackToStoredSession: true,
          });
        }
        return { session: storedSession, shouldCommit: false };
      }

      const refreshedSession = clerk.loaded ? await refreshSession() : null;
      if (cancelled) return null;
      if (refreshedSession) return { session: refreshedSession, shouldCommit: true };

      return null;
    };

    const syncSession = async (session: SessionCandidate["session"]) => {
      const syncPromise = syncRustSession(session);
      try {
        await withTimeout(
          syncPromise,
          RUST_SESSION_SYNC_TIMEOUT_MS,
          AUTH_ERROR_CODES.BOOTSTRAP_TIMEOUT,
          "Timed out applying the desktop session to Rust.",
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes(AUTH_ERROR_CODES.BOOTSTRAP_TIMEOUT)
        ) {
          void syncPromise.finally(() => {
            void tauri.stopCloudSync().catch(() => {});
            void tauri.clearSession().catch(() => {});
          }).catch(() => {});
        }
        throw error;
      }
    };

    const syncToken = async () => {
      try {
        if (!isSupabaseConfigured) {
          throw new Error("Supabase configuration is missing.");
        }
        const nextSession = await readOrRefreshSession();
        if (cancelled) return;
        if (!nextSession) {
          clearAuthState();
          return;
        }
        const { session, shouldCommit } = nextSession;
        await syncSession(session);
        if (cancelled) return;
        if (shouldCommit) {
          commitDesktopSession(session, { emitChange: false });
        }
        lastSessionKeyRef.current = desktopSessionKey(session);
        // Switched to a different account on this machine — purge the
        // previous account's cached repos/tabs so they don't leak through.
        if (
          lastReadyUserIdRef.current !== null &&
          lastReadyUserIdRef.current !== session.userId
        ) {
          clearAccountScopedState();
        }
        lastReadyUserIdRef.current = session.userId;
        if (!cancelled) setState({ state: "ready", userId: session.userId });
      } catch (err) {
        if (cancelled) return;
        const errorCode = classifyAuthError(
          err,
          AUTH_ERROR_CODES.RUST_SESSION_SYNC_FAILED,
        );
        reportP0Error("Failed to sync Rust session", err, {
          area: "auth",
          operation: "rust_session_sync",
          errorCode,
          hasDesktopSession: Boolean(readDesktopSession({ allowExpired: true })),
          supabaseConfigured: isSupabaseConfigured,
        });
        showToast({
          intent: "error",
          title: "Session failed",
          message: AUTH_ERROR_MESSAGES[errorCode],
          code: errorCode,
        });
        clearAuthState();
      }
    };

    if (!clerk.loaded) {
      const storedSession = readDesktopSession({ allowExpired: true });
      if (!storedSession) {
        clearAuthState();
        return () => {
          cancelled = true;
        };
      }
    }

    setState({ state: "loading" });
    void syncToken();
    intervalRef.current = setInterval(syncToken, DESKTOP_SESSION_SYNC_INTERVAL_MS);
    const dispose = onDesktopSessionChanged(() => {
      const nextSessionKey = desktopSessionKey(
        readDesktopSession({ allowExpired: true }),
      );
      if (nextSessionKey === lastSessionKeyRef.current) return;
      setState({ state: "loading" });
      void syncToken();
    });

    return () => {
      cancelled = true;
      dispose();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [clerk]);

  return state;
}
