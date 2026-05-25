import { CLERK_SESSION_JWT_TEMPLATE } from "./clerk";
import { reportP0Error } from "./sentry";
import { getMachineId, SUPABASE_ANON_KEY, SUPABASE_URL } from "./supabase";
import { tauri } from "./tauri";

const DESKTOP_SESSION_STORAGE_KEY = "phasr.auth.desktopSession";
const DESKTOP_SESSION_EVENT = "phasr:desktop-session-changed";
const DESKTOP_SESSION_REFRESH_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

export type DesktopSession = {
  jwt: string;
  userId: string;
  expiresAt: number | null;
  profile: DesktopSessionProfile;
};

export type DesktopSessionProfile = {
  name: string;
  email: string;
  imageUrl: string | null;
};

type JwtClaims = {
  sub?: string;
  exp?: number;
  email?: unknown;
  email_address?: unknown;
  family_name?: unknown;
  first_name?: unknown;
  full_name?: unknown;
  given_name?: unknown;
  image_url?: unknown;
  last_name?: unknown;
  name?: unknown;
  picture?: unknown;
  primary_email_address?: unknown;
  username?: unknown;
};

type ClerkEmailLike = {
  emailAddress?: string | null;
};

type ClerkUserLike = {
  emailAddresses?: ClerkEmailLike[];
  firstName?: string | null;
  fullName?: string | null;
  imageUrl?: string | null;
  lastName?: string | null;
  primaryEmailAddress?: ClerkEmailLike | null;
  username?: string | null;
};

type ClerkSessionLike = {
  id?: string;
  user?: ClerkUserLike | null;
  getToken?: (options?: {
    template?: string;
    skipCache?: boolean;
  }) => Promise<string | null>;
};

type ClerkSignInAttemptLike = {
  firstFactorVerification?: { status?: string | null } | null;
};

type ClerkSignUpAttemptLike = {
  status?: string | null;
};

type ClerkClientLike = {
  reload?: () => Promise<unknown>;
  signedInSessions?: ClerkSessionLike[];
  signIn?: ClerkSignInAttemptLike | null;
  signUp?: {
    create?: (params: { transfer: true }) => Promise<ClerkSignUpAttemptLike>;
  } | null;
};

export type ClerkDesktopAuthClient = {
  loaded?: boolean;
  client?: ClerkClientLike;
  session?: ClerkSessionLike | null;
  user?: ClerkUserLike | null;
  setActive?: (params: {
    session: ClerkSessionLike | string;
    navigate?: () => void | Promise<void>;
  }) => Promise<void>;
};

export type DesktopSessionRefreshState = "fresh" | "refresh" | "expired";

type ReadDesktopSessionOptions = {
  allowExpired?: boolean;
};

type CommitDesktopSessionOptions = {
  emitChange?: boolean;
};

type ClearDesktopSessionOptions = {
  emitChange?: boolean;
};

const PROFILE_JWT_TEMPLATE_HELP =
  `Configure Clerk JWT template "${CLERK_SESSION_JWT_TEMPLATE}" with ` +
  `mandatory claims: name={{user.full_name}}, ` +
  `email={{user.primary_email_address}}, picture={{user.image_url}}, ` +
  `and Token lifetime=31536000.`;

function decodeBase64Url(value: string) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeJwtClaims(jwt: string) {
  const [, payload] = jwt.split(".");
  if (!payload) {
    throw new Error("Missing Clerk session token payload.");
  }
  return JSON.parse(decodeBase64Url(payload)) as JwtClaims;
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  return null;
}

function profileFromClaims(claims: JwtClaims): DesktopSessionProfile {
  const firstName = firstString(claims.first_name, claims.given_name);
  const lastName = firstString(claims.last_name, claims.family_name);
  const composedName = firstString([firstName, lastName].filter(Boolean).join(" "));
  const name = firstString(claims.name, claims.full_name, composedName, claims.username);
  const email = firstString(
    claims.email,
    claims.email_address,
    claims.primary_email_address,
  );

  if (!name || !email) {
    throw new Error(
      "Clerk session token is missing required profile name or email.",
    );
  }

  return {
    name,
    email,
    imageUrl: firstString(claims.picture, claims.image_url),
  };
}

function normalizeStoredProfile(profile: unknown, fallback: DesktopSessionProfile) {
  if (!profile || typeof profile !== "object") return fallback;

  const storedProfile = profile as Partial<DesktopSessionProfile>;
  return {
    name: firstString(storedProfile.name) ?? fallback.name,
    email: firstString(storedProfile.email) ?? fallback.email,
    imageUrl: firstString(storedProfile.imageUrl) ?? fallback.imageUrl,
  };
}

function sessionFromJwt(jwt: string): DesktopSession {
  const claims = decodeJwtClaims(jwt);
  if (!claims.sub) {
    throw new Error("Clerk session token is missing a user id.");
  }

  return {
    jwt,
    userId: claims.sub,
    expiresAt: claims.exp ?? null,
    profile: profileFromClaims(claims),
  };
}

async function resolveSignedInClerkSession(clerk: ClerkDesktopAuthClient) {
  if (!clerk.loaded || !clerk.client) {
    throw new Error("Clerk is not ready to finish desktop login.");
  }

  await clerk.client.reload?.();

  let session = clerk.session ?? clerk.client.signedInSessions?.[0] ?? null;

  if (!session && clerk.client.signIn?.firstFactorVerification?.status === "transferable") {
    // First-time user: the OAuth identity has no Clerk account yet.
    // Transfer the credentials to a new sign-up to create the account.
    await clerk.client.signUp?.create?.({ transfer: true });
    await clerk.client.reload?.();
    session = clerk.session ?? clerk.client.signedInSessions?.[0] ?? null;
  }

  if (!session) {
    throw new Error("Clerk browser callback did not activate a desktop session.");
  }

  if (session.id && clerk.session?.id !== session.id && clerk.setActive) {
    await clerk.setActive({
      session,
      navigate: async () => {},
    });
  }

  return session;
}

async function resolveOptionalSignedInClerkSession(
  clerk: ClerkDesktopAuthClient,
) {
  if (!clerk.loaded || !clerk.client) return null;

  await clerk.client.reload?.();

  const session = clerk.session ?? clerk.client.signedInSessions?.[0] ?? null;
  if (!session) return null;

  if (session.id && clerk.session?.id !== session.id && clerk.setActive) {
    await clerk.setActive({
      session,
      navigate: async () => {},
    });
  }

  return session;
}

async function profileJwtFromClerkSession(session: ClerkSessionLike) {
  if (!session.getToken) {
    throw new Error("Clerk desktop session cannot issue JWTs.");
  }

  let jwt: string | null = null;
  try {
    jwt = await session.getToken({
      template: CLERK_SESSION_JWT_TEMPLATE,
      skipCache: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not fetch Clerk JWT template "${CLERK_SESSION_JWT_TEMPLATE}". ${PROFILE_JWT_TEMPLATE_HELP} Clerk said: ${message}`,
    );
  }

  if (!jwt) {
    throw new Error(
      `Clerk JWT template "${CLERK_SESSION_JWT_TEMPLATE}" returned no token. ${PROFILE_JWT_TEMPLATE_HELP}`,
    );
  }

  try {
    sessionFromJwt(jwt);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("missing required profile name or email")
    ) {
      throw new Error(
        `Clerk JWT template "${CLERK_SESSION_JWT_TEMPLATE}" is missing mandatory profile claims. ${PROFILE_JWT_TEMPLATE_HELP}`,
      );
    }
    throw error;
  }

  return jwt;
}

function emitDesktopSessionChanged() {
  window.dispatchEvent(new Event(DESKTOP_SESSION_EVENT));
}

export function desktopSessionRefreshState(
  session: DesktopSession,
  nowMs = Date.now(),
): DesktopSessionRefreshState {
  if (!session.expiresAt) return "fresh";

  const expiresAtMs = session.expiresAt * 1000;
  if (expiresAtMs <= nowMs) return "expired";
  if (expiresAtMs - nowMs <= DESKTOP_SESSION_REFRESH_SKEW_MS) return "refresh";

  return "fresh";
}

export function onDesktopSessionChanged(listener: () => void) {
  window.addEventListener(DESKTOP_SESSION_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(DESKTOP_SESSION_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function readDesktopSession(options: ReadDesktopSessionOptions = {}) {
  const serialized = window.localStorage.getItem(DESKTOP_SESSION_STORAGE_KEY);
  if (!serialized) return null;

  try {
    const storedSession = JSON.parse(serialized) as Partial<DesktopSession>;
    if (!storedSession.jwt || !storedSession.userId) return null;

    const jwtSession = sessionFromJwt(storedSession.jwt);
    const session = {
      ...jwtSession,
      profile: normalizeStoredProfile(storedSession.profile, jwtSession.profile),
    };

    if (
      !options.allowExpired &&
      session.expiresAt &&
      session.expiresAt * 1000 <= Date.now()
    ) {
      clearDesktopSession();
      return null;
    }

    return session;
  } catch {
    clearDesktopSession();
    return null;
  }
}

export function commitDesktopSession(
  session: DesktopSession,
  options: CommitDesktopSessionOptions = {},
) {
  window.localStorage.setItem(
    DESKTOP_SESSION_STORAGE_KEY,
    JSON.stringify(session),
  );
  if (options.emitChange ?? true) {
    emitDesktopSessionChanged();
  }
  return session;
}

export function desktopSessionKey(session: DesktopSession | null) {
  if (!session) return null;
  return `${session.userId}:${session.expiresAt ?? "none"}:${session.jwt}`;
}

export function desktopSessionGreetingName(session: DesktopSession | null) {
  const name = firstString(session?.profile.name);
  if (!name) return null;

  return name.split(/\s+/)[0] ?? null;
}

export function storeDesktopSession(jwt: string) {
  return commitDesktopSession(sessionFromJwt(jwt));
}

export async function createDesktopSessionFromClerk(
  clerk: ClerkDesktopAuthClient,
) {
  const clerkSession = await resolveSignedInClerkSession(clerk);
  const profileJwt = await profileJwtFromClerkSession(clerkSession);
  return sessionFromJwt(profileJwt);
}

export async function refreshDesktopSessionFromClerk(
  clerk: ClerkDesktopAuthClient,
) {
  const clerkSession = await resolveOptionalSignedInClerkSession(clerk);
  if (!clerkSession) return null;

  const profileJwt = await profileJwtFromClerkSession(clerkSession);
  return sessionFromJwt(profileJwt);
}

export function clearDesktopSession(options: ClearDesktopSessionOptions = {}) {
  window.localStorage.removeItem(DESKTOP_SESSION_STORAGE_KEY);
  if (options.emitChange ?? true) {
    emitDesktopSessionChanged();
  }
}

export async function syncRustSession(session: DesktopSession) {
  await tauri.setSession(session.jwt);
  await tauri.startCloudSync({
    supabaseUrl: SUPABASE_URL!,
    supabaseAnonKey: SUPABASE_ANON_KEY!,
    machineId: getMachineId(),
  });
}

export async function syncAndCommitDesktopSession(session: DesktopSession) {
  await syncRustSession(session);
  return commitDesktopSession(session);
}

export async function signOutDesktopSession() {
  clearDesktopSession();
  await tauri.stopCloudSync().catch((err: unknown) => {
    reportP0Error("stopCloudSync failed during sign-out", err, { area: "auth", operation: "sign_out_cleanup" });
  });
  await tauri.clearSession().catch((err: unknown) => {
    reportP0Error("clearSession failed during sign-out", err, { area: "auth", operation: "sign_out_cleanup" });
  });
}
