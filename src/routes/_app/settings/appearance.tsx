import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings moved into a sheet over any screen (`?settings=<section>`); this
// path survives only so old links and muscle memory still land somewhere.
export const Route = createFileRoute("/_app/settings/appearance")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { settings: "appearance" } as never, replace: true });
  },
});
