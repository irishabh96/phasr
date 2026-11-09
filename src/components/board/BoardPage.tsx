import { Link } from "@tanstack/react-router";
import { ListFilter, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { LANE_STATUS } from "@/components/shell/TaskSidebar";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { DiffCount } from "@/components/ui/Chip";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { StatusBadge, StatusGlyph } from "@/components/ui/StatusBadge";
import { formatAgo, formatElapsed, visibleBoardTasks, type TaskLane } from "@/lib/board";
import { useBoardTasks, type BoardTask } from "@/lib/hooks/useBoardTasks";
import { useNow } from "@/lib/hooks/useNow";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { TaskCard } from "./TaskCard";

const COLUMNS: { id: string; title: string; status: Parameters<typeof StatusGlyph>[0]["kind"]; lanes: TaskLane[] }[] = [
  { id: "queued", title: "Queued", status: "queued", lanes: ["queued"] },
  { id: "running", title: "Running", status: "running", lanes: ["needs-you", "running"] },
  { id: "review", title: "Needs review", status: "review", lanes: ["review"] },
  { id: "done", title: "Done", status: "done", lanes: ["done"] },
];

type View = "board" | "list";
const VIEW_KEY = "phasr.board.view";

/**
 * Home (A Main): every task across repositories as a board of what it
 * needs — queued, running, needs review, done — or the same as a list.
 * The title-bar repository switcher narrows it to one repository.
 */
export function BoardPage() {
  const repoFilter = useUiStore((s) => s.repoFilter);
  const requestNewWorkspace = useUiStore((s) => s.requestNewWorkspace);
  const { tasks, repositories } = useBoardTasks(repoFilter);
  const [view, setViewState] = useState<View>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "board";
    } catch {
      return "board";
    }
  });
  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };
  const [agentFilter, setAgentFilter] = useState<Agent | null>(null);
  // Minute clock: only "is it still today" depends on time here. The live
  // per-second timers live in the leaves (TaskCard, ElapsedCell), so the
  // board and every card no longer re-render each second.
  const today = useNow(false);
  const repo = repositories.find((r) => r.id === repoFilter) ?? null;
  const newTaskRepo = repo?.id ?? repositories[0]?.id ?? null;

  const visible = useMemo(() => visibleBoardTasks(tasks, agentFilter, today), [tasks, agentFilter, today]);
  const running = tasks.filter((t) => t.lane === "running" || t.lane === "needs-you").length;
  const failed = visible.filter((t) => t.lane === "failed");
  const agents = [...new Set(tasks.map((t) => t.workspace.agent).filter((a): a is Agent => !!a))];

  const boardRef = useRef<HTMLDivElement>(null);
  // n → new task, while focus is on the board itself (not in a field).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key !== "n") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], [data-terminal-surface]")) return;
      if (!boardRef.current?.contains(t) && t !== document.body) return;
      if (!newTaskRepo) return;
      e.preventDefault();
      requestNewWorkspace(newTaskRepo);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTaskRepo, requestNewWorkspace]);

  // ↑↓ (and j/k) move between cards in reading order; ↵ opens (native link).
  const onBoardKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "j", "k"];
    if (!keys.includes(e.key) || e.metaKey || e.ctrlKey) return;
    const cards = Array.from(boardRef.current?.querySelectorAll<HTMLElement>("[data-board-card]") ?? []);
    if (cards.length === 0) return;
    const i = cards.indexOf(document.activeElement as HTMLElement);
    const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
    e.preventDefault();
    cards[i < 0 ? 0 : Math.min(cards.length - 1, Math.max(0, i + dir))]?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-(--color-border-subtle) px-6">
        <div className="flex min-w-0 flex-col">
          <h1 className="m-0 text-[15px] font-semibold leading-tight">Board</h1>
          <span className="text-[11px] text-(--color-text-muted)">
            {repo ? repo.name : "All repositories"} · {tasks.length} {tasks.length === 1 ? "task" : "tasks"} · {running}{" "}
            {running === 1 ? "agent" : "agents"} running
          </span>
        </div>
        <span className="flex-1" />
        <SegmentedControl
          label="Board view"
          value={view}
          onChange={setView}
          options={[
            { value: "board", label: "Board" },
            { value: "list", label: "List" },
          ]}
        />
        <Menu>
          <MenuTrigger asChild>
            <Button icon={<ListFilter className="size-3" aria-hidden />} aria-label="Filter tasks by agent">
              {agentFilter ? AGENT_META[agentFilter].label : "Filter"}
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => setAgentFilter(null)}>All agents</MenuItem>
            {agents.length > 0 ? <MenuSeparator /> : null}
            {agents.map((a) => (
              <MenuItem key={a} icon={<AgentMark agent={a} />} onSelect={() => setAgentFilter(a)}>
                {AGENT_META[a].label}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
        <Button
          variant="primary"
          disabled={!newTaskRepo}
          onClick={() => newTaskRepo && requestNewWorkspace(newTaskRepo)}
          shortcut={SHORTCUTS.newWorkspace.display.join("")}
        >
          New task
        </Button>
      </header>

      <div ref={boardRef} onKeyDown={onBoardKeyDown} className="min-h-0 flex-1 overflow-auto">
        {tasks.length === 0 ? (
          <EmptyBoard repoName={repo?.name ?? null} onNewTask={() => newTaskRepo && requestNewWorkspace(newTaskRepo)} />
        ) : view === "board" ? (
          <div
            className="grid min-h-full gap-4 px-6 py-5"
            style={{ gridTemplateColumns: `repeat(${failed.length > 0 ? 5 : 4}, minmax(220px, 1fr))` }}
          >
            {COLUMNS.map((col) => {
              const cards = visible.filter((t) => col.lanes.includes(t.lane));
              return (
                <Column key={col.id} title={col.title} status={col.status} count={cards.length}>
                  {cards.map((t) => (
                    <TaskCard key={t.workspace.id} task={t} />
                  ))}
                  {col.id === "queued" ? (
                    <Button
                      variant="dashed"
                      size="lg"
                      className="w-full rounded-(--radius-card)"
                      disabled={!newTaskRepo}
                      onClick={() => newTaskRepo && requestNewWorkspace(newTaskRepo)}
                    >
                      <Plus className="size-3" aria-hidden />
                      Queue a task
                    </Button>
                  ) : null}
                </Column>
              );
            })}
            {failed.length > 0 ? (
              <Column title="Failed" status="failed" count={failed.length}>
                {failed.map((t) => (
                  <TaskCard key={t.workspace.id} task={t} />
                ))}
              </Column>
            ) : null}
          </div>
        ) : (
          <TaskList tasks={visible} />
        )}
      </div>
    </div>
  );
}

function Column({
  title,
  status,
  count,
  children,
}: {
  title: string;
  status: Parameters<typeof StatusGlyph>[0]["kind"];
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2.5">
      <h2 className="m-0 flex items-center gap-2 px-0.5 text-[13px] font-semibold">
        <StatusGlyph kind={status} />
        {title}
        <span className="font-mono text-[11px] font-normal text-(--color-text-muted)">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/** Live "4m 12s": the only thing that ticks each second, so only it re-renders. */
function ElapsedSince({ iso }: { iso: string | null | undefined }) {
  const now = useNow(true);
  return <span className="font-mono">{formatElapsed(iso ?? null, now)}</span>;
}

/** "18m ago", on the minute clock. */
function AgoSince({ iso }: { iso: string | null | undefined }) {
  const now = useNow(false);
  return <>{formatAgo(iso ?? null, now)}</>;
}

function TaskList({ tasks }: { tasks: BoardTask[] }) {
  const order: TaskLane[] = ["needs-you", "running", "review", "failed", "queued", "done"];
  const sorted = [...tasks].sort((a, b) => order.indexOf(a.lane) - order.indexOf(b.lane));
  return (
    <table className="w-full border-collapse text-left text-[13px]">
      <thead className="sticky top-0 bg-(--color-bg-base)">
        <tr className="border-b border-(--color-border-subtle)">
          {["Task", "Status", "Agent", "Branch", "Repository", "Change / time"].map((h) => (
            <th key={h} scope="col" className="group-header px-6 py-2.5 font-semibold first:pl-6">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((t) => {
          const ws = t.workspace;
          return (
            <tr key={ws.id} className="border-b border-(--color-border-subtle) hover:bg-(--color-bg-hover)">
              <td className="px-6 py-2">
                <Link
                  to="/repositories/$repositoryId/workspaces/$workspaceId"
                  params={{ repositoryId: ws.repositoryId, workspaceId: ws.id }}
                  data-board-card
                  className="font-medium text-(--color-text-primary) no-underline focus-visible:outline-none focus-visible:underline"
                >
                  {ws.name}
                </Link>
              </td>
              <td className="px-6 py-2 text-[12px]">
                <StatusBadge kind={LANE_STATUS[t.lane]} />
              </td>
              <td className="px-6 py-2 text-[12px]">
                <AgentMark agent={ws.agent} withLabel />
              </td>
              <td className="max-w-[220px] truncate px-6 py-2 font-mono text-[12px] text-(--color-text-secondary)">
                {ws.branch}
              </td>
              <td className="px-6 py-2 text-[12px] text-(--color-text-secondary)">{t.repository?.name}</td>
              <td className="px-6 py-2 text-[12px] text-(--color-text-muted)">
                {t.lane === "running" || t.lane === "needs-you" ? (
                  <ElapsedSince iso={ws.startedAt} />
                ) : t.diff ? (
                  <DiffCount adds={t.diff.adds} removes={t.diff.removes} />
                ) : (
                  <AgoSince iso={ws.finishedAt ?? ws.updatedAt} />
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A-EmptyRepo: ghost columns behind a first-task call to action. */
function EmptyBoard({ repoName, onNewTask }: { repoName: string | null; onNewTask: () => void }) {
  return (
    <div className="relative h-full min-h-[520px]">
      <div aria-hidden className="grid h-full grid-cols-4 gap-4 px-6 py-5 opacity-60">
        {COLUMNS.map((c) => (
          <div key={c.id} className="flex flex-col gap-2.5">
            <span className="flex items-center gap-2 text-[13px] font-semibold text-(--color-text-muted)">
              <StatusGlyph kind={c.status} />
              {c.title}
            </span>
            <span className="h-20 rounded-(--radius-card) border border-dashed border-(--color-border-default)" />
          </div>
        ))}
      </div>
      <div className="absolute inset-0 grid place-items-center p-6">
        <div className="flex w-full max-w-[520px] flex-col gap-3 rounded-(--radius-modal) border border-(--color-border-strong) bg-(--color-bg-sheet) p-6 shadow-(--shadow-modal)">
          <span className="group-header">{repoName ? `${repoName} is ready` : "Ready when you are"}</span>
          <h2 className="m-0 text-[22px] font-semibold leading-tight">Give an agent its first task</h2>
          <p className="m-0 text-[13px] leading-[1.55] text-(--color-text-secondary)">
            It runs on its own branch in a worktree, so your checkout stays untouched. You review the diff before
            anything merges.
          </p>
          <div>
            <Button variant="primary" size="md" onClick={onNewTask} shortcut={SHORTCUTS.newWorkspace.display.join("")}>
              New task
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
