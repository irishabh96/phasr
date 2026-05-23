import { SignIn, useAuth } from "@clerk/react";
import {
  Navigate,
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router";
import { BackgroundOrb } from "@/components/BackgroundOrb";
import {
  CLERK_SIGN_IN_URL,
  clerkAppearance,
  clerkSignInProps,
  isNestedAuthRoute,
} from "@/lib/clerk";

function ClerkSignIn() {
  const { pathname } = useLocation();
  const { isLoaded, isSignedIn } = useAuth();

  if (isNestedAuthRoute(pathname, CLERK_SIGN_IN_URL)) {
    return <Outlet />;
  }

  if (isLoaded && isSignedIn) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-(--color-bg-base) px-4">
      <BackgroundOrb intensity={0.08} />
      <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] p-6">
        <SignIn
          appearance={clerkAppearance()}
          {...clerkSignInProps()}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/sign-in")({
  component: ClerkSignIn,
});
