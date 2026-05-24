import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storeDesktopSession } from "./desktopAuth";
import { useRustSession } from "./use-rust-session";

const mocks = vi.hoisted(() => ({
  clerk: {
    current: {
      loaded: false,
    } as unknown,
  },
  tauri: {
    clearSession: vi.fn(async () => {}),
    setSession: vi.fn(async () => "user_123"),
    startCloudSync: vi.fn(async () => {}),
    stopCloudSync: vi.fn(async () => {}),
  },
}));

vi.mock("@clerk/react", () => ({
  useClerk: () => mocks.clerk.current,
}));

vi.mock("./supabase", () => ({
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_URL: "https://example.supabase.co",
  getMachineId: () => "machine_123",
  isSupabaseConfigured: true,
}));

vi.mock("./sentry", () => ({
  reportP0Error: vi.fn(),
}));

vi.mock("./tauri", () => ({
  tauri: mocks.tauri,
}));

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

function sessionToken(expiresInMs: number) {
  return jwt({
    sub: "user_123",
    exp: Math.floor((Date.now() + expiresInMs) / 1000),
    name: "Rishabh",
    email: "rishabh@example.com",
  });
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function Probe() {
  const state = useRustSession();

  useEffect(() => {}, [state]);

  return <div data-testid="auth-state">{state.state}</div>;
}

describe("useRustSession", () => {
  beforeEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
    mocks.clerk.current = { loaded: false };
    Object.values(mocks.tauri).forEach((mock) => mock.mockClear());
  });

  it("resolves to signed out immediately when no desktop session exists", async () => {
    render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("signedOut");
    });
    expect(mocks.tauri.clearSession).toHaveBeenCalled();
  });

  it("uses a fresh stored desktop session without waiting for Clerk", async () => {
    const token = sessionToken(ONE_YEAR_MS);
    storeDesktopSession(token);

    render(<Probe />);

    await waitFor(() => {
      expect(screen.getByTestId("auth-state")).toHaveTextContent("ready");
    });
    expect(mocks.tauri.setSession).toHaveBeenCalledWith(token);
    expect(mocks.tauri.startCloudSync).toHaveBeenCalled();
  });

  it("falls back to a still-valid stored token when refresh hangs", async () => {
    vi.useFakeTimers();
    const token = sessionToken(6 * 24 * 60 * 60 * 1000);
    storeDesktopSession(token);
    mocks.clerk.current = {
      loaded: true,
      client: {
        reload: async () => {},
        signedInSessions: [
          {
            id: "sess_123",
            getToken: () => new Promise<string>(() => {}),
          },
        ],
      },
    };

    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });

    expect(screen.getByTestId("auth-state")).toHaveTextContent("ready");
    expect(mocks.tauri.setSession).toHaveBeenCalledWith(token);
    vi.useRealTimers();
  });
});
