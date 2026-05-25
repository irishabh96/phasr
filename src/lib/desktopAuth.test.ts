import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopSession,
  commitDesktopSession,
  createDesktopSessionFromClerk,
  desktopSessionGreetingName,
  desktopSessionKey,
  desktopSessionRefreshState,
  readDesktopSession,
  refreshDesktopSessionFromClerk,
  storeDesktopSession,
  type DesktopSession,
} from "./desktopAuth";

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function jwt(payload: Record<string, unknown>) {
  return [
    base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64UrlEncode(JSON.stringify(payload)),
    "signature",
  ].join(".");
}

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;
const ONE_YEAR_MS = ONE_YEAR_SECONDS * 1000;

describe("desktop auth session", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("stores a session only when Clerk profile name and email are present", () => {
    const session = storeDesktopSession(
      jwt({
        sub: "user_123",
        exp: Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS,
        name: "Rishabh",
        email: "rishabh@example.com",
        picture: "https://example.com/avatar.png",
      }),
    );

    expect(session.profile).toEqual({
      name: "Rishabh",
      email: "rishabh@example.com",
      imageUrl: "https://example.com/avatar.png",
    });
    expect(readDesktopSession()?.userId).toBe("user_123");
  });

  it("rejects tokens without a profile name", () => {
    expect(() =>
      storeDesktopSession(
        jwt({
          sub: "user_123",
          email: "rishabh@example.com",
        }),
      ),
    ).toThrow("missing required profile name or email");
    expect(readDesktopSession()).toBeNull();
  });

  it("rejects tokens without a profile email", () => {
    expect(() =>
      storeDesktopSession(
        jwt({
          sub: "user_123",
          name: "Rishabh",
        }),
      ),
    ).toThrow("missing required profile name or email");
    expect(readDesktopSession()).toBeNull();
  });

  it("finishes desktop login with a profile-bearing Clerk JWT template token", async () => {
    const token = jwt({
      sub: "user_123",
      exp: Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS,
      name: "Rishabh",
      email: "rishabh@example.com",
    });

    const session = await createDesktopSessionFromClerk({
      loaded: true,
      client: {
        reload: async () => {},
        signedInSessions: [
          {
            id: "sess_123",
            getToken: async (options) => {
              expect(options).toEqual({
                template: "phasr_desktop",
                skipCache: true,
              });
              return token;
            },
          },
        ],
      },
    });

    expect(session.profile.email).toBe("rishabh@example.com");
    commitDesktopSession(session);
    expect(readDesktopSession()?.userId).toBe("user_123");
  });

  it("marks one-year tokens for refresh during their final week", () => {
    const now = Date.now();
    const session = storeDesktopSession(
      jwt({
        sub: "user_123",
        exp: Math.floor((now + 6 * 24 * 60 * 60 * 1000) / 1000),
        name: "Rishabh",
        email: "rishabh@example.com",
      }),
    );

    expect(desktopSessionRefreshState(session, now)).toBe("refresh");
  });

  it("treats most of a one-year token lifetime as fresh", () => {
    const now = Date.now();
    const session = storeDesktopSession(
      jwt({
        sub: "user_123",
        exp: Math.floor((now + ONE_YEAR_MS) / 1000),
        name: "Rishabh",
        email: "rishabh@example.com",
      }),
    );

    expect(desktopSessionRefreshState(session, now)).toBe("fresh");
  });

  it("can commit and clear sessions without emitting session-change events", () => {
    const listener = vi.fn();
    window.addEventListener("phasr:desktop-session-changed", listener);
    const session = storeDesktopSession(
      jwt({
        sub: "user_123",
        exp: Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS,
        name: "Rishabh",
        email: "rishabh@example.com",
      }),
    );
    expect(listener).toHaveBeenCalledTimes(1);

    commitDesktopSession(session, { emitChange: false });
    clearDesktopSession({ emitChange: false });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("phasr:desktop-session-changed", listener);
  });

  it("creates a stable key for no-op session change checks", () => {
    const session = storeDesktopSession(
      jwt({
        sub: "user_123",
        exp: Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS,
        name: "Rishabh",
        email: "rishabh@example.com",
      }),
    );

    expect(desktopSessionKey(session)).toBe(desktopSessionKey(readDesktopSession()));
    expect(desktopSessionKey(null)).toBeNull();
  });

  it("formats greeting names from the stored profile name", () => {
    expect(
      desktopSessionGreetingName(
        storeDesktopSession(
          jwt({
            sub: "user_123",
            exp: Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS,
            name: "Rishabh Jain",
            email: "rishabh@example.com",
          }),
        ),
      ),
    ).toBe("Rishabh");

    expect(
      desktopSessionGreetingName({
        jwt: "jwt",
        userId: "user_123",
        expiresAt: null,
        profile: {
          name: "Rishabh",
          email: "rishabh@example.com",
          imageUrl: null,
        },
      }),
    ).toBe("Rishabh");

    expect(
      desktopSessionGreetingName({
        jwt: "jwt",
        userId: "user_123",
        expiresAt: null,
        profile: {
          name: "   ",
          email: "rishabh@example.com",
          imageUrl: null,
        },
      } satisfies DesktopSession),
    ).toBeNull();
    expect(desktopSessionGreetingName(null)).toBeNull();
  });

  it("refreshes a cached desktop session from an active Clerk session", async () => {
    storeDesktopSession(
      jwt({
        sub: "user_123",
        exp: Math.floor((Date.now() + 6 * 24 * 60 * 60 * 1000) / 1000),
        name: "Old Name",
        email: "old@example.com",
      }),
    );

    const refreshed = await refreshDesktopSessionFromClerk({
      loaded: true,
      client: {
        reload: async () => {},
        signedInSessions: [
          {
            id: "sess_123",
            getToken: async () =>
              jwt({
                sub: "user_123",
                exp: Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS,
                name: "Rishabh",
                email: "rishabh@example.com",
              }),
          },
        ],
      },
    });

    expect(refreshed?.profile.email).toBe("rishabh@example.com");
    expect(readDesktopSession()?.profile.name).toBe("Old Name");
    if (refreshed) {
      commitDesktopSession(refreshed);
    }
    expect(readDesktopSession()?.profile.name).toBe("Rishabh");
  });

  it("rejects Clerk template tokens that still omit profile claims", async () => {
    await expect(
      createDesktopSessionFromClerk({
        loaded: true,
        client: {
          reload: async () => {},
          signedInSessions: [
            {
              id: "sess_123",
              getToken: async () =>
                jwt({
                  sub: "user_123",
                  exp: Math.floor(Date.now() / 1000) + ONE_YEAR_SECONDS,
                }),
            },
          ],
        },
      }),
    ).rejects.toThrow("missing mandatory profile claims");

    expect(readDesktopSession()).toBeNull();
  });
});
