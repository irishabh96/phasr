import { SignUp, useAuth } from "@clerk/react";
import {
  Navigate,
  Outlet,
  createFileRoute,
  useLocation,
} from "@tanstack/react-router";
import { BackgroundOrb } from "@/components/BackgroundOrb";
import {
  CLERK_SIGN_UP_URL,
  clerkAppearance,
  clerkSignUpProps,
  isNestedAuthRoute,
} from "@/lib/clerk";

function ClerkSignUp() {
  const { pathname } = useLocation();
  const { isLoaded, isSignedIn } = useAuth();

  if (isNestedAuthRoute(pathname, CLERK_SIGN_UP_URL)) {
    return <Outlet />;
  }

  if (isLoaded && isSignedIn) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center bg-(--color-bg-base) px-4">
      <BackgroundOrb intensity={0.08} />
      <div className="glass-modal animate-[modal-in_220ms_var(--ease-glass)] p-6">
        <SignUp
          appearance={clerkAppearance()}
          {...clerkSignUpProps()}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/sign-up")({
  component: ClerkSignUp,
});
