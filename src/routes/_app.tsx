import { useAuth } from "@clerk/react";
import { Outlet, Navigate, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AppSidebar } from "@/components/AppSidebar";
import { BackgroundOrb } from "@/components/BackgroundOrb";
import { CommandPalette } from "@/components/CommandPalette";
import { NewProjectWizard } from "@/components/NewProjectWizard";
import { OpenExistingProjectModal } from "@/components/OpenExistingProjectModal";
import { RepoFileSearchModal } from "@/components/RepoFileSearchModal";
import { TitleBar } from "@/components/TitleBar";
import { useCloudSync } from "@/lib/hooks/useCloudSync";
import { useWorkspaceEvents } from "@/lib/hooks/useWorkspaceEvents";
import { useUiStore } from "@/lib/store";
import { useRustSession } from "@/lib/use-rust-session";

function AppLayout() {
  const { isLoaded, isSignedIn } = useAuth();
  const toggleSidebarPin = useUiStore((s) => s.toggleSidebarPin);
  const toggleSidebarHidden = useUiStore((s) => s.toggleSidebarHidden);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);

  useRustSession();
  useCloudSync();
  useWorkspaceEvents();

  // Global chrome shortcuts. ⌘B pin sidebar / ⌘⇧B hide sidebar / ⌘J right panel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (e.shiftKey) toggleSidebarHidden();
        else toggleSidebarPin();
      } else if (e.key.toLowerCase() === "j" && !e.shiftKey) {
        // Don't steal ⌘⇧J — that's "Reload window" in some browsers.
        e.preventDefault();
        toggleRightPanel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [toggleSidebarPin, toggleSidebarHidden, toggleRightPanel]);

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
    <div className="relative flex h-screen flex-col overflow-hidden bg-(--color-bg-base) text-(--color-text-primary)">
      <BackgroundOrb />
      <TitleBar />
      <div className="flex min-h-0 min-w-0 flex-1">
        <AppSidebar />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
      <CommandPalette />
      <NewProjectWizard />
      <OpenExistingProjectModal />
      <RepoFileSearchModal />
    </div>
  );
}

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});
