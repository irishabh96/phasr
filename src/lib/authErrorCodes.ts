export const AUTH_ERROR_CODES = {
  BOOTSTRAP_TIMEOUT: "PHASR_AUTH_BOOTSTRAP_TIMEOUT",
  CALLBACK_CLEAR_FAILED: "PHASR_AUTH_CALLBACK_CLEAR_FAILED",
  CALLBACK_CONSUME_FAILED: "PHASR_AUTH_CALLBACK_CONSUME_FAILED",
  CLERK_READY_TIMEOUT: "PHASR_AUTH_CLERK_READY_TIMEOUT",
  DESKTOP_SESSION_NOT_ACTIVATED: "PHASR_AUTH_DESKTOP_SESSION_NOT_ACTIVATED",
  HANDSHAKE_CALLBACK_MISSING: "PHASR_AUTH_HANDSHAKE_CALLBACK_MISSING",
  HANDSHAKE_COOKIE_WRITE_FAILED: "PHASR_AUTH_HANDSHAKE_COOKIE_WRITE_FAILED",
  HANDSHAKE_SESSION_MISSING: "PHASR_AUTH_HANDSHAKE_SESSION_MISSING",
  OAUTH_OPEN_FAILED: "PHASR_AUTH_OAUTH_OPEN_FAILED",
  OAUTH_PROVIDER_DISABLED: "PHASR_AUTH_OAUTH_PROVIDER_DISABLED",
  OAUTH_STATE_INVALID: "PHASR_AUTH_OAUTH_STATE_INVALID",
  PROFILE_CLAIMS_MISSING: "PHASR_AUTH_PROFILE_CLAIMS_MISSING",
  PROFILE_JWT_TEMPLATE_MISSING: "PHASR_AUTH_PROFILE_JWT_TEMPLATE_MISSING",
  RUST_SESSION_SYNC_FAILED: "PHASR_AUTH_RUST_SESSION_SYNC_FAILED",
  UNKNOWN_CALLBACK_ERROR: "PHASR_AUTH_CALLBACK_UNKNOWN",
} as const;

export type AuthErrorCode =
  (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  [AUTH_ERROR_CODES.BOOTSTRAP_TIMEOUT]:
    "The desktop session could not be verified quickly enough.",
  [AUTH_ERROR_CODES.CALLBACK_CLEAR_FAILED]:
    "The app could not clear a pending browser callback.",
  [AUTH_ERROR_CODES.CALLBACK_CONSUME_FAILED]:
    "The app could not read the browser callback.",
  [AUTH_ERROR_CODES.CLERK_READY_TIMEOUT]:
    "The saved login expired before Clerk became ready.",
  [AUTH_ERROR_CODES.DESKTOP_SESSION_NOT_ACTIVATED]:
    "The browser login completed, but Clerk did not activate a desktop session.",
  [AUTH_ERROR_CODES.HANDSHAKE_CALLBACK_MISSING]:
    "The browser callback did not include Clerk login data.",
  [AUTH_ERROR_CODES.HANDSHAKE_COOKIE_WRITE_FAILED]:
    "The browser callback did not persist Clerk handshake cookies.",
  [AUTH_ERROR_CODES.HANDSHAKE_SESSION_MISSING]:
    "The browser callback did not include a Clerk session token.",
  [AUTH_ERROR_CODES.OAUTH_OPEN_FAILED]:
    "The app could not open the browser login flow.",
  [AUTH_ERROR_CODES.OAUTH_PROVIDER_DISABLED]:
    "This login provider is not enabled in Clerk.",
  [AUTH_ERROR_CODES.OAUTH_STATE_INVALID]:
    "The browser callback did not match a login started from this app.",
  [AUTH_ERROR_CODES.PROFILE_CLAIMS_MISSING]:
    "The Clerk session token is missing required profile details.",
  [AUTH_ERROR_CODES.PROFILE_JWT_TEMPLATE_MISSING]:
    "The Clerk profile token template is missing or misconfigured.",
  [AUTH_ERROR_CODES.RUST_SESSION_SYNC_FAILED]:
    "The verified session could not be applied to the desktop backend.",
  [AUTH_ERROR_CODES.UNKNOWN_CALLBACK_ERROR]:
    "The browser login callback failed.",
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function classifyAuthError(
  error: unknown,
  fallback: AuthErrorCode = AUTH_ERROR_CODES.UNKNOWN_CALLBACK_ERROR,
): AuthErrorCode {
  const message = errorMessage(error);

  if (
    message.includes("login is not enabled in Clerk") ||
    message.includes("externalVerificationRedirectURL")
  ) {
    return AUTH_ERROR_CODES.OAUTH_PROVIDER_DISABLED;
  }
  if (
    message.includes("No JWT template exists") ||
    message.includes("Could not fetch Clerk JWT template") ||
    message.includes("returned no token")
  ) {
    return AUTH_ERROR_CODES.PROFILE_JWT_TEMPLATE_MISSING;
  }
  if (
    message.includes("missing mandatory profile claims") ||
    message.includes("missing required profile") ||
    message.includes("missing required profile name or email")
  ) {
    return AUTH_ERROR_CODES.PROFILE_CLAIMS_MISSING;
  }
  if (message.includes("did not activate a desktop session")) {
    return AUTH_ERROR_CODES.DESKTOP_SESSION_NOT_ACTIVATED;
  }
  if (message.includes("did not include Clerk login data")) {
    return AUTH_ERROR_CODES.HANDSHAKE_CALLBACK_MISSING;
  }
  if (message.includes("did not include a session token")) {
    return AUTH_ERROR_CODES.HANDSHAKE_SESSION_MISSING;
  }
  if (message.includes(AUTH_ERROR_CODES.CLERK_READY_TIMEOUT)) {
    return AUTH_ERROR_CODES.CLERK_READY_TIMEOUT;
  }
  if (message.includes(AUTH_ERROR_CODES.BOOTSTRAP_TIMEOUT)) {
    return AUTH_ERROR_CODES.BOOTSTRAP_TIMEOUT;
  }

  return fallback;
}
