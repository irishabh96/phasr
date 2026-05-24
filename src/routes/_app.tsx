import { useQueryClient } from "@tanstack/react-query";
import { Outlet, Navigate, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { AddRepositoryPickerModal } from "@/components/AddRepositoryPickerModal";
import { AppSidebar } from "@/components/AppSidebar";
import { BackgroundOrb } from "@/components/BackgroundOrb";
import { CommandPalette } from "@/components/CommandPalette";
import { GitInitConfirmModal } from "@/components/GitInitConfirmModal";
import { NewTaskModal } from "@/components/NewTaskModal";
import { RenameWorkspaceModal } from "@/components/RenameWorkspaceModal";
import { RepoFileSearchModal } from "@/components/RepoFileSearchModal";
import { disposeSessionXterm } from "@/components/SessionTerminalTab";
import { disposeMainXterm } from "@/components/Terminal";
import { TitleBar } from "@/components/TitleBar";
import { useCloudSync } from "@/lib/hooks/useCloudSync";
import { repositoryKeys } from "@/lib/hooks/useRepositories";
import { useTaskEvents } from "@/lib/hooks/useTaskEvents";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { useRustSession } from "@/lib/use-rust-session";
import { tauri } from "@/lib/tauri";
import type { Repository } from "@/lib/types";

function AppLayout() {
  return <AuthGate />;
}

function AuthGate() {
  const rustSession = useRustSession();

  if (rustSession.state === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-(--color-bg-base) text-sm text-(--color-text-muted)">
        Loading…
      </div>
    );
  }

  if (rustSession.state === "signedOut") {
    return <Navigate to="/sign-in" replace />;
  }

  if (rustSession.state === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-(--color-bg-base) text-sm text-(--color-text-muted)">
        {rustSession.message}
      </div>
    );
  }

  return <AppShell />;
}

function AppShell() {
  const toggleSidebarPin = useUiStore((s) => s.toggleSidebarPin);
  const toggleSidebarHidden = useUiStore((s) => s.toggleSidebarHidden);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useCloudSync();
  useTaskEvents();

  // Global chrome shortcuts. All bindings come from `@/lib/shortcuts` —
  // edits to a binding live there, not here.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchShortcut(e, SHORTCUTS.toggleSidebarHide)) {
        e.preventDefault();
        toggleSidebarHidden();
        return;
      }
      if (matchShortcut(e, SHORTCUTS.toggleSidebarPin)) {
        e.preventDefault();
        toggleSidebarPin();
        return;
      }
      if (matchShortcut(e, SHORTCUTS.toggleRightPanel)) {
        // Don't steal ⌘⇧J — that's "Reload window" in some browsers.
        e.preventDefault();
        toggleRightPanel();
        return;
      }
      if (matchShortcut(e, SHORTCUTS.newWorkspace)) {
        const { activeWorkspaceContext, requestNewWorkspace } =
          useUiStore.getState();
        if (!activeWorkspaceContext) return;
        e.preventDefault();
        requestNewWorkspace(activeWorkspaceContext.repositoryId);
        return;
      }
      if (matchShortcut(e, SHORTCUTS.newTerminal)) {
        // Capture-phase + stopImmediatePropagation defeats Chromium's
        // built-in "new tab" reservation on ⌘T. Opens a new terminal
        // inner tab on the active workspace.
        const { activeWorkspaceContext, openInnerTerminalTab } =
          useUiStore.getState();
        if (!activeWorkspaceContext) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        openInnerTerminalTab(activeWorkspaceContext.workspaceId);
        return;
      }
      if (matchShortcut(e, SHORTCUTS.searchFiles)) {
        const state = useUiStore.getState();
        const ctx = state.activeWorkspaceContext;
        if (!ctx) return;
        const repos = queryClient.getQueryData<Repository[]>(
          repositoryKeys.list(),
        );
        const repoPath =
          repos?.find((r) => r.id === ctx.repositoryId)?.localPath ?? null;
        if (!repoPath) return;
        e.preventDefault();
        state.openFileSearch(ctx.repositoryId, repoPath);
        return;
      }
      if (matchShortcut(e, SHORTCUTS.closeActiveTab)) {
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
        const remainingTabs =
          useUiStore.getState().innerTabs[ctx.workspaceId]?.tabs.length ?? 0;
        if (remainingTabs === 0) {
          void navigate({
            to: "/repositories/$repositoryId",
            params: { repositoryId: ctx.repositoryId },
            replace: true,
          });
        }
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, [toggleSidebarPin, toggleSidebarHidden, toggleRightPanel, queryClient, navigate]);

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
      <NewTaskModal />
      <RenameWorkspaceModal />
      <AddRepositoryPickerModal />
      <RepoFileSearchModal />
      <GitInitConfirmModal />
    </div>
  );
}

export const Route = createFileRoute("/_app")({
  component: AppLayout,
});
