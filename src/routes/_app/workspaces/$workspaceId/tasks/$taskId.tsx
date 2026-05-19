import { useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Square } from "lucide-react";
import { useCallback } from "react";
import { ChangesPanel } from "@/components/ChangesPanel";
import { Terminal } from "@/components/Terminal";
import { useTask } from "@/lib/hooks/useTasks";
import { tauri } from "@/lib/tauri";

function TaskDetail() {
  const { workspaceId, taskId } = Route.useParams();
  const { data: task } = useTask(taskId);
  const queryClient = useQueryClient();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["tasks", "detail", taskId] });
    queryClient.invalidateQueries({ queryKey: ["tasks", "workspace", workspaceId] });
  }, [queryClient, taskId, workspaceId]);

  const handleStop = async () => {
    try {
      await tauri.stopTask(taskId);
      refresh();
    } catch (err) {
      console.error("stop failed", err);
    }
  };

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-(--color-text-muted)">
        Loading task…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-(--color-border-subtle) bg-(--color-bg-surface) px-6 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/workspaces/$workspaceId"
            params={{ workspaceId }}
            className="text-(--color-text-secondary) hover:text-(--color-text-primary)"
          >
            <ArrowLeft size={16} />
          </Link>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{task.name}</div>
            <code className="block truncate text-xs text-(--color-text-muted)">
              {task.command}
            </code>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill status={task.status} />
          {task.status === "running" && (
            <button
              type="button"
              onClick={handleStop}
              className="flex items-center gap-1 rounded-md border border-(--color-danger) bg-(--color-danger)/15 px-2.5 py-1 text-xs text-(--color-danger) hover:bg-(--color-danger)/25"
            >
              <Square size={12} fill="currentColor" />
              Stop
            </button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1">
          <Terminal taskId={taskId} status={task.status} onExit={refresh} />
        </div>
        {task.worktreePath && (
          <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-(--color-border-subtle) bg-(--color-bg-surface)">
            <ChangesPanel taskId={taskId} />
          </aside>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const color =
    {
      running: "var(--color-info)",
      completed: "var(--color-success)",
      failed: "var(--color-danger)",
      stopped: "var(--color-warning)",
      archived: "var(--color-text-muted)",
      pending: "var(--color-text-secondary)",
    }[status] ?? "var(--color-text-secondary)";
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide"
      style={{
        background: `color-mix(in oklab, ${color} 15%, transparent)`,
        color,
      }}
    >
      {status}
    </span>
  );
}

export const Route = createFileRoute("/_app/workspaces/$workspaceId/tasks/$taskId")({
  component: TaskDetail,
});
