import { Link, useParams } from "@tanstack/react-router";
import { ChevronsLeft, ChevronsRight, GitBranch, Plus } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import { RepositorySidebarMenu } from "@/components/RepositorySidebarMenu";
import { WorkspaceSidebarMenu } from "@/components/WorkspaceSidebarMenu";
import { AgentMark, AGENT_META } from "@/components/ui/AgentMark";
import { DiffCount } from "@/components/ui/Chip";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { GroupHeader } from "@/components/ui/GroupHeader";
import { PanelState } from "@/components/ui/PanelState";
import { RepoMark } from "@/components/ui/RepoMark";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { StatusGlyph, type TaskStatusKind } from "@/components/ui/StatusBadge";
import { formatElapsed, isToday, type TaskLane } from "@/lib/board";
import { useBoardTasks, type BoardTask } from "@/lib/hooks/useBoardTasks";
import { useNow } from "@/lib/hooks/useNow";
import { useGitStatus } from "@/lib/hooks/useGit";
import { SHORTCUTS } from "@/lib/shortcuts";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, useUiStore } from "@/lib/store";
import type { Repository, Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "all" | "running" | "review";

const GROUPS: { lane: TaskLane; title: string }[] = [
  { lane: "needs-you", title: "Needs you" },
  { lane: "running", title: "Running" },
  { lane: "review", title: "Needs review" },
  { lane: "failed", title: "Failed" },
  { lane: "queued", title: "Queued" },
  { lane: "done", title: "Done · today" },
];

export const LANE_STATUS: Record<TaskLane, TaskStatusKind> = {
  queued: "queued",
  running: "running",
  "needs-you": "needs-you",
  review: "review",
  failed: "failed",
  done: "done",
};

/**
 * Task list (A: 264px left column). Tasks from every repository grouped by
 * what they need from you — running, review, failed, done today — with the
 * repositories (on the board) or the repo's in-place workspace (in a task)
 * underneath. ⌘B collapses it to a 48px rail.
 */
export function TaskSidebar() {
  const sidebarMode = useUiStore((s) => s.sidebarMode);
  const toggleSidebarPin = useUiStore((s) => s.toggleSidebarPin);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const repoFilter = useUiStore((s) => s.repoFilter);
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);
  const [resizing, setResizing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const params = useParams({ strict: false }) as { repositoryId?: string; workspaceId?: string };
  const { tasks, localWorkspaces, repositories, isLoading } = useBoardTasks(repoFilter);
  // Minute clock for "is it still today"; live timers tick in TaskMeta only,
  // so the sidebar and its rows don't re-render every second.
  const now = useNow(false);

  if (sidebarMode === "hidden") return null;
  // First run (no repositories yet) is a full-width screen (A-FirstRun).
  if (!isLoading && repositories.length === 0) return null;
  const newTaskRepo = params.repositoryId ?? repoFilter ?? repositories[0]?.id ?? null;
  const newTask = () => newTaskRepo && requestNewWorkspace(newTaskRepo);

  if (sidebarMode === "collapsed") {
    return (
      <TaskRail
        tasks={tasks}
        repositories={repositories}
        activeWorkspaceId={params.workspaceId ?? null}
        onExpand={toggleSidebarPin}
      />
    );
  }

  const visible = tasks.filter((t) => {
    if (t.lane === "done" && !isToday(t.workspace.archivedAt ?? t.workspace.finishedAt ?? t.workspace.updatedAt, now))
      return false;
    if (filter === "running") return t.lane === "running" || t.lane === "needs-you";
    if (filter === "review") return t.lane === "review";
    return true;
  });
  const count = (pred: (t: BoardTask) => boolean) => tasks.filter(pred).length;
  const runningCount = count((t) => t.lane === "running" || t.lane === "needs-you");
  const reviewCount = count((t) => t.lane === "review");
  const activeCount = count((t) => t.lane !== "done");

  return (
    <aside
      aria-label="Sidebar"
      style={{ width: sidebarWidth }}
      className={cn(
        "relative flex shrink-0 flex-col border-r border-(--color-border-subtle) bg-(--color-bg-sidebar)",
        !resizing && "transition-[width] duration-200 [transition-timing-function:var(--ease-glass)]",
      )}
    >
      <ResizeHandle
        edge="right"
        width={sidebarWidth}
        min={SIDEBAR_WIDTH_MIN}
        max={SIDEBAR_WIDTH_MAX}
        onResize={setSidebarWidth}
        onResizeStart={() => setResizing(true)}
        onResizeEnd={() => setResizing(false)}
      />
      <div className="flex items-center gap-2 px-3 pb-2 pt-3.5">
        <h2 className="m-0 text-[12px] font-semibold uppercase tracking-[0.04em] text-(--color-text-muted)">Tasks</h2>
        <span className="font-mono text-[11px] text-(--color-text-muted)">{activeCount}</span>
        <span className="flex-1" />
        <GlassTooltip content={`Collapse task list (${SHORTCUTS.toggleSidebarPin.display.join("")})`} side="bottom">
          <button
            type="button"
            aria-label="Collapse task list"
            onClick={toggleSidebarPin}
            className="grid size-6 place-items-center rounded-(--radius-control) border border-(--color-border-default) text-(--color-text-muted) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            <ChevronsLeft className="size-3.5" aria-hidden />
          </button>
        </GlassTooltip>
        <GlassTooltip content={`New task (${SHORTCUTS.newWorkspace.display.join("")})`} side="bottom">
          <button
            type="button"
            aria-label="New task"
            disabled={!newTaskRepo}
            onClick={newTask}
            className="grid size-6 place-items-center rounded-(--radius-control) bg-(--color-accent-500) text-(--color-accent-onfill) hover:bg-(--color-accent-400) disabled:opacity-40 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            <Plus className="size-3.5" strokeWidth={2.5} aria-hidden />
          </button>
        </GlassTooltip>
      </div>

      <div role="group" aria-label="Filter tasks" className="flex gap-1 px-3 pb-2.5">
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </FilterChip>
        <FilterChip active={filter === "running"} onClick={() => setFilter("running")}>
          Running {runningCount}
        </FilterChip>
        <FilterChip active={filter === "review"} onClick={() => setFilter("review")}>
          Review {reviewCount}
        </FilterChip>
      </div>

      <nav aria-label="Tasks" className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-2 pb-3">
        {isLoading && tasks.length === 0 ? <PanelState kind="loading" rows={4} className="px-1" /> : null}
        {!isLoading && visible.length === 0 ? (
          <p className="m-0 px-2 py-1 text-[12px] leading-[1.5] text-(--color-text-muted)">
            {tasks.length === 0
              ? "No tasks yet. Running, review and done tasks will group here."
              : "Nothing matches this filter."}
          </p>
        ) : null}
        {GROUPS.map(({ lane, title }) => {
          const rows = visible.filter((t) => t.lane === lane);
          if (rows.length === 0) return null;
          return (
            <section key={lane} aria-label={title} className="flex flex-col gap-0.5">
              <GroupHeader as="h3" className="px-1.5 py-1">
                {title}
              </GroupHeader>
              {rows.map((t) => (
                <TaskRow key={t.workspace.id} task={t} active={t.workspace.id === params.workspaceId} />
              ))}
            </section>
          );
        })}
        {params.workspaceId ? (
          <InPlaceGroup
            repositoryId={params.repositoryId ?? null}
            local={localWorkspaces}
            activeWorkspaceId={params.workspaceId}
          />
        ) : null}
      </nav>

      {!params.workspaceId ? <RepositoriesFooter repositories={repositories} tasks={tasks} /> : null}
    </aside>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-6 rounded-full border px-2 text-[11px] transition-colors duration-100",
        "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
        active
          ? "border-(--color-border-strong) bg-(--color-bg-elevated) text-(--color-text-primary)"
          : "border-(--color-border-default) text-(--color-text-muted) hover:text-(--color-text-secondary)",
      )}
    >
      {children}
    </button>
  );
}

function TaskMeta({ task }: { task: BoardTask }) {
  const ws = task.workspace;
  const now = useNow(task.lane === "running" || task.lane === "needs-you");
  switch (task.lane) {
    case "running":
      return <span className="font-mono text-[11px] text-(--color-text-muted)">{formatElapsed(ws.startedAt, now)}</span>;
    case "needs-you":
      return (
        <span className="font-mono text-[11px] text-(--color-warning)">
          needs you{task.attention ? ` ${formatElapsed(task.attention.since, now)}` : ""}
        </span>
      );
    case "review":
      return task.diff ? <DiffCount adds={task.diff.adds} removes={task.diff.removes} /> : null;
    case "failed":
      return (
        <span className="font-mono text-[11px] text-(--color-danger-text)">
          {ws.exitCode !== null ? `exit ${ws.exitCode}` : "failed"}
        </span>
      );
    case "done":
      return <span className="text-[11px]">{ws.status === "archived" ? "archived" : "done"}</span>;
    case "queued":
      return <span className="text-[11px] text-(--color-text-muted)">queued</span>;
  }
}

const TaskRow = memo(function TaskRow({ task, active }: { task: BoardTask; active: boolean }) {
  const ws = task.workspace;
  const done = task.lane === "done";
  return (
    <WorkspaceSidebarMenu workspace={ws}>
      <Link
        to="/repositories/$repositoryId/workspaces/$workspaceId"
        params={{ repositoryId: ws.repositoryId, workspaceId: ws.id }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex min-h-(--row-task) flex-col justify-center gap-1 rounded-(--radius-control) px-2 py-1.5 no-underline transition-colors duration-100",
          "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
          active
            ? "bg-(--color-bg-selected) outline outline-1 -outline-offset-1 outline-(--color-border-selected)"
            : "hover:bg-(--color-bg-hover)",
          done ? "text-(--color-text-muted)" : "text-(--color-text-primary)",
        )}
      >
        <span className="flex items-center gap-2">
          <StatusGlyph kind={LANE_STATUS[task.lane]} halo={active && task.lane === "running"} />
          <span className={cn("min-w-0 flex-1 truncate leading-[1.35]", !done && "font-medium")}>{ws.name}</span>
          <TaskMeta task={task} />
        </span>
        {!done ? (
          <span className="flex min-w-0 items-center gap-1.5 pl-4 text-[11px] text-(--color-text-muted)">
            <AgentMark agent={ws.agent} />
            <span className="shrink-0">{ws.agent ? AGENT_META[ws.agent].label : "Agent"}</span>
            {ws.branch ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate font-mono">{ws.branch}</span>
              </>
            ) : null}
          </span>
        ) : null}
      </Link>
    </WorkspaceSidebarMenu>
  );
});

/** In a task session: the repo's in-place workspace ("local · main clean"). */
function InPlaceGroup({
  repositoryId,
  local,
  activeWorkspaceId,
}: {
  repositoryId: string | null;
  local: Workspace[];
  activeWorkspaceId: string;
}) {
  const ws = local.find((w) => w.repositoryId === repositoryId) ?? null;
  const status = useGitStatus(ws?.id);
  if (!ws) return null;
  const changed = status.data?.length ?? null;
  const active = ws.id === activeWorkspaceId;
  return (
    <section aria-label="Workspaces" className="flex flex-col gap-0.5">
      <GroupHeader as="h3" className="px-1.5 py-1">
        Workspaces
      </GroupHeader>
      <Link
        to="/repositories/$repositoryId/workspaces/$workspaceId"
        params={{ repositoryId: ws.repositoryId, workspaceId: ws.id }}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-2 rounded-(--radius-control) p-2 text-(--color-text-secondary) no-underline transition-colors duration-100",
          "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
          active ? "bg-(--color-bg-selected) text-(--color-text-primary)" : "hover:bg-(--color-bg-hover)",
        )}
      >
        <GitBranch className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          local · <span className="font-mono text-[11px]">{ws.branch ?? "checkout"}</span>
        </span>
        <span className="text-[11px] text-(--color-text-muted)">
          {changed === null ? "" : changed === 0 ? "clean" : `${changed} changed`}
        </span>
      </Link>
    </section>
  );
}

function RepositoriesFooter({ repositories, tasks }: { repositories: Repository[]; tasks: BoardTask[] }) {
  const openAddRepositoryPicker = useUiStore((s) => s.openAddRepositoryPicker);
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);
  const setRepoFilter = useUiStore((s) => s.setRepoFilter);
  const repoFilter = useUiStore((s) => s.repoFilter);
  return (
    <div className="flex flex-col gap-1.5 border-t border-(--color-border-subtle) px-3 py-2.5">
      <GroupHeader as="h3">Repositories</GroupHeader>
      <nav aria-label="Repositories" className="flex flex-col">
        {repositories.map((r) => (
          <RepositorySidebarMenu key={r.id} repository={r}>
            <div
              className={cn(
                "group/repo -mx-1.5 flex h-7 items-center gap-2 rounded-(--radius-control) px-1.5",
                repoFilter === r.id && "bg-(--color-bg-elevated)",
              )}
            >
              <button
                type="button"
                aria-label={r.name}
                aria-pressed={repoFilter === r.id}
                onClick={() => setRepoFilter(repoFilter === r.id ? null : r.id)}
                className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
              >
                <RepoMark id={r.id} name={r.name} />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="font-mono text-[11px] text-(--color-text-muted) group-hover/repo:hidden">
                  {tasks.filter((t) => t.workspace.repositoryId === r.id && t.lane !== "done").length}
                </span>
              </button>
              <button
                type="button"
                aria-label={`New workspace in ${r.name}`}
                onClick={() => requestNewWorkspace(r.id)}
                className="hidden size-5 place-items-center rounded-(--radius-chip) text-(--color-text-muted) hover:bg-(--color-bg-active) hover:text-(--color-text-primary) focus-visible:grid focus-visible:outline-none focus-visible:shadow-(--ring-focus) group-hover/repo:grid"
              >
                <Plus className="size-3" aria-hidden />
              </button>
            </div>
          </RepositorySidebarMenu>
        ))}
      </nav>
      <button
        type="button"
        onClick={openAddRepositoryPicker}
        className="flex h-7 items-center gap-1.5 rounded-(--radius-control) border border-dashed border-(--color-border-strong) px-2 text-[12px] text-(--color-text-muted) hover:text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
      >
        <Plus className="size-3" aria-hidden />
        Add repository
      </button>
    </div>
  );
}

/** ⌘B collapsed: 48px rail of agent marks with status rings (A-Compact). */
function TaskRail({
  tasks,
  repositories,
  activeWorkspaceId,
  onExpand,
}: {
  tasks: BoardTask[];
  repositories: Repository[];
  activeWorkspaceId: string | null;
  onExpand: () => void;
}) {
  const live = tasks.filter((t) => t.lane !== "done" && t.lane !== "queued");
  const shown = live.slice(0, 6);
  const more = live.length - shown.length;
  return (
    <aside
      aria-label="Sidebar"
      className="flex w-(--layout-rail-left) shrink-0 flex-col items-center gap-2 border-r border-(--color-border-subtle) bg-(--color-bg-sidebar) py-3"
    >
      <GlassTooltip content={`Expand task list (${SHORTCUTS.toggleSidebarPin.display.join("")})`} side="right">
        <button
          type="button"
          aria-label="Expand task list"
          onClick={onExpand}
          className="grid size-7 place-items-center rounded-(--radius-control) border border-(--color-border-default) text-(--color-text-muted) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          <ChevronsRight className="size-3.5" aria-hidden />
        </button>
      </GlassTooltip>
      <nav aria-label="Tasks" className="flex flex-col items-center gap-2 pt-1">
        {shown.map((t) => {
          const active = t.workspace.id === activeWorkspaceId;
          return (
            <GlassTooltip key={t.workspace.id} content={t.workspace.name} side="right">
              <Link
                to="/repositories/$repositoryId/workspaces/$workspaceId"
                params={{ repositoryId: t.workspace.repositoryId, workspaceId: t.workspace.id }}
                aria-label={t.workspace.name}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative grid size-8 place-items-center rounded-(--radius-control) focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
                  active ? "bg-(--color-bg-elevated) outline outline-1 outline-(--color-border-selected)" : "hover:bg-(--color-bg-hover)",
                )}
              >
                <AgentMark agent={t.workspace.agent} size="lg" />
                <StatusGlyph
                  kind={LANE_STATUS[t.lane]}
                  size={6}
                  className="absolute right-0.5 top-0.5 ring-2 ring-(--color-bg-sidebar)"
                />
              </Link>
            </GlassTooltip>
          );
        })}
        {more > 0 ? <span className="font-mono text-[11px] text-(--color-text-muted)">+{more}</span> : null}
      </nav>
      <div className="flex-1" />
      {repositories.slice(0, 4).map((r) => (
        <GlassTooltip key={r.id} content={r.name} side="right">
          <span>
            <RepoMark id={r.id} name={r.name} size={16} />
          </span>
        </GlassTooltip>
      ))}
    </aside>
  );
}
