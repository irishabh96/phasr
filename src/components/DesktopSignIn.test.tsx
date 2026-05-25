import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { DesktopSignIn } from "./DesktopSignIn";
import {
  createDesktopSessionFromClerk,
  syncAndCommitDesktopSession,
} from "@/lib/desktopAuth";
import {
  clearPendingOAuthState,
  createPendingOAuthState,
} from "@/lib/oauthState";
import { reportP0Error } from "@/lib/sentry";
import { showToast } from "@/lib/toast";

const mocks = vi.hoisted(() => ({
  clerk: {
    current: {
      loaded: true,
      client: {
        signIn: {
          create: vi.fn(),
        },
      },
    } as unknown,
  },
}));

vi.mock("@clerk/react", () => ({
  useClerk: () => mocks.clerk.current,
}));

vi.mock("@tanstack/react-router", () => ({
  Navigate: ({ to }: { to: string }) => <div data-testid="navigate">{to}</div>,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

vi.mock("@/lib/desktopAuth", () => ({
  createDesktopSessionFromClerk: vi.fn(async () => ({
    jwt: "jwt",
    userId: "user_123",
    expiresAt: null,
    profile: {
      name: "Rishabh",
      email: "rishabh@example.com",
      imageUrl: null,
    },
  })),
  onDesktopSessionChanged: vi.fn(() => () => {}),
  readDesktopSession: vi.fn(() => null),
  syncAndCommitDesktopSession: vi.fn(async () => {}),
}));

vi.mock("@/lib/oauthState", () => ({
  clearPendingOAuthState: vi.fn(),
  createPendingOAuthState: vi.fn(() => ({
    state: "state-123",
    provider: "google",
    expiresAt: Date.now() + 60_000,
  })),
}));

vi.mock("@/lib/sentry", () => ({
  reportP0Error: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  showToast: vi.fn(),
}));

const mockOpenUrl = vi.mocked(openUrl);
const mockCreateDesktopSessionFromClerk = vi.mocked(
  createDesktopSessionFromClerk,
);
const mockSyncAndCommitDesktopSession = vi.mocked(syncAndCommitDesktopSession);
const mockCreatePendingOAuthState = vi.mocked(createPendingOAuthState);
const mockClearPendingOAuthState = vi.mocked(clearPendingOAuthState);
const mockReportP0Error = vi.mocked(reportP0Error);
const mockShowToast = vi.mocked(showToast);

function signInCreateMock() {
  return vi.mocked(
    (
      mocks.clerk.current as {
        client: { signIn: { create: ReturnType<typeof vi.fn> } };
      }
    ).client.signIn.create,
  );
}

describe("DesktopSignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clerk.current = {
      loaded: true,
      client: {
        signIn: {
          create: vi.fn(async () => ({
            firstFactorVerification: {
              externalVerificationRedirectURL: new URL(
                "https://accounts.google.com/o/oauth2/v2/auth",
              ),
            },
          })),
        },
      },
      session: null,
    };
  });

  it("uses an existing Clerk session instead of creating a new OAuth attempt", async () => {
    mocks.clerk.current = {
      loaded: true,
      client: {
        signedInSessions: [{ id: "sess_123" }],
        signIn: {
          create: vi.fn(),
        },
      },
      session: null,
    };

    render(<DesktopSignIn />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );

    await waitFor(() => {
      expect(mockSyncAndCommitDesktopSession).toHaveBeenCalled();
    });

    expect(signInCreateMock()).not.toHaveBeenCalled();
    expect(mockCreateDesktopSessionFromClerk).toHaveBeenCalledWith(
      mocks.clerk.current,
    );
    expect(screen.getByTestId("navigate")).toHaveTextContent("/");
  });

  it("recovers from Clerk session_exists by activating the existing session", async () => {
    signInCreateMock().mockRejectedValue({
      errors: [{ code: "session_exists" }],
    });

    render(<DesktopSignIn />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with GitHub" }),
    );

    await waitFor(() => {
      expect(mockSyncAndCommitDesktopSession).toHaveBeenCalled();
    });

    expect(mockOpenUrl).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
    expect(screen.getByTestId("navigate")).toHaveTextContent("/");
  });

  it("still reports OAuth open failures when the browser cannot be opened", async () => {
    mockOpenUrl.mockRejectedValue(new Error("open failed"));

    render(<DesktopSignIn />);
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );

    await waitFor(() => {
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "PHASR_AUTH_OAUTH_OPEN_FAILED",
        }),
      );
    });

    expect(mockCreatePendingOAuthState).toHaveBeenCalledWith("google");
    expect(mockClearPendingOAuthState).toHaveBeenCalled();
    expect(mockReportP0Error).toHaveBeenCalledWith(
      "OAuth login failed",
      expect.any(Error),
      expect.objectContaining({
        errorCode: "PHASR_AUTH_OAUTH_OPEN_FAILED",
        provider: "google",
      }),
    );
  });
});
