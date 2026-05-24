import type { ClerkOAuthProvider } from "./clerk";

const PENDING_OAUTH_STATE_STORAGE_KEY = "phasr.auth.pendingOAuthState";
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

type PendingOAuthState = {
  state: string;
  provider: ClerkOAuthProvider;
  expiresAt: number;
};

export type OAuthStateValidation =
  | { ok: true; state: PendingOAuthState }
  | { ok: false; reason: string };

function randomState() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readPendingOAuthState() {
  const serialized = window.localStorage.getItem(PENDING_OAUTH_STATE_STORAGE_KEY);
  if (!serialized) return null;

  try {
    const pending = JSON.parse(serialized) as PendingOAuthState;
    if (!pending.state || !pending.provider || !pending.expiresAt) return null;
    return pending;
  } catch {
    window.localStorage.removeItem(PENDING_OAUTH_STATE_STORAGE_KEY);
    return null;
  }
}

export function createPendingOAuthState(provider: ClerkOAuthProvider) {
  const pending = {
    state: randomState(),
    provider,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  } satisfies PendingOAuthState;

  window.localStorage.setItem(
    PENDING_OAUTH_STATE_STORAGE_KEY,
    JSON.stringify(pending),
  );
  return pending;
}

export function clearPendingOAuthState(state?: string) {
  if (!state) {
    window.localStorage.removeItem(PENDING_OAUTH_STATE_STORAGE_KEY);
    return;
  }

  const pending = readPendingOAuthState();
  if (pending?.state === state) {
    window.localStorage.removeItem(PENDING_OAUTH_STATE_STORAGE_KEY);
  }
}

export function validatePendingOAuthState(callbackState: string | null) {
  const pending = readPendingOAuthState();
  if (!pending) {
    return { ok: false, reason: "No pending Phasr browser login." } satisfies OAuthStateValidation;
  }

  if (pending.expiresAt <= Date.now()) {
    clearPendingOAuthState();
    return { ok: false, reason: "Phasr browser login expired." } satisfies OAuthStateValidation;
  }

  if (!callbackState || callbackState !== pending.state) {
    return { ok: false, reason: "Phasr browser login state mismatch." } satisfies OAuthStateValidation;
  }

  return { ok: true, state: pending } satisfies OAuthStateValidation;
}

export function consumePendingOAuthState(callbackState: string | null) {
  const validation = validatePendingOAuthState(callbackState);
  if (validation.ok) {
    clearPendingOAuthState(validation.state.state);
  }
  return validation;
}
