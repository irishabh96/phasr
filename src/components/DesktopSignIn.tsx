import { useClerk } from "@clerk/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Github, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Navigate } from "@tanstack/react-router";
import {
  type ClerkOAuthProvider,
  clerkDesktopCallbackUrl,
  clerkOAuthStrategy,
} from "@/lib/clerk";
import { onDesktopSessionChanged, readDesktopSession } from "@/lib/desktopAuth";
import {
  AUTH_ERROR_CODES,
  AUTH_ERROR_MESSAGES,
  classifyAuthError,
} from "@/lib/authErrorCodes";
import {
  clearPendingOAuthState,
  createPendingOAuthState,
} from "@/lib/oauthState";
import { reportP0Error } from "@/lib/sentry";
import { showToast } from "@/lib/toast";

type LoginState =
  | { kind: "idle" }
  | { kind: "opening"; provider: ClerkOAuthProvider }
  | { kind: "waiting"; provider: ClerkOAuthProvider }
  | { kind: "finishing" };

const PROVIDER_LABELS: Record<ClerkOAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
};

function isProviderBusy(state: LoginState, provider: ClerkOAuthProvider) {
  return (
    (state.kind === "opening" || state.kind === "waiting") &&
    state.provider === provider
  );
}

export function DesktopSignIn() {
  const clerk = useClerk();
  const [loginState, setLoginState] = useState<LoginState>({ kind: "idle" });
  const [hasDesktopSession, setHasDesktopSession] = useState(() =>
    Boolean(readDesktopSession()),
  );

  useEffect(
    () =>
      onDesktopSessionChanged(() =>
        setHasDesktopSession(Boolean(readDesktopSession())),
      ),
    [],
  );

  if (hasDesktopSession) {
    return <Navigate to="/" replace />;
  }

  const startOAuth = async (provider: ClerkOAuthProvider) => {
    if (!clerk.loaded || !clerk.client) return;

    setLoginState({ kind: "opening", provider });

    try {
      const oauthState = createPendingOAuthState(provider);
      const callbackUrl = clerkDesktopCallbackUrl(oauthState.state);
      const signInAttempt = await clerk.client.signIn.create({
        strategy: clerkOAuthStrategy(provider),
        redirectUrl: callbackUrl,
        actionCompleteRedirectUrl: callbackUrl,
        signUpIfMissing: true,
      });
      const verificationUrl =
        signInAttempt.firstFactorVerification.externalVerificationRedirectURL;

      if (!verificationUrl) {
        throw new Error(
          `${PROVIDER_LABELS[provider]} login is not enabled in Clerk.`,
        );
      }

      await openUrl(verificationUrl.toString());
      setLoginState({ kind: "waiting", provider });
    } catch (error) {
      clearPendingOAuthState();
      const errorCode = classifyAuthError(
        error,
        AUTH_ERROR_CODES.OAUTH_OPEN_FAILED,
      );
      reportP0Error("OAuth login failed", error, {
        area: "auth",
        operation: "oauth_start",
        errorCode,
        provider,
      });
      showToast({
        intent: "error",
        title: "Login failed",
        message: AUTH_ERROR_MESSAGES[errorCode],
        code: errorCode,
      });
      setLoginState({ kind: "idle" });
    }
  };

  const disabled =
    !clerk.loaded ||
    !clerk.client ||
    loginState.kind === "finishing";

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--color-bg-base) px-6 text-(--color-text-primary)">
      <section className="w-full max-w-[380px] rounded-lg border border-(--color-border-subtle) bg-(--color-bg-surface) p-6 shadow-xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-(--color-accent-600) text-sm font-semibold text-white">
            P
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">
              Sign in to Phasr
            </h1>
            <p className="mt-1 text-sm text-(--color-text-secondary)">
              Continue with your workspace account.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <OAuthButton
            disabled={disabled}
            loading={isProviderBusy(loginState, "google")}
            label="Continue with Google"
            onClick={() => void startOAuth("google")}
            icon={<span className="text-sm font-semibold">G</span>}
          />
          <OAuthButton
            disabled={disabled}
            loading={isProviderBusy(loginState, "github")}
            label="Continue with GitHub"
            onClick={() => void startOAuth("github")}
            icon={<Github className="size-4" aria-hidden="true" />}
          />
        </div>

        {loginState.kind === "waiting" ? (
          <p className="mt-4 text-sm text-(--color-text-secondary)">
            Complete {PROVIDER_LABELS[loginState.provider]} login in your
            browser, then return here.
          </p>
        ) : null}
        {loginState.kind === "finishing" ? (
          <p className="mt-4 text-sm text-(--color-text-secondary)">
            Completing login…
          </p>
        ) : null}
      </section>
    </div>
  );
}

function OAuthButton({
  disabled,
  icon,
  label,
  loading,
  onClick,
}: {
  disabled: boolean;
  icon: ReactNode;
  label: string;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      onClick={onClick}
      className="flex h-12 w-full items-center justify-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-(--color-text-primary) transition hover:border-(--color-border-strong) hover:bg-(--color-bg-hover) disabled:cursor-not-allowed disabled:opacity-60"
      style={{
        background: "var(--color-bg-input)",
        border: "1px solid var(--color-border-subtle)",
      }}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      <span>{label}</span>
    </button>
  );
}
