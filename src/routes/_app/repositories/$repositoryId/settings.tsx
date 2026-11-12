import { createFileRoute, redirect } from "@tanstack/react-router";

// Repository settings live in the settings sheet's REPOSITORY group now.
export const Route = createFileRoute("/_app/repositories/$repositoryId/settings")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/",
      search: { settings: "run-commands", settingsRepo: params.repositoryId } as never,
      replace: true,
    });
  },
});
