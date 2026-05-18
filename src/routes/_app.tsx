import { useAuth, UserButton } from "@clerk/react";
import { Outlet, Navigate, createFileRoute } from "@tanstack/react-router";
import { useRustSession } from "@/lib/use-rust-session";

function AppLayout() {
  const { isLoaded, isSignedIn } = useAuth();
  useRustSession();

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
        <UserButton
          appearance={{
            elements: {
              avatarBox: { width: 28, height: 28 },
            },
          }}
        />
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
