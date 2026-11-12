import { createFileRoute, redirect } from "@tanstack/react-router";

// Settings moved into a sheet over any screen (`?settings=<section>`); this
// path survives only so old links and muscle memory still land somewhere.
export const Route = createFileRoute("/_app/settings/account")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { settings: "account" } as never, replace: true });
  },
});
