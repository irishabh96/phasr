import { SignIn, useAuth } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { BackgroundOrb } from "@/components/BackgroundOrb";
import { clerkAppearance, isClerkConfigured } from "@/lib/clerk";

function SignInRoute() {
  if (!isClerkConfigured) {
    // Keyless build — there's no sign-in flow. Just send the user home.
    return <Navigate to="/" replace />;
  }
  return <ClerkSignIn />;
}

function ClerkSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-(--color-bg-base) px-4">
      <BackgroundOrb intensity={0.08} />
      <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] p-6">
        <SignIn
          appearance={clerkAppearance()}
          routing="path"
          path="/sign-in"
          signUpUrl="/sign-up"
          forceRedirectUrl="/"
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/sign-in")({
  component: SignInRoute,
});
