import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ListFilter } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { BOARD_COLUMNS, doneSummary, groupBoardTasks, visibleBoardTasks, type BoardColumnId } from "@/lib/board";
import { useBoardTasks, type BoardTask } from "@/lib/hooks/useBoardTasks";
import { useNow } from "@/lib/hooks/useNow";
import { useUiStore } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { BoardContextMenu } from "./BoardContextMenu";
import { EmptyRepoBoard } from "./EmptyRepoBoard";
import { COLUMN_COLOR, VIRTUALIZE_ABOVE } from "./laneMeta";
import { NewTaskButton } from "./NewTaskButton";
import { TaskCard } from "./TaskCard";
import { TaskList, type ListFilter as ListFilterValue } from "./TaskList";

type View = "board" | "list";
const VIEW_KEY = "phasr.board.view";

/**
 * Home (A-Polish Main): every task across repositories in four columns of
 * what it needs — Queued · Needs you · Running · Review — or the same as a
 * list. Done is a line under Review that opens the List filtered to done.
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
  const [listFilter, setListFilter] = useState<ListFilterValue>("all");
  const setView = (v: View) => {
    setViewState(v);
    setListFilter("all");
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  };
  const [agentFilter, setAgentFilter] = useState<Agent | null>(null);
  // Minute clock: only "is it still today" depends on time here. The live
  // per-second timers live in the leaves (TaskCard, ElapsedSince), so the
  // board and every card don't re-render each second.
  const today = useNow(false);
  const repo = repositories.find((r) => r.id === repoFilter) ?? null;
  const newTaskRepo = repo?.id ?? repositories[0]?.id ?? null;
  const onNewTask = newTaskRepo ? () => requestNewWorkspace(newTaskRepo) : null;

  const groups = useMemo(() => groupBoardTasks(tasks, agentFilter, today), [tasks, agentFilter, today]);
  const listTasks = useMemo(
    () => (listFilter === "done" ? groups.done : visibleBoardTasks(tasks, agentFilter, today)),
    [listFilter, groups.done, tasks, agentFilter, today],
  );
  const agents = useMemo(
    () => [...new Set(tasks.map((t) => t.workspace.agent).filter((a): a is Agent => !!a))],
    [tasks],
  );
  const workspaceById = useMemo(() => new Map(tasks.map((t) => [t.workspace.id, t.workspace])), [tasks]);
  const onBoard =
    groups.columns.queued.length +
    groups.columns["needs-you"].length +
    groups.columns.running.length +
    groups.columns.review.length;
  const virtual = onBoard > VIRTUALIZE_ABOVE;

  const rootRef = useRef<HTMLDivElement>(null);
  // n → new task, while focus is on the board itself (not in a field).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key !== "n") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], [data-terminal-surface]")) return;
      if (!rootRef.current?.contains(t) && t !== document.body) return;
      if (!newTaskRepo) return;
      e.preventDefault();
      requestNewWorkspace(newTaskRepo);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newTaskRepo, requestNewWorkspace]);

  // ↑↓ (and j/k) move between cards in reading order; ←→ (h/l) jump to the
  // neighbouring column at the same position; ↵ opens (native link).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const vertical = ["ArrowDown", "ArrowUp", "j", "k"].includes(e.key);
    const horizontal = view === "board" && ["ArrowLeft", "ArrowRight", "h", "l"].includes(e.key);
    if (!vertical && !horizontal) return;
    const root = rootRef.current;
    if (!root) return;
    const active = document.activeElement as HTMLElement | null;
    if (vertical) {
      const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-board-card]"));
      if (cards.length === 0) return;
      const i = active ? cards.indexOf(active) : -1;
      const dir = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
      e.preventDefault();
      cards[i < 0 ? 0 : Math.min(cards.length - 1, Math.max(0, i + dir))]?.focus();
      return;
    }
    const columns = Array.from(root.querySelectorAll<HTMLElement>("[data-board-column]"));
    const from = active?.closest<HTMLElement>("[data-board-column]");
    if (!from || !active?.matches("[data-board-card]")) return;
    const dir = e.key === "ArrowRight" || e.key === "l" ? 1 : -1;
    const pos = Array.from(from.querySelectorAll("[data-board-card]")).indexOf(active);
    for (let c = columns.indexOf(from) + dir; c >= 0 && c < columns.length; c += dir) {
      const cards = columns[c]!.querySelectorAll<HTMLElement>("[data-board-card]");
      if (cards.length === 0) continue;
      e.preventDefault();
      cards[Math.min(pos, cards.length - 1)]?.focus();
      return;
    }
  };

  const summary = doneSummary(groups);
  const showDone = () => {
    setView("list");
    setListFilter("done");
  };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className="flex h-[44px] shrink-0 items-center gap-[8px] px-[24px]">
        <h1 className="m-0 text-[13px] font-medium leading-none">Board</h1>
        <span aria-hidden className="text-(--color-text-muted)">
          ·
        </span>
        <span className="min-w-0 truncate text-(--color-text-muted)">{repo ? repo.name : "All repositories"}</span>
        <span className="flex-1" />
        {/* An empty board has nothing to switch or filter, and its first-task
            card holds the screen's one primary. */}
        {tasks.length > 0 ? (
          <>
            <SegmentedControl
              label="Board view"
              // Exact A-Polish sizes: 2px track, 24×10 segments.
              className="gap-[2px] p-[2px] [&>button]:h-[24px] [&>button]:px-[10px]"
              value={view}
              onChange={setView}
              options={[
                { value: "board", label: "Board" },
                { value: "list", label: "List" },
              ]}
            />
            <Menu>
              <MenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-[28px] gap-[6px] px-[10px]"
                  icon={<ListFilter className="size-[13px]" aria-hidden />}
                  aria-label="Filter tasks by agent"
                >
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
            <NewTaskButton onNewTask={onNewTask} />
          </>
        ) : null}
      </header>

      <div onKeyDown={onKeyDown} className="min-h-0 flex-1">
        {tasks.length === 0 ? (
          <EmptyRepoBoard repoName={repo?.name ?? null} onNewTask={onNewTask} />
        ) : view === "board" ? (
          <BoardContextMenu workspaces={workspaceById}>
            <div className="h-full overflow-x-auto">
              <div className="grid h-full min-w-[848px] grid-cols-4 gap-[12px] px-[24px] pt-[8px] pb-[24px]">
                {BOARD_COLUMNS.map((col) => (
                  <Column
                    key={col.id}
                    id={col.id}
                    title={col.title}
                    tasks={groups.columns[col.id]}
                    showRepo={!repoFilter}
                    virtual={virtual}
                    footer={
                      col.id === "queued" ? (
                        <button
                          type="button"
                          disabled={!onNewTask}
                          onClick={() => onNewTask?.()}
                          className="flex h-[32px] shrink-0 items-center gap-[4px] rounded-(--radius-card) px-[14px] text-left text-[12.5px] text-(--color-text-muted) transition-colors duration-(--dur-1) hover:bg-(--color-bg-elevated) hover:text-(--color-text-secondary) disabled:opacity-50 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
                        >
                          <span aria-hidden>+</span>
                          Queue a task
                        </button>
                      ) : col.id === "review" && summary ? (
                        <div className="mt-[8px] flex h-[28px] shrink-0 items-center gap-[8px] px-[4px] text-[12px] text-(--color-text-muted)">
                          <Check aria-hidden className="size-[12px] text-(--color-status-success)" strokeWidth={2.5} />
                          <span className="tabular-nums">{summary}</span>
                          <span className="flex-1" />
                          <button
                            type="button"
                            onClick={showDone}
                            aria-label="Show done tasks"
                            className="rounded-(--radius-chip) px-[4px] text-(--color-text-muted) transition-colors duration-(--dur-1) hover:text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
                          >
                            Show
                          </button>
                        </div>
                      ) : null
                    }
                  />
                ))}
              </div>
            </div>
          </BoardContextMenu>
        ) : (
          <BoardContextMenu workspaces={workspaceById}>
            <div className="h-full">
              <TaskList tasks={listTasks} filter={listFilter} onClearFilter={() => setListFilter("all")} />
            </div>
          </BoardContextMenu>
        )}
      </div>
    </div>
  );
}

function Column({
  id,
  title,
  tasks,
  showRepo,
  virtual,
  footer,
}: {
  id: BoardColumnId;
  title: string;
  tasks: BoardTask[];
  showRepo: boolean;
  virtual: boolean;
  footer: ReactNode;
}) {
  return (
    <section aria-label={title} data-board-column={id} className="flex min-h-0 min-w-0 flex-col gap-[8px]">
      <h2 className="m-0 flex h-[28px] shrink-0 items-center gap-[8px] px-[4px] text-[12.5px] font-normal text-(--color-text-secondary)">
        <span aria-hidden className="size-[6px] shrink-0 rounded-full" style={{ background: COLUMN_COLOR[id] }} />
        {title}
        <span className="tabular-nums text-(--color-text-muted)">{tasks.length}</span>
      </h2>
      {virtual ? (
        <VirtualCards tasks={tasks} showRepo={showRepo} footer={footer} />
      ) : (
        // Its own scroller: a long column scrolls under a fixed header. The
        // 2px inset keeps the card ring and focus ring inside the clip.
        <div className="-m-[2px] flex min-h-0 flex-col gap-[8px] overflow-y-auto p-[2px]">
          {tasks.map((t) => (
            <TaskCard key={t.workspace.id} task={t} showRepo={showRepo} />
          ))}
          {footer}
        </div>
      )}
    </section>
  );
}

/** P5: a column over the threshold renders only the cards in view (heights measured). */
function VirtualCards({ tasks, showRepo, footer }: { tasks: BoardTask[]; showRepo: boolean; footer: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 96,
    gap: 8,
    // A column is ~6 cards tall; 3 more each way covers a fast flick
    // without paying for a dozen off-screen cards on first render.
    overscan: 3,
    // Render the first window on the first pass (a column is about the
    // window's height), not an empty pass and then a second one.
    initialRect: { width: 0, height: window.innerHeight },
    getItemKey: (i) => tasks[i]?.workspace.id ?? i,
  });
  return (
    <div ref={scrollRef} className="-m-[2px] flex min-h-0 flex-col gap-[8px] overflow-y-auto p-[2px]">
      <div className="relative w-full shrink-0" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((it) => {
          const t = tasks[it.index];
          if (!t) return null;
          return (
            <div
              key={it.key}
              data-index={it.index}
              ref={v.measureElement}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${it.start}px)` }}
            >
              <TaskCard task={t} showRepo={showRepo} />
            </div>
          );
        })}
      </div>
      {footer}
    </div>
  );
}
