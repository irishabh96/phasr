import { Outlet, createFileRoute } from "@tanstack/react-router";

// Parent of the legacy /settings/* redirects (see settings/*.tsx).
export const Route = createFileRoute("/_app/settings")({
  component: Outlet,
});
