import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings moved into a sheet over any screen (`?settings=<section>`); this
// path survives only so old links and muscle memory still land somewhere.
export const Route = createFileRoute("/_app/settings/repositories")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { settings: "run-commands" } as never, replace: true });
  },
});
