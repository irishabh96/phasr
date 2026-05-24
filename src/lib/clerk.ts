export function optionalEnv(value: string | undefined): string | undefined;
export function optionalEnv(value: string | undefined, fallback: string): string;
export function optionalEnv(value: string | undefined, fallback?: string) {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

export const CLERK_PUBLISHABLE_KEY = optionalEnv(
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

/**
 * Auth is required for every build. If this is missing, the app renders
 * a configuration error instead of mounting routes or Tauri-backed data
 * hooks.
 */
export const isClerkConfigured = Boolean(CLERK_PUBLISHABLE_KEY);

export const CLERK_CONFIG_ERROR =
  "Missing VITE_CLERK_PUBLISHABLE_KEY. Phasr requires Clerk authentication.";

export const CLERK_SIGN_IN_URL = "/sign-in";
export const CLERK_SIGN_UP_URL = "/sign-up";
export const CLERK_SIGNED_IN_URL = "/";
export const CLERK_DESKTOP_CALLBACK_URL = optionalEnv(
  import.meta.env.VITE_CLERK_DESKTOP_CALLBACK_URL,
  "https://phasr-auth-bridge.vercel.app/callback",
);
export const CLERK_SESSION_JWT_TEMPLATE = optionalEnv(
  import.meta.env.VITE_CLERK_SESSION_JWT_TEMPLATE,
  "phasr_desktop",
);
export const CLERK_AUTH_CALLBACK_EVENT = "phasr://auth-callback";

export const CLERK_OAUTH_STRATEGIES = {
  google: "oauth_google",
  github: "oauth_github",
} as const;

export type ClerkOAuthProvider = keyof typeof CLERK_OAUTH_STRATEGIES;

export function isNestedAuthRoute(pathname: string, authRoute: string) {
  return pathname !== authRoute && pathname !== `${authRoute}/`;
}

export function clerkOAuthStrategy(provider: ClerkOAuthProvider) {
  return CLERK_OAUTH_STRATEGIES[provider];
}

export function clerkDesktopCallbackUrl(oauthState: string) {
  const url = new URL(CLERK_DESKTOP_CALLBACK_URL);
  url.searchParams.set("phasr_state", oauthState);
  return url.toString();
}

export function clerkOAuthCallbackProps() {
  return {
    signInUrl: CLERK_SIGN_IN_URL,
    signUpUrl: CLERK_SIGN_UP_URL,
    firstFactorUrl: CLERK_SIGN_IN_URL,
    secondFactorUrl: CLERK_SIGN_IN_URL,
    resetPasswordUrl: CLERK_SIGN_IN_URL,
    continueSignUpUrl: CLERK_SIGN_IN_URL,
    signInForceRedirectUrl: CLERK_SIGNED_IN_URL,
    signUpForceRedirectUrl: CLERK_SIGNED_IN_URL,
    reloadResource: "signIn" as const,
  };
}

export function clerkCallbackPathFromUrl(callbackUrl: string) {
  const url = new URL(callbackUrl);
  return `${CLERK_SIGN_IN_URL}/sso-callback${url.search}${url.hash}`;
}

/**
 * Clerk appearance tuned to match Phasr's design tokens. Re-reads CSS
 * variables at component-instantiation time so a theme toggle re-renders
 * Clerk's UI with the new palette.
 */
export function clerkAppearance() {
  const style =
    typeof window !== "undefined"
      ? getComputedStyle(document.documentElement)
      : null;
  const read = (name: string, fallback: string) =>
    style?.getPropertyValue(name).trim() || fallback;

  return {
    variables: {
      colorPrimary: read("--color-accent-600", "#4f46e5"),
      colorBackground: read("--color-bg-surface", "#111114"),
      colorInputBackground: read("--color-bg-input", "#0e0e11"),
      colorInputText: read("--color-text-primary", "#e8e8ec"),
      colorText: read("--color-text-primary", "#e8e8ec"),
      colorTextSecondary: read("--color-text-secondary", "#a0a0ab"),
      colorNeutral: read("--color-text-primary", "#e8e8ec"),
      colorDanger: read("--color-danger", "#ef4444"),
      colorSuccess: read("--color-success", "#22c55e"),
      colorWarning: read("--color-warning", "#f59e0b"),
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      fontFamilyButtons: "Inter, ui-sans-serif, system-ui, sans-serif",
      borderRadius: "8px",
    },
    elements: {
      card: { boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)" },
      formButtonPrimary: { textTransform: "none" as const, fontWeight: 500 },
      footer: { display: "none" },
    },
  };
}
