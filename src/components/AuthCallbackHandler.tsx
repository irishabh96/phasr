import { useClerk } from "@clerk/react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef } from "react";
import { CLERK_AUTH_CALLBACK_EVENT } from "@/lib/clerk";
import {
  AUTH_ERROR_CODES,
  AUTH_ERROR_MESSAGES,
  classifyAuthError,
  type AuthErrorCode,
} from "@/lib/authErrorCodes";
import {
  applyClerkHandshakeCookies,
  handshakeCookieValue,
} from "@/lib/clerkHandshake";
import {
  clearDesktopSession,
  createDesktopSessionFromClerk,
  type ClerkDesktopAuthClient,
  syncAndCommitDesktopSession,
} from "@/lib/desktopAuth";
import {
  clearPendingOAuthState,
  validatePendingOAuthState,
} from "@/lib/oauthState";
import { captureAuthException, captureAuthWarning } from "@/lib/sentry";
import { tauri } from "@/lib/tauri";
import { showToast } from "@/lib/toast";

type AuthCallbackPayload = {
  url: string;
};

function showAuthErrorToast(errorCode: AuthErrorCode) {
  showToast({
    intent: "error",
    title: "Login failed",
    message: AUTH_ERROR_MESSAGES[errorCode],
    code: errorCode,
  });
}

export function AuthCallbackHandler() {
  const clerk = useClerk();
  const processingCallbacks = useRef(new Set<string>());
  const pendingCallback = useRef<string | null>(null);

  const activateCallback = useCallback((callbackUrl: string) => {
    if (!clerk.loaded || !clerk.client) {
      pendingCallback.current = callbackUrl;
      return;
    }

    if (processingCallbacks.current.has(callbackUrl)) return;
    processingCallbacks.current.add(callbackUrl);

    void (async () => {
      let expectedCookieNames: string[] = [];
      let phasrState: string | null = null;
      let storedCookieNames: string[] = [];

      try {
        const callback = new URL(callbackUrl);
        phasrState = callback.searchParams.get("phasr_state");
        const stateValidation = validatePendingOAuthState(phasrState);
        if (!stateValidation.ok) {
          const errorCode = AUTH_ERROR_CODES.OAUTH_STATE_INVALID;
          captureAuthWarning("Rejected Clerk browser callback with invalid Phasr state", {
            callbackKind: "oauth_state",
            errorCode,
            hasPhasrState: Boolean(phasrState),
            reason: stateValidation.reason,
            origin: window.location.origin,
            protocol: window.location.protocol,
          });
          showAuthErrorToast(errorCode);
          return;
        }

        const handshake = callback.searchParams.get("__clerk_handshake");
        if (!handshake) {
          throw new Error("Clerk browser callback did not include Clerk login data.");
        }

        const result = applyClerkHandshakeCookies(handshake);
        expectedCookieNames = result.cookies.map((cookie) => cookie.name);
        storedCookieNames = result.storedCookieNames;

        if (storedCookieNames.length !== expectedCookieNames.length) {
          captureAuthWarning("Clerk handshake cookies were not persisted", {
            callbackKind: "clerk_handshake",
            errorCode: AUTH_ERROR_CODES.HANDSHAKE_COOKIE_WRITE_FAILED,
            origin: window.location.origin,
            protocol: window.location.protocol,
            expectedCookieNames,
            storedCookieNames,
          });
        }

        if (!handshakeCookieValue(result.cookies, "__session")) {
          throw new Error("Clerk handshake did not include a session token.");
        }

        const session = await createDesktopSessionFromClerk(
          clerk as ClerkDesktopAuthClient,
        );
        await syncAndCommitDesktopSession(session);
        clearPendingOAuthState(stateValidation.state.state);
        window.location.replace("/");
      } catch (error) {
        clearDesktopSession();
        void tauri.clearSession().catch(() => {});
        const errorCode = classifyAuthError(
          error,
          AUTH_ERROR_CODES.UNKNOWN_CALLBACK_ERROR,
        );
        captureAuthException(error, {
          callbackKind: "clerk_handshake",
          errorCode,
          hasPhasrState: Boolean(phasrState),
          origin: window.location.origin,
          protocol: window.location.protocol,
          expectedCookieNames,
          storedCookieNames,
        });
        showAuthErrorToast(errorCode);
      } finally {
        processingCallbacks.current.delete(callbackUrl);
      }
    })();
  }, [clerk]);

  useEffect(() => {
    if (!clerk.loaded || !clerk.client || !pendingCallback.current) return;

    const callbackUrl = pendingCallback.current;
    pendingCallback.current = null;
    activateCallback(callbackUrl);
  }, [activateCallback, clerk.client, clerk.loaded]);

  useEffect(() => {
    let isMounted = true;

    void tauri
      .consumePendingAuthCallback()
      .then((callbackUrl) => {
        if (!isMounted || !callbackUrl) return;
        activateCallback(callbackUrl);
      })
      .catch((error: unknown) => {
        const errorCode = AUTH_ERROR_CODES.CALLBACK_CONSUME_FAILED;
        captureAuthException(error, {
          callbackKind: "consume_pending_callback",
          errorCode,
          origin: window.location.origin,
          protocol: window.location.protocol,
        });
        showAuthErrorToast(errorCode);
      });

    const unlisten = listen<AuthCallbackPayload>(
      CLERK_AUTH_CALLBACK_EVENT,
      (event) => {
        void tauri
          .consumePendingAuthCallback()
          .catch((error: unknown) => {
            const errorCode = AUTH_ERROR_CODES.CALLBACK_CLEAR_FAILED;
            captureAuthException(error, {
              callbackKind: "clear_pending_callback",
              errorCode,
              origin: window.location.origin,
              protocol: window.location.protocol,
            });
            showAuthErrorToast(errorCode);
          })
          .finally(() => activateCallback(event.payload.url));
      },
    );

    return () => {
      isMounted = false;
      void unlisten.then((dispose) => dispose());
    };
  }, [activateCallback]);

  return null;
}
