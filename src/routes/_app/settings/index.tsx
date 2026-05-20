import { Navigate, createFileRoute } from "@tanstack/react-router";

function SettingsIndex() {
  return <Navigate to="/settings/account" replace />;
}

export const Route = createFileRoute("/_app/settings/")({
  component: SettingsIndex,
});
