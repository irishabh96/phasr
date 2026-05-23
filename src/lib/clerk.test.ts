import { describe, expect, it } from "vitest";
import {
  CLERK_SIGNED_IN_URL,
  CLERK_SIGN_IN_URL,
  CLERK_SIGN_UP_URL,
  clerkOAuthCallbackProps,
  clerkSignInProps,
  clerkSignUpProps,
  isNestedAuthRoute,
} from "@/lib/clerk";

describe("Clerk routing configuration", () => {
  it("uses hash routing for the embedded sign-in and sign-up components", () => {
    expect(clerkSignInProps()).toMatchObject({
      oauthFlow: "redirect",
      routing: "hash",
      signUpUrl: CLERK_SIGN_UP_URL,
      forceRedirectUrl: CLERK_SIGNED_IN_URL,
    });
    expect(clerkSignUpProps()).toMatchObject({
      oauthFlow: "redirect",
      routing: "hash",
      signInUrl: CLERK_SIGN_IN_URL,
      forceRedirectUrl: CLERK_SIGNED_IN_URL,
    });
  });

  it("configures explicit OAuth callback redirects back into the app", () => {
    expect(clerkOAuthCallbackProps()).toEqual({
      signInUrl: CLERK_SIGN_IN_URL,
      signUpUrl: CLERK_SIGN_UP_URL,
      signInForceRedirectUrl: CLERK_SIGNED_IN_URL,
      signUpForceRedirectUrl: CLERK_SIGNED_IN_URL,
    });
  });

  it("detects nested auth callback paths without treating the root auth page as nested", () => {
    expect(isNestedAuthRoute("/sign-in", CLERK_SIGN_IN_URL)).toBe(false);
    expect(isNestedAuthRoute("/sign-in/", CLERK_SIGN_IN_URL)).toBe(false);
    expect(isNestedAuthRoute("/sign-in/sso-callback", CLERK_SIGN_IN_URL)).toBe(true);
  });
});
