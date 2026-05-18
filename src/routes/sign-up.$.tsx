import { SignUp, useAuth } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { clerkAppearance } from "@/lib/clerk";

function SignUpRoute() {
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
