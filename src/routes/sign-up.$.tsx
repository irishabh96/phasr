import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/sign-up/$")({
  component: () => <Navigate to="/sign-in" replace />,
});
