import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, ShieldAlert } from "lucide-react";
import { memo } from "react";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { Chip, DiffCount } from "@/components/ui/Chip";
import { RepoMark } from "@/components/ui/RepoMark";
import { WorkspaceSidebarMenu } from "@/components/WorkspaceSidebarMenu";
import { formatAgo, formatElapsed } from "@/lib/board";
import type { BoardTask } from "@/lib/hooks/useBoardTasks";
import { useNow } from "@/lib/hooks/useNow";
import { useStartQueuedTask } from "@/lib/hooks/useTaskCards";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * Board card (A-System "TASK CARD"): repo + meta, title, the lane's detail,
 * agent · branch. The whole card opens the task (review lane opens on the
 * Changes pane). Done cards are quieter.
 */
export const TaskCard = memo(function TaskCard({ task }: { task: BoardTask }) {
  const ws = task.workspace;
  const done = task.lane === "done";
  // Each card owns its clock: per second only while its own timer is live,
  // else per minute ("finished 18m ago"). The board above never ticks.
  const now = useNow(task.lane === "running" || task.lane === "needs-you");
  const agentLabel = ws.agent ? AGENT_META[ws.agent].label : "Agent";
  const finished = task.finishedAt ?? ws.finishedAt ?? ws.updatedAt;

  if (task.notStarted) return <QueuedCard task={task} />;

  if (done) {
    return (
      <WorkspaceSidebarMenu workspace={ws}>
        <Link
          to="/repositories/$repositoryId/workspaces/$workspaceId"
          params={{ repositoryId: ws.repositoryId, workspaceId: ws.id }}
          data-board-card
          className="flex flex-col gap-1.5 rounded-(--radius-card) border border-(--color-border-subtle) bg-(--color-bg-sheet) p-3 text-(--color-text-muted) no-underline focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          <span className="font-medium text-(--color-text-secondary)">{ws.name}</span>
          <span className="text-[11px]">
            {ws.outcome === "merged"
              ? `merged into ${ws.mergedInto ?? ws.baseBranch ?? "main"}${ws.prNumber ? ` · PR #${ws.prNumber}` : ""}`
              : ws.outcome === "closed"
                ? "closed without merge · notes kept"
                : `${ws.status === "archived" ? "archived" : "finished"} ${formatAgo(ws.archivedAt ?? finished, now)}`}
            {task.repository ? ` · ${task.repository.name}` : ""}
          </span>
        </Link>
      </WorkspaceSidebarMenu>
    );
  }

  return (
    <WorkspaceSidebarMenu workspace={ws}>
      <Link
        to="/repositories/$repositoryId/workspaces/$workspaceId"
        params={{ repositoryId: ws.repositoryId, workspaceId: ws.id }}
        {...(task.lane === "review" ? { search: { pane: "changes" } as never } : {})}
        data-board-card
        data-lane={task.lane}
        className={cn(
          "flex flex-col gap-2 rounded-(--radius-card) border bg-(--color-bg-surface) p-3 text-(--color-text-primary) no-underline",
          "transition-colors duration-100 hover:border-(--color-border-strong)",
          "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
          task.lane === "needs-you" ? "border-(--color-warning)" : "border-(--color-border-default)",
        )}
      >
        <span className="flex items-center gap-1.5 text-[11px] text-(--color-text-muted)">
          {task.repository ? <RepoMark id={task.repository.id} name={task.repository.name} size={12} /> : null}
          <span className="truncate">{task.repository?.name}</span>
          <span className="flex-1" />
          {task.lane === "running" || task.lane === "needs-you" ? (
            <span className="font-mono">{formatElapsed(ws.startedAt, now)}</span>
          ) : task.diff ? (
            <DiffCount adds={task.diff.adds} removes={task.diff.removes} />
          ) : null}
        </span>
        <span className="font-medium leading-[1.35]">{ws.name}</span>
        {task.lane === "review" && task.diff ? (
          <span className="flex flex-wrap gap-1.5">
            <Chip>
              {task.diff.files} {task.diff.files === 1 ? "file" : "files"}
            </Chip>
          </span>
        ) : null}
        {task.lane === "failed" ? (
          <span className="text-[12px] text-(--color-danger-text)">
            Agent exited{ws.exitCode !== null ? ` with code ${ws.exitCode}` : ""} — open to see the log
          </span>
        ) : null}
        {task.lane === "needs-you" ? (
          <span className="flex items-start gap-1.5 text-[12px] text-(--color-warning)">
            <ShieldAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            <span className="min-w-0">
              Waiting for your approval
              {task.attention?.detail ? (
                <>
                  {": "}
                  <span className="font-mono">{task.attention.detail}</span>
                </>
              ) : task.attention ? (
                <>{`: ${task.attention.title}`}</>
              ) : null}
            </span>
          </span>
        ) : task.lane === "running" && task.activity ? (
          <span className="line-clamp-2 rounded-(--radius-control) bg-(--color-bg-base) px-2 py-1.5 font-mono text-[12px] leading-[1.5] text-(--color-text-secondary)">
            › {task.activity}
          </span>
        ) : null}
        {ws.prompt && (task.lane === "queued" || (task.lane === "running" && !task.activity)) ? (
          <span className="line-clamp-2 rounded-(--radius-control) bg-(--color-bg-base) px-2 py-1.5 font-mono text-[12px] leading-[1.5] text-(--color-text-secondary)">
            › {ws.prompt}
          </span>
        ) : null}
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-(--color-text-muted)">
          <span className="flex shrink-0 items-center gap-1">
            <AgentMark agent={ws.agent} />
            {agentLabel}
          </span>
          <span aria-hidden>·</span>
          {task.lane === "review" ? (
            <span className="truncate">finished {formatAgo(finished, now)}</span>
          ) : (
            <span className="truncate font-mono">{ws.branch}</span>
          )}

        </span>
      </Link>
    </WorkspaceSidebarMenu>
  );
});

/**
 * Queued / draft card: never started, so it opens nothing yet. "Start now"
 * launches it (worktree + agent) and opens the session.
 */
function QueuedCard({ task }: { task: BoardTask }) {
  const ws = task.workspace;
  const start = useStartQueuedTask();
  const navigate = useNavigate();
  return (
    <WorkspaceSidebarMenu workspace={ws}>
      <article
        data-lane="queued"
        className="flex cursor-default flex-col gap-2 rounded-(--radius-card) border border-(--color-border-default) bg-(--color-bg-surface) p-3"
      >
        <span className="flex items-center gap-1.5 text-[11px] text-(--color-text-muted)">
          {task.repository ? <RepoMark id={task.repository.id} name={task.repository.name} size={12} /> : null}
          <span className="truncate">{task.repository?.name}</span>
          <span className="flex-1" />
          <span>{ws.queuedAt ? "queued" : "draft"}</span>
        </span>
        <span className="font-medium leading-[1.35]">{ws.name}</span>
        {ws.prompt ? (
          <span className="line-clamp-2 text-[12px] leading-[1.5] text-(--color-text-secondary)">{ws.prompt}</span>
        ) : null}
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-(--color-text-muted)">
          <span className="flex shrink-0 items-center gap-1">
            <AgentMark agent={ws.agent} />
            {ws.agent ? AGENT_META[ws.agent].label : "Agent"}
          </span>
          {task.dependsOnName ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">waits for {task.dependsOnName}</span>
            </>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            disabled={start.isPending}
            onClick={() =>
              start.mutate(
                { id: ws.id },
                {
                  onSuccess: (started) =>
                    void navigate({
                      to: "/repositories/$repositoryId/workspaces/$workspaceId",
                      params: { repositoryId: started.workspace.repositoryId, workspaceId: started.workspace.id },
                    }),
                  onError: (err) =>
                    showToast({ intent: "error", title: "Couldn't start the task", message: humanizeError(err) }),
                },
              )
            }
            className="flex shrink-0 items-center gap-1 rounded-(--radius-chip) px-1 text-(--color-text-secondary) hover:text-(--color-text-primary) disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            {start.isPending ? "Starting…" : "Start now"} <ArrowRight className="size-3" aria-hidden />
          </button>
        </span>
      </article>
    </WorkspaceSidebarMenu>
  );
}
