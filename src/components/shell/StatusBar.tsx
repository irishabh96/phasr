import { useLocation, useParams } from "@tanstack/react-router";
import { useBoardTasks } from "@/lib/hooks/useBoardTasks";
import { useSystemStatus } from "@/lib/hooks/useTaskCards";
import { useUiStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * 28px mono status bar (A): sync health, live agent and worktree counts on
 * the left; the keys that matter on this screen on the right.
 */
export function StatusBar() {
  const { tasks } = useBoardTasks(null);
  const { data: system } = useSystemStatus();
  const cloudSync = useUiStore((s) => s.cloudSync);
  const params = useParams({ strict: false }) as { workspaceId?: string };
  const onBoard = useLocation().pathname === "/";
  // Backend counts when available (real PTYs / worktrees on disk); derived otherwise.
  const agents =
    system?.agentsRunning ?? tasks.filter((t) => t.lane === "running" || t.lane === "needs-you").length;
  const worktrees =
    system?.worktrees ?? tasks.filter((t) => t.workspace.status !== "archived" && !!t.workspace.worktreePath).length;
  const syncError = system ? system.sync === "error" : cloudSync.state === "error";
  const syncLabel = system?.sync === "off" ? "sync off" : system?.sync === "syncing" ? "syncing…" : syncError ? "sync error — retrying" : "synced";
  const hints = params.workspaceId
    ? "⌘I inspector · ⌘B tasks · ⌘K anything"
    : onBoard
      ? "⌘N new task · ⌘K anything"
      : "⌘K anything";

  return (
    <footer className="flex h-(--layout-statusbar-height) shrink-0 items-center gap-4 border-t border-(--color-border-subtle) bg-(--color-bg-base) px-6 font-mono text-[11px] text-(--color-text-muted)">
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            syncError ? "bg-(--color-danger)" : system?.sync === "off" ? "bg-(--color-text-faint)" : "bg-(--color-success)",
          )}
        />
        {syncLabel}
      </span>
      <span>
        {agents} {agents === 1 ? "agent" : "agents"} · {worktrees} {worktrees === 1 ? "worktree" : "worktrees"}
      </span>
      <span className="flex-1" />
      <span>{hints}</span>
    </footer>
  );
}
