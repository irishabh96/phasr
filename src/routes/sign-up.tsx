import { SignUp, useAuth } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { BackgroundOrb } from "@/components/BackgroundOrb";
import { clerkAppearance } from "@/lib/clerk";

function ClerkSignUp() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-(--color-bg-base) px-4">
      <BackgroundOrb intensity={0.08} />
      <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] p-6">
        <SignUp
          appearance={clerkAppearance()}
          oauthFlow="redirect"
          routing="path"
          path="/sign-up"
          signInUrl="/sign-in"
          forceRedirectUrl="/"
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/sign-up")({
  component: ClerkSignUp,
});
