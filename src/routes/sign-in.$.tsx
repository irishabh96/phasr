import { SignIn, useAuth } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { clerkAppearance } from "@/lib/clerk";

function ClerkSignInSplat() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--color-bg-base) px-4">
      <SignIn
        appearance={clerkAppearance()}
        oauthFlow="redirect"
        routing="path"
        path="/sign-in"
        signUpUrl="/sign-up"
        forceRedirectUrl="/"
      />
    </div>
  );
}

export const Route = createFileRoute("/sign-in/$")({
  component: ClerkSignInSplat,
});
