import { describe, expect, it } from "vitest";
import {
  CLERK_AUTH_CALLBACK_EVENT,
  CLERK_DESKTOP_CALLBACK_URL,
  CLERK_SESSION_JWT_TEMPLATE,
  CLERK_SIGNED_IN_URL,
  CLERK_SIGN_IN_URL,
  CLERK_SIGN_UP_URL,
  clerkDesktopCallbackUrl,
  clerkCallbackPathFromUrl,
  clerkOAuthCallbackProps,
  clerkOAuthStrategy,
  isNestedAuthRoute,
  optionalEnv,
} from "@/lib/clerk";

describe("Clerk routing configuration", () => {
  it("uses the HTTPS bridge callback for external browser OAuth", () => {
    expect(CLERK_DESKTOP_CALLBACK_URL).toBe(
      "https://auth.phasr.sh/callback",
    );
    expect(CLERK_AUTH_CALLBACK_EVENT).toBe("phasr://auth-callback");
    expect(CLERK_SESSION_JWT_TEMPLATE).toBe("phasr_desktop");
    expect(clerkOAuthStrategy("google")).toBe("oauth_google");
    expect(clerkOAuthStrategy("github")).toBe("oauth_github");
  });

  it("falls back when optional release env values are blank", () => {
    expect(optionalEnv("", "fallback")).toBe("fallback");
    expect(optionalEnv("   ", "fallback")).toBe("fallback");
    expect(optionalEnv(" configured ", "fallback")).toBe("configured");
    expect(optionalEnv(undefined, "fallback")).toBe("fallback");
  });

  it("adds the Phasr OAuth state to the desktop callback URL", () => {
    expect(clerkDesktopCallbackUrl("state-123")).toBe(
      "https://auth.phasr.sh/callback?phasr_state=state-123",
    );
  });

  it("configures explicit OAuth callback redirects back into the app", () => {
    expect(clerkOAuthCallbackProps()).toEqual({
      signInUrl: CLERK_SIGN_IN_URL,
      signUpUrl: CLERK_SIGN_UP_URL,
      firstFactorUrl: CLERK_SIGN_IN_URL,
      secondFactorUrl: CLERK_SIGN_IN_URL,
      resetPasswordUrl: CLERK_SIGN_IN_URL,
      continueSignUpUrl: CLERK_SIGN_IN_URL,
      signInForceRedirectUrl: CLERK_SIGNED_IN_URL,
      signUpForceRedirectUrl: CLERK_SIGNED_IN_URL,
      reloadResource: "signIn",
    });
  });

  it("translates the deep link callback into Clerk's in-app callback path", () => {
    expect(
      clerkCallbackPathFromUrl("phasr://auth/callback?code=abc&state=xyz"),
    ).toBe("/sign-in/sso-callback?code=abc&state=xyz");
  });

  it("detects nested auth callback paths without treating the root auth page as nested", () => {
    expect(isNestedAuthRoute("/sign-in", CLERK_SIGN_IN_URL)).toBe(false);
    expect(isNestedAuthRoute("/sign-in/", CLERK_SIGN_IN_URL)).toBe(false);
    expect(isNestedAuthRoute("/sign-in/sso-callback", CLERK_SIGN_IN_URL)).toBe(
      true,
    );
  });
});
