import { Link, useParams } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronsRight, GitBranch, PanelLeft, Plus } from "lucide-react";
import { memo, useMemo, useRef } from "react";
import { RepositorySidebarMenu } from "@/components/RepositorySidebarMenu";
import { SlidePanel } from "@/components/shell/SlidePanel";
import { WorkspaceSidebarMenu } from "@/components/WorkspaceSidebarMenu";
import { AgentMark } from "@/components/ui/AgentMark";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { PanelState } from "@/components/ui/PanelState";
import { RepoMark } from "@/components/ui/RepoMark";
import type { TaskStatusKind } from "@/components/ui/StatusBadge";
import { isToday, type TaskLane } from "@/lib/board";
import { useBoardTasks, type BoardTask } from "@/lib/hooks/useBoardTasks";
import { useNow } from "@/lib/hooks/useNow";
import { useGitStatus } from "@/lib/hooks/useGit";
import { SHORTCUTS } from "@/lib/shortcuts";
import { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN, useUiStore } from "@/lib/store";
import type { Repository, Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Sidebar groups (A-Polish, spec §4.2): what each task needs from you.
 * Failed tasks need action, so they sit in "Needs you" with a red dot (the
 * board does the same). Queued/draft tasks live on the board only, as drawn.
 */
const GROUPS: { title: string; lanes: TaskLane[] }[] = [
  { title: "Needs you", lanes: ["needs-you", "failed"] },
  { title: "Running", lanes: ["running"] },
  { title: "Review", lanes: ["review"] },
  { title: "Done", lanes: ["done"] },
];

/** Above this many rows the list renders through a virtualizer (spec P5). */
const VIRTUALIZE_ABOVE = 200;
const ROW_H = 32;
const HEADER_H = 26;
const GROUP_GAP = 18;

export const LANE_STATUS: Record<TaskLane, TaskStatusKind> = {
  queued: "queued",
  running: "running",
  "needs-you": "needs-you",
  review: "review",
  failed: "failed",
  done: "done",
};

/** Lane dot colour (review is violet in the sidebar, A-Polish). */
const LANE_COLOR: Record<TaskLane, string> = {
  queued: "var(--color-status-queued)",
  running: "var(--color-status-running)",
  "needs-you": "var(--color-status-attention)",
  review: "var(--color-status-review)",
  failed: "var(--color-status-danger)",
  done: "var(--color-status-success)",
};

/**
 * Task list (A: 248px left column). Tasks from every repository grouped by
 * what they need from you, one 32px line each, with the repositories (on the
 * board) or the repo's in-place checkout (in a task) underneath. ⌘B slides
 * it away to a 48px rail.
 */
export function TaskSidebar() {
  const sidebarMode = useUiStore((s) => s.sidebarMode);
  const toggleSidebarPin = useUiStore((s) => s.toggleSidebarPin);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const repoFilter = useUiStore((s) => s.repoFilter);
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);
  const params = useParams({ strict: false }) as { repositoryId?: string; workspaceId?: string };
  const { tasks, localWorkspaces, repositories, isLoading } = useBoardTasks(repoFilter);

  if (sidebarMode === "hidden") return null;
  // First run (no repositories yet) is a full-width screen (A-FirstRun).
  if (!isLoading && repositories.length === 0) return null;
  const newTaskRepo = params.repositoryId ?? repoFilter ?? repositories[0]?.id ?? null;
  const newTask = () => newTaskRepo && requestNewWorkspace(newTaskRepo);

  return (
    <SlidePanel
      side="left"
      label="Sidebar"
      open={sidebarMode === "pinned"}
      width={sidebarWidth}
      railWidth="var(--layout-rail-left)"
      panelClassName="flex flex-col"
      resize={{ min: SIDEBAR_WIDTH_MIN, max: SIDEBAR_WIDTH_MAX, onResize: setSidebarWidth }}
      rail={
        <TaskRail
          tasks={tasks}
          repositories={repositories}
          activeWorkspaceId={params.workspaceId ?? null}
          onExpand={toggleSidebarPin}
        />
      }
    >
      <div className="flex h-[44px] shrink-0 items-center gap-[4px] pl-[16px] pr-[10px]">
        <h2 className="m-0 flex-1 text-[13px] font-medium text-(--color-text-primary)">Tasks</h2>
        <GlassTooltip content={`Collapse task list (${SHORTCUTS.toggleSidebarPin.display.join("")})`} side="bottom">
          <button
            type="button"
            aria-label="Collapse task list"
            onClick={toggleSidebarPin}
            className={cn(headerIconClass, "text-(--color-text-muted)")}
          >
            <PanelLeft className="size-[14px]" aria-hidden />
          </button>
        </GlassTooltip>
        <GlassTooltip content={`New task (${SHORTCUTS.newWorkspace.display.join("")})`} side="bottom">
          <button
            type="button"
            aria-label="New task"
            disabled={!newTaskRepo}
            onClick={newTask}
            className={cn(headerIconClass, "text-(--color-text-secondary) disabled:opacity-40")}
          >
            <Plus className="size-[14px]" aria-hidden />
          </button>
        </GlassTooltip>
      </div>

      <TaskGroups tasks={tasks} isLoading={isLoading} activeWorkspaceId={params.workspaceId ?? null} />

      {params.workspaceId ? (
        <InPlaceFooter
          repositoryId={params.repositoryId ?? null}
          local={localWorkspaces}
          activeWorkspaceId={params.workspaceId}
        />
      ) : (
        <RepositoriesFooter repositories={repositories} />
      )}
    </SlidePanel>
  );
}

const headerIconClass = cn(
  "grid size-[26px] place-items-center rounded-(--radius-control) transition-colors duration-(--dur-1)",
  "hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
  "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
);

type ListItem =
  | { kind: "header"; key: string; title: string; first: boolean }
  | { kind: "row"; key: string; task: BoardTask };

function TaskGroups({
  tasks,
  isLoading,
  activeWorkspaceId,
}: {
  tasks: BoardTask[];
  isLoading: boolean;
  activeWorkspaceId: string | null;
}) {
  // Minute clock for "is it still today"; rows carry no timers, so nothing
  // here re-renders every second.
  const now = useNow(false);
  const groups = useMemo(() => {
    const visible = tasks.filter(
      (t) =>
        t.lane !== "done" ||
        isToday(t.workspace.archivedAt ?? t.workspace.finishedAt ?? t.workspace.updatedAt, now),
    );
    return GROUPS.map(({ title, lanes }) => ({
      title,
      // Lane order inside a group: needs-you before failed.
      rows: lanes.flatMap((lane) => visible.filter((t) => t.lane === lane)),
    })).filter((g) => g.rows.length > 0);
  }, [tasks, now]);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  if (total > VIRTUALIZE_ABOVE) {
    return <VirtualTaskList groups={groups} activeWorkspaceId={activeWorkspaceId} />;
  }

  return (
    <nav aria-label="Tasks" className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-[8px] pb-[12px] pt-[2px]">
      {isLoading && tasks.length === 0 ? <PanelState kind="loading" rows={4} className="px-1" /> : null}
      {!isLoading && total === 0 ? (
        <p className="m-0 px-[8px] py-[4px] text-[12px] leading-[1.5] text-(--color-text-muted)">
          No tasks yet. Tasks that need you, are running or wait for review group here.
        </p>
      ) : null}
      {groups.map(({ title, rows }) => (
        <section key={title} aria-label={title} className="flex flex-col gap-px">
          <GroupTitle>{title}</GroupTitle>
          {rows.map((t) => (
            <TaskRow key={t.workspace.id} task={t} active={t.workspace.id === activeWorkspaceId} />
          ))}
        </section>
      ))}
    </nav>
  );
}

function GroupTitle({ children }: { children: string }) {
  return (
    <h3 className="m-0 flex h-[26px] shrink-0 items-center px-[8px] text-[12px] font-normal text-(--color-text-muted)">
      {children}
    </h3>
  );
}

/** P5: hundreds of tasks scroll through a fixed-row virtualizer. */
function VirtualTaskList({
  groups,
  activeWorkspaceId,
}: {
  groups: { title: string; rows: BoardTask[] }[];
  activeWorkspaceId: string | null;
}) {
  const scrollRef = useRef<HTMLElement>(null);
  const items = useMemo(() => {
    const out: ListItem[] = [];
    groups.forEach((g, i) => {
      out.push({ kind: "header", key: `h:${g.title}`, title: g.title, first: i === 0 });
      for (const t of g.rows) out.push({ kind: "row", key: t.workspace.id, task: t });
    });
    return out;
  }, [groups]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const it = items[i]!;
      return it.kind === "row" ? ROW_H + 1 : HEADER_H + (it.first ? 0 : GROUP_GAP);
    },
    getItemKey: (i) => items[i]!.key,
    overscan: 12,
  });

  return (
    <nav ref={scrollRef} aria-label="Tasks" className="min-h-0 flex-1 overflow-y-auto px-[8px] pb-[12px] pt-[2px]">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const it = items[v.index]!;
          return (
            <div
              key={v.key}
              className="absolute inset-x-0 top-0 flex flex-col justify-end"
              style={{ height: v.size, transform: `translateY(${v.start}px)` }}
            >
              {it.kind === "header" ? (
                <GroupTitle>{it.title}</GroupTitle>
              ) : (
                <div className="pb-px">
                  <TaskRow task={it.task} active={it.task.workspace.id === activeWorkspaceId} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

/** 6px status dot (A-Polish row): lane colour, failed in red. */
function LaneDot({ lane }: { lane: TaskLane }) {
  return <span aria-hidden className="size-[6px] shrink-0 rounded-full" style={{ background: LANE_COLOR[lane] }} />;
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
        title={task.lane === "failed" ? `${ws.name} — failed` : undefined}
        className={cn(
          "flex h-[32px] items-center gap-[10px] rounded-(--radius-control) px-[8px] no-underline transition-colors duration-(--dur-1)",
          "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
          active ? "bg-(--color-bg-elevated) font-medium" : "hover:bg-(--color-bg-surface)",
          done && !active ? "text-(--color-text-muted)" : "text-(--color-text-primary)",
        )}
      >
        {done ? (
          <Check aria-hidden className="-mx-[3px] size-[12px] shrink-0 text-(--color-success)" strokeWidth={2.5} />
        ) : (
          <LaneDot lane={task.lane} />
        )}
        <span className="min-w-0 flex-1 truncate">{ws.name}</span>
        {done ? null : <AgentMark agent={ws.agent} className="size-[14px] text-[8px]" />}
      </Link>
    </WorkspaceSidebarMenu>
  );
});

/** In a task session: one line for the repo's in-place checkout. */
function InPlaceFooter({
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
    <div className="shrink-0 px-[8px] pb-[6px] pt-[4px]">
      <Link
        to="/repositories/$repositoryId/workspaces/$workspaceId"
        params={{ repositoryId: ws.repositoryId, workspaceId: ws.id }}
        aria-current={active ? "page" : undefined}
        aria-label={`Local checkout, ${ws.branch ?? "checkout"}${changed === null ? "" : changed === 0 ? ", clean" : `, ${changed} changed`}`}
        className={cn(
          "flex h-[32px] items-center gap-[8px] rounded-(--radius-control) px-[8px] text-[12px] text-(--color-text-muted) no-underline transition-colors duration-(--dur-1)",
          "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
          active ? "bg-(--color-bg-elevated) text-(--color-text-secondary)" : "hover:bg-(--color-bg-surface) hover:text-(--color-text-secondary)",
        )}
      >
        <GitBranch className="size-[12px] shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          local · <span className="font-mono text-[11px]">{ws.branch ?? "checkout"}</span>
        </span>
        <span className="tabular-nums">{changed === null ? "" : changed === 0 ? "clean" : `${changed} changed`}</span>
      </Link>
    </div>
  );
}

function RepositoriesFooter({ repositories }: { repositories: Repository[] }) {
  const openAddRepositoryPicker = useUiStore((s) => s.openAddRepositoryPicker);
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);
  const setRepoFilter = useUiStore((s) => s.setRepoFilter);
  const repoFilter = useUiStore((s) => s.repoFilter);
  return (
    <div className="flex shrink-0 flex-col gap-px px-[8px] pb-[12px] pt-[10px]">
      <GroupTitle>Repositories</GroupTitle>
      <nav aria-label="Repositories" className="flex flex-col gap-px">
        {repositories.map((r) => {
          const on = repoFilter === r.id;
          return (
            <RepositorySidebarMenu key={r.id} repository={r}>
              <div
                className={cn(
                  "group/repo flex h-[32px] items-center gap-[8px] rounded-(--radius-control) pr-[4px] transition-colors duration-(--dur-1)",
                  on ? "bg-(--color-bg-elevated) text-(--color-text-primary)" : "text-(--color-text-secondary) hover:bg-(--color-bg-surface) hover:text-(--color-text-primary)",
                )}
              >
                <button
                  type="button"
                  aria-label={r.name}
                  aria-pressed={on}
                  onClick={() => setRepoFilter(on ? null : r.id)}
                  className="flex h-full min-w-0 flex-1 items-center gap-[10px] rounded-(--radius-control) px-[8px] text-left focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
                >
                  <RepoMark id={r.id} name={r.name} />
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`New workspace in ${r.name}`}
                  onClick={() => requestNewWorkspace(r.id)}
                  className="hidden size-[24px] place-items-center rounded-(--radius-chip) text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:grid focus-visible:outline-none focus-visible:shadow-(--ring-focus) group-hover/repo:grid"
                >
                  <Plus className="size-[12px]" aria-hidden />
                </button>
              </div>
            </RepositorySidebarMenu>
          );
        })}
      </nav>
      <button
        type="button"
        onClick={openAddRepositoryPicker}
        className="flex h-[32px] items-center gap-[10px] rounded-(--radius-control) px-[8px] text-left text-[13px] text-(--color-text-muted) transition-colors duration-(--dur-1) hover:bg-(--color-bg-surface) hover:text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
      >
        <Plus className="size-[14px]" aria-hidden />
        Add repository
      </button>
    </div>
  );
}

/** ⌘B collapsed: 48px rail of agent marks with status dots (A-Compact). */
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
    <div className="flex flex-1 flex-col items-center gap-[4px] py-[10px]">
      <GlassTooltip content={`Expand task list (${SHORTCUTS.toggleSidebarPin.display.join("")})`} side="right">
        <button
          type="button"
          aria-label="Expand task list"
          onClick={onExpand}
          className={cn(headerIconClass, "size-[28px] text-(--color-text-muted)")}
        >
          <ChevronsRight className="size-[14px]" aria-hidden />
        </button>
      </GlassTooltip>
      <nav aria-label="Tasks" className="flex flex-col items-center gap-[4px] pt-[4px]">
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
                  "relative grid size-[32px] place-items-center rounded-(--radius-control) transition-colors duration-(--dur-1) focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
                  active ? "bg-(--color-bg-elevated)" : "hover:bg-(--color-bg-surface)",
                )}
              >
                <AgentMark agent={t.workspace.agent} className="size-[14px] text-[9px]" />
                <span
                  aria-hidden
                  className="absolute bottom-[6px] right-[6px] size-[6px] rounded-full ring-2 ring-(--color-bg-sidebar)"
                  style={{ background: LANE_COLOR[t.lane] }}
                />
              </Link>
            </GlassTooltip>
          );
        })}
        {more > 0 ? <span className="text-[11px] tabular-nums text-(--color-text-muted)">+{more}</span> : null}
      </nav>
      <div className="flex-1" />
      {repositories.slice(0, 4).map((r) => (
        <GlassTooltip key={r.id} content={r.name} side="right">
          <span>
            <RepoMark id={r.id} name={r.name} size={16} />
          </span>
        </GlassTooltip>
      ))}
    </div>
  );
}
