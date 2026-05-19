import { useAuth, UserButton } from "@clerk/react";
import { Outlet, Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { Settings as SettingsIcon } from "lucide-react";
import { useCloudSync } from "@/lib/hooks/useCloudSync";
import { useWorkspaceEvents } from "@/lib/hooks/useWorkspaceEvents";
import { useRustSession } from "@/lib/use-rust-session";

function AppLayout() {
  const { isLoaded, isSignedIn } = useAuth();
  const navigate = useNavigate();
  useRustSession();
  useCloudSync();
  useWorkspaceEvents();

  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-(--color-bg-base) text-sm text-(--color-text-muted)">
        Loading…
      </div>
    );
  }

  if (!isSignedIn) {
    return <Navigate to="/sign-in" replace />;
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-(--color-bg-base) text-(--color-text-primary)">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-(--color-border-subtle) bg-(--color-bg-surface) px-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="text-(--color-text-primary)">Phasr</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => navigate({ to: "/settings" })}
            title="Settings"
            className="flex h-7 w-7 items-center justify-center rounded-md border border-(--color-border-default) bg-(--color-bg-input) text-(--color-text-secondary) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
          >
            <SettingsIcon size={14} />
          </button>
          <UserButton
            appearance={{
              elements: {
                avatarBox: { width: 28, height: 28 },
              },
            }}
          />
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});
