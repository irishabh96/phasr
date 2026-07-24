import { useClerk } from "@clerk/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Navigate } from "@tanstack/react-router";
import {
  type ClerkOAuthProvider,
  clerkDesktopCallbackUrl,
  clerkOAuthStrategy,
} from "@/lib/clerk";
import {
  type ClerkDesktopAuthClient,
  createDesktopSessionFromClerk,
  onDesktopSessionChanged,
  readDesktopSession,
  syncAndCommitDesktopSession,
} from "@/lib/desktopAuth";
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
import { GlassButton } from "@/components/ui/GlassButton";

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

function hasActiveClerkSession(clerk: ClerkDesktopAuthClient) {
  return Boolean(clerk.session || clerk.client?.signedInSessions?.[0]);
}

function isClerkSessionExistsError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeError = error as {
    code?: unknown;
    errors?: Array<{ code?: unknown }>;
  };

  if (maybeError.code === "session_exists") {
    return true;
  }

  return (
    maybeError.errors?.some((entry) => entry.code === "session_exists") ?? false
  );
}

export function DesktopSignIn() {
  const clerk = useClerk();
  const [loginState, setLoginState] = useState<LoginState>({ kind: "idle" });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
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

  // Abandon a pending browser-based sign-in and return to the button list
  // so the user isn't stranded on the "waiting" copy (I4).
  const cancelWaiting = () => {
    clearPendingOAuthState();
    setErrorMessage(null);
    setLoginState({ kind: "idle" });
  };

  const startOAuth = async (provider: ClerkOAuthProvider) => {
    if (!clerk.loaded || !clerk.client) return;

    setErrorMessage(null);
    setLoginState({ kind: "opening", provider });

    const completeExistingSession = async () => {
      setLoginState({ kind: "finishing" });
      clearPendingOAuthState();
      const session = await createDesktopSessionFromClerk(
        clerk as ClerkDesktopAuthClient,
      );
      await syncAndCommitDesktopSession(session);
      setHasDesktopSession(true);
    };

    const handleExistingSessionFailure = (sessionError: unknown) => {
      clearPendingOAuthState();
      const errorCode = classifyAuthError(
        sessionError,
        AUTH_ERROR_CODES.DESKTOP_SESSION_NOT_ACTIVATED,
      );
      reportP0Error("Existing Clerk session activation failed", sessionError, {
        area: "auth",
        operation: "desktop_session_recovery",
        errorCode,
        provider,
      });
      showToast({
        intent: "error",
        title: "Login failed",
        message: AUTH_ERROR_MESSAGES[errorCode],
        code: errorCode,
      });
      setErrorMessage(AUTH_ERROR_MESSAGES[errorCode]);
      setLoginState({ kind: "idle" });
    };

    try {
      if (hasActiveClerkSession(clerk as ClerkDesktopAuthClient)) {
        try {
          await completeExistingSession();
        } catch (sessionError) {
          handleExistingSessionFailure(sessionError);
        }
        return;
      }

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
      if (isClerkSessionExistsError(error)) {
        try {
          await completeExistingSession();
          return;
        } catch (sessionError) {
          handleExistingSessionFailure(sessionError);
          return;
        }
      }

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
      setErrorMessage(AUTH_ERROR_MESSAGES[errorCode]);
      setLoginState({ kind: "idle" });
    }
  };

  const disabled =
    !clerk.loaded || !clerk.client || loginState.kind === "finishing";

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--color-bg-base) px-6 text-(--color-text-primary)">
      <section className="w-full max-w-[440px] rounded-(--radius-modal) border border-(--color-border-subtle) bg-(--color-bg-surface) p-6">
        <div className="mb-6 text-center">
          <PhasrWordmark />
          <h1 className="text-[1.25rem] font-semibold leading-tight">
            Welcome to Phasr
          </h1>
          <p className="mt-1 text-[0.875rem] text-(--color-text-secondary)">
            Sign in to get started
          </p>
        </div>

        <div className="space-y-3">
          <OAuthButton
            autoFocus
            disabled={disabled}
            loading={isProviderBusy(loginState, "google")}
            label="Continue with Google"
            onClick={() => void startOAuth("google")}
            icon={<GoogleIcon />}
          />
          <OAuthButton
            disabled={disabled}
            loading={isProviderBusy(loginState, "github")}
            label="Continue with GitHub"
            onClick={() => void startOAuth("github")}
            icon={<GitHubIcon />}
          />
        </div>

        {errorMessage ? (
          <p role="alert" className="mt-4 text-sm text-(--color-danger)">
            {errorMessage}
          </p>
        ) : null}

        {loginState.kind === "waiting" ? (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-(--color-text-secondary)">
              Complete {PROVIDER_LABELS[loginState.provider]} login in your
              browser, then return here.
            </p>
            <GlassButton variant="ghost" size="sm" onClick={cancelWaiting}>
              Cancel
            </GlassButton>
          </div>
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
  autoFocus,
  disabled,
  icon,
  label,
  loading,
  onClick,
}: {
  autoFocus?: boolean;
  disabled: boolean;
  icon: ReactNode;
  label: string;
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <GlassButton
      variant="outline"
      size="lg"
      type="button"
      autoFocus={autoFocus}
      disabled={disabled || loading}
      onClick={onClick}
      className="w-full gap-3"
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      ) : (
        icon
      )}
      <span>{label}</span>
    </GlassButton>
  );
}

function PhasrWordmark() {
  return (
    <svg
      viewBox="300 360 880 270"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="mx-auto mb-6 h-[78px] w-80 text-(--color-text-primary)"
      aria-hidden="true"
    >
      <path
        d="M700.672 393.279C725.217 392.664 752.062 393.257 776.791 393.261L810.935 429.865L810.97 598.805C798.469 598.82 775.519 597.98 764.29 599.15V556.172L764.339 545.077C751.542 545.092 724.436 545.977 712.582 544.874L712.666 598.85C697.235 598.61 681.331 598.82 665.863 598.812C665.343 580.628 665.816 560.05 665.82 541.648L665.844 430.576C677.539 418.234 689.148 405.802 700.672 393.279ZM712.828 498.183L764.17 498.22C764.205 481.484 763.973 463.959 764.283 447.29L712.561 447.26C712.589 462.016 711.991 483.802 712.828 498.183Z"
        fill="currentColor"
      />
      <path
        d="M995.646 393.249L1108.5 393.234C1118.52 403.661 1128.4 414.237 1138.14 424.958C1138.77 451.514 1138.25 480.606 1138.26 507.305C1130.39 515.572 1122.42 523.726 1114.34 531.761C1125.12 553.456 1137.63 577.207 1147.75 598.91C1139.22 598.43 1126.34 598.812 1117.52 598.812C1110.94 598.775 1104.36 598.842 1097.78 599.015C1089.07 579.848 1078.72 559.315 1069.52 540.253L1042.87 540.426V598.887C1029.22 598.145 1009.88 598.79 995.772 598.782L995.646 393.249ZM1042.86 488.325C1052.2 488.175 1084.35 488.941 1091.67 487.943C1092.56 486.472 1092.38 485.812 1092.34 484.064C1092.37 471.116 1092.3 457.95 1092.48 445.017C1079.55 445.377 1055.4 446.105 1042.84 445.212L1042.86 488.325Z"
        fill="currentColor"
      />
      {/* One coral accent — the leading "p" — ties the wordmark to phasr's
          accent system. `--color-accent-text` clears AA-large on the sign-in
          surface in both themes (vivid accent-500 fails on white). */}
      <path
        d="M331.355 393.239L444.989 393.285L473.782 424.062C474.872 448.791 473.966 482.091 473.967 507.282L443.07 540.238L418.788 540.268L374.971 540.261C374.907 559.773 374.978 579.278 375.184 598.79C367.95 598.782 337.261 598.235 331.421 599.315C330.521 531.701 331.106 460.996 331.355 393.239ZM375.203 486.307L428.276 486.277C428.261 472.541 428.01 457.935 428.295 444.275C411.106 444.267 392.059 444.702 375.024 444.14C375.008 457.575 374.67 473.037 375.203 486.307Z"
        style={{ fill: "var(--color-accent-text)" }}
      />
      <path
        d="M496.032 393.249H540.082L540.139 472.144C557.944 471.566 577.592 472.016 595.533 472.039L595.512 393.226L641.348 393.255C640.886 415.942 641.3 440.246 641.3 463.074L641.303 598.82L624.804 598.835L595.602 598.82C595.314 573.441 595.58 547.5 595.592 522.076C578.085 521.626 557.594 521.761 540.086 522.129L540.138 598.865C532.023 598.805 502.184 598.19 496.159 599.315C496.259 591.22 496.218 582.991 496.154 574.889C495.679 514.372 496.646 453.749 496.032 393.249Z"
        fill="currentColor"
      />
      <path
        d="M861.068 393.243L968.801 393.222C967.795 407.256 968.435 429.814 968.864 444.29L877.57 444.38L877.662 474.222L945.97 474.319L974.011 504.889L974.13 569.81C967.268 578.017 954.288 590.83 946.68 598.827L937.519 598.812L866.63 598.805C857.461 598.797 839.397 598.22 831.22 599.255L831.276 552.256L930.276 552.248L930.248 519.248L859.444 519.3C850.957 510.276 838.673 498.1 831.171 488.79L831.276 425.059C840.22 414.811 851.639 403.278 861.068 393.243Z"
        fill="currentColor"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg
      stroke="currentColor"
      fill="currentColor"
      strokeWidth="0"
      viewBox="0 0 496 512"
      className="size-5"
      height="1em"
      width="1em"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M165.9 397.4c0 2-2.3 3.6-5.2 3.6-3.3.3-5.6-1.3-5.6-3.6 0-2 2.3-3.6 5.2-3.6 3-.3 5.6 1.3 5.6 3.6zm-31.1-4.5c-.7 2 1.3 4.3 4.3 4.9 2.6 1 5.6 0 6.2-2s-1.3-4.3-4.3-5.2c-2.6-.7-5.5.3-6.2 2.3zm44.2-1.7c-2.9.7-4.9 2.6-4.6 4.9.3 2 2.9 3.3 5.9 2.6 2.9-.7 4.9-2.6 4.6-4.6-.3-1.9-3-3.2-5.9-2.9zM244.8 8C106.1 8 0 113.3 0 252c0 110.9 69.8 205.8 169.5 239.2 12.8 2.3 17.3-5.6 17.3-12.1 0-6.2-.3-40.4-.3-61.4 0 0-70 15-84.7-29.8 0 0-11.4-29.1-27.8-36.6 0 0-22.9-15.7 1.6-15.4 0 0 24.9 2 38.6 25.8 21.9 38.6 58.6 27.5 72.9 20.9 2.3-16 8.8-27.1 16-33.7-55.9-6.2-112.3-14.3-112.3-110.5 0-27.5 7.6-41.3 23.6-58.9-2.6-6.5-11.1-33.3 2.6-67.9 20.9-6.5 69 27 69 27 20-5.6 41.5-8.5 62.8-8.5s42.8 2.9 62.8 8.5c0 0 48.1-33.6 69-27 13.7 34.7 5.2 61.4 2.6 67.9 16 17.7 25.8 31.5 25.8 58.9 0 96.5-58.9 104.2-114.8 110.5 9.2 7.9 17 22.9 17 46.4 0 33.7-.3 75.4-.3 83.6 0 6.5 4.6 14.4 17.3 12.1C428.2 457.8 496 362.9 496 252 496 113.3 383.5 8 244.8 8zM97.2 352.9c-1.3 1-1 3.3.7 5.2 1.6 1.6 3.9 2.3 5.2 1 1.3-1 1-3.3-.7-5.2-1.6-1.6-3.9-2.3-5.2-1zm-10.8-8.1c-.7 1.3.3 2.9 2.3 3.9 1.6 1 3.6.7 4.3-.7.7-1.3-.3-2.9-2.3-3.9-2-.6-3.6-.3-4.3.7zm32.4 35.6c-1.6 1.3-1 4.3 1.3 6.2 2.3 2.3 5.2 2.6 6.5 1 1.3-1.3.7-4.3-1.3-6.2-2.2-2.3-5.2-2.6-6.5-1zm-11.4-14.7c-1.6 1-1.6 3.6 0 5.9 1.6 2.3 4.3 3.3 5.6 2.3 1.6-1.3 1.6-3.9 0-6.2-1.4-2.3-4-3.3-5.6-2z" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg
      stroke="currentColor"
      fill="currentColor"
      strokeWidth="0"
      version="1.1"
      x="0px"
      y="0px"
      viewBox="0 0 48 48"
      enableBackground="new 0 0 48 48"
      className="size-5"
      height="1em"
      width="1em"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        fill="#FFC107"
        d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12
	c0-6.627,5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24
	c0,11.045,8.955,20,20,20c11.045,0,20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"
      />
      <path
        fill="#FF3D00"
        d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657
	C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36
	c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"
      />
      <path
        fill="#1976D2"
        d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571
	c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"
      />
    </svg>
  );
}
