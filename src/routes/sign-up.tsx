import { Navigate, createFileRoute } from "@tanstack/react-router";

// Deliberately a redirect, not a page: DesktopSignIn signs up on the fly
// (`signUpIfMissing: true`), so /sign-in IS the sign-up flow. This route
// exists only for Clerk-emitted /sign-up links.
export const Route = createFileRoute("/sign-up")({
  component: () => <Navigate to="/sign-in" replace />,
});
