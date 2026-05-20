import { useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import { Outlet, Navigate, createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AddRepositoryPickerModal } from "@/components/AddRepositoryPickerModal";
import { AppSidebar } from "@/components/AppSidebar";
import { BackgroundOrb } from "@/components/BackgroundOrb";
import { CommandPalette } from "@/components/CommandPalette";
import { NewProjectWizard } from "@/components/NewProjectWizard";
import { NewWorkspaceModal } from "@/components/NewWorkspaceModal";
import { OpenExistingProjectModal } from "@/components/OpenExistingProjectModal";
import { RenameWorkspaceModal } from "@/components/RenameWorkspaceModal";
import { RepoFileSearchModal } from "@/components/RepoFileSearchModal";
import { disposeSessionXterm } from "@/components/SessionTerminalTab";
import { disposeMainXterm } from "@/components/Terminal";
import { TitleBar } from "@/components/TitleBar";
import { isClerkConfigured } from "@/lib/clerk";
import { useCloudSync } from "@/lib/hooks/useCloudSync";
import { repositoryKeys } from "@/lib/hooks/useRepositories";
import { useWorkspaceEvents } from "@/lib/hooks/useWorkspaceEvents";
import { useUiStore } from "@/lib/store";
import { useRustSession } from "@/lib/use-rust-session";
import { tauri } from "@/lib/tauri";
import type { Repository } from "@/lib/types";

/**
 * Top-level shell. In cloud mode (Clerk configured), AuthGate gets to
 * call `useAuth()` and gate on sign-in. In local-only mode (no Clerk),
 * we skip the gate entirely and render the shell directly — `useAuth`
 * would throw without a ClerkProvider parent in the tree.
 */
function AppLayout() {
  if (!isClerkConfigured) {
    return <AppShell />;
  }
  return <AuthGate />;
}

function AuthGate() {
  const { isLoaded, isSignedIn } = useAuth();

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

  return <AppShell />;
}

function AppShell() {
  const toggleSidebarPin = useUiStore((s) => s.toggleSidebarPin);
  const toggleSidebarHidden = useUiStore((s) => s.toggleSidebarHidden);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const queryClient = useQueryClient();

  useRustSession();
  useCloudSync();
  useWorkspaceEvents();

  // Global chrome shortcuts.
  //   ⌘B  pin sidebar
  //   ⌘⇧B hide sidebar
  //   ⌘J  right panel
  //   ⌘N  new workspace in the active workspace's repo
  //   ⌘T  new terminal inner tab in the active workspace
  //   ⌘W  close active inner tab (if closable; no-op on "main")
  //   ⌘P  open file search for the active workspace's repo
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();

      if (key === "b") {
        e.preventDefault();
        if (e.shiftKey) toggleSidebarHidden();
        else toggleSidebarPin();
        return;
      }
      if (key === "j" && !e.shiftKey) {
        // Don't steal ⌘⇧J — that's "Reload window" in some browsers.
        e.preventDefault();
        toggleRightPanel();
        return;
      }
      if (key === "n" && !e.shiftKey) {
        const { activeWorkspaceContext, requestNewWorkspace } = useUiStore.getState();
        if (!activeWorkspaceContext) return;
        e.preventDefault();
        requestNewWorkspace(activeWorkspaceContext.repositoryId);
        return;
      }
      if (key === "t" && !e.shiftKey) {
        const { activeWorkspaceContext, openInnerTerminalTab } = useUiStore.getState();
        if (!activeWorkspaceContext) return;
        // Capture-phase + stopImmediatePropagation defeats Chromium's
        // built-in "new tab" reservation on ⌘T.
        e.preventDefault();
        e.stopImmediatePropagation();
        openInnerTerminalTab(activeWorkspaceContext.workspaceId);
        return;
      }
      if (key === "p" && !e.shiftKey) {
        const state = useUiStore.getState();
        const ctx = state.activeWorkspaceContext;
        if (!ctx) return;
        const repos = queryClient.getQueryData<Repository[]>(repositoryKeys.list());
        const repoPath = repos?.find((r) => r.id === ctx.repositoryId)?.localPath ?? null;
        if (!repoPath) return;
        e.preventDefault();
        state.openFileSearch(ctx.repositoryId, repoPath);
        return;
      }
      if (key === "w" && !e.shiftKey) {
        const state = useUiStore.getState();
        const ctx = state.activeWorkspaceContext;
        if (!ctx) return;
        const inner = state.innerTabs[ctx.workspaceId];
        const activeInner = inner?.tabs.find((t) => t.id === inner.activeTabId);
        if (!activeInner?.closable) return;
        e.preventDefault();
        const closed = state.closeInnerTab(ctx.workspaceId, activeInner.id);
        if (!closed) return;
        if (closed.kind === "terminal") {
          if (closed.ptySessionId) {
            void tauri.stopSessionTerminal(closed.ptySessionId).catch(() => {});
          }
          disposeSessionXterm(closed.id);
        } else if (closed.kind === "main") {
          disposeMainXterm(ctx.workspaceId);
        }
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [toggleSidebarPin, toggleSidebarHidden, toggleRightPanel, queryClient]);

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
      <NewWorkspaceModal />
      <RenameWorkspaceModal />
      <OpenExistingProjectModal />
      <AddRepositoryPickerModal />
      <RepoFileSearchModal />
    </div>
  );
}

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});
