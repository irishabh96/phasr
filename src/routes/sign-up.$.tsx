import { AuthenticateWithRedirectCallback } from "@clerk/react";
import { Navigate, createFileRoute, useLocation } from "@tanstack/react-router";
import { clerkOAuthCallbackProps } from "@/lib/clerk";

function ClerkSignUpCallback() {
  const { pathname } = useLocation();

  if (!pathname.includes("sso-callback")) {
    return <Navigate to="/sign-up" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--color-bg-base) px-4">
      <AuthenticateWithRedirectCallback {...clerkOAuthCallbackProps()} />
    </div>
  );
}

export const Route = createFileRoute("/sign-up/$")({
  component: ClerkSignUpCallback,
});
