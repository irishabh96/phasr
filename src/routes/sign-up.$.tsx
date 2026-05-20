import { SignUp, useAuth } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { clerkAppearance, isClerkConfigured } from "@/lib/clerk";

function SignUpRoute() {
  if (!isClerkConfigured) {
    return <Navigate to="/" replace />;
  }
  return <ClerkSignUpSplat />;
}

function ClerkSignUpSplat() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--color-bg-base) px-4">
      <SignUp
        appearance={clerkAppearance()}
        routing="path"
        path="/sign-up"
        signInUrl="/sign-in"
        forceRedirectUrl="/"
      />
    </div>
  );
}

export const Route = createFileRoute("/sign-up/$")({
  component: SignUpRoute,
});
