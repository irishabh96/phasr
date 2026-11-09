import { Link, useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useRef, type MouseEvent } from "react";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { formatAgo, formatElapsed, type TaskLane } from "@/lib/board";
import type { BoardTask } from "@/lib/hooks/useBoardTasks";
import { useNow } from "@/lib/hooks/useNow";
import { cn } from "@/lib/utils";
import { LANE_META, VIRTUALIZE_ABOVE } from "./laneMeta";

const ORDER: TaskLane[] = ["needs-you", "failed", "running", "review", "queued", "done"];
const ROW_HEIGHT = 36;
const HEADERS = ["Task", "Status", "Agent", "Branch", "Repository", "Change / time"];

export type ListFilter = "all" | "done";

/**
 * List view: the board's tasks as rows, most urgent first. A-Polish rules:
 * sentence-case muted header, no row lines (hover is a background step),
 * Inter tabular-nums for times, mono only for branches and the diff stat.
 * Over `VIRTUALIZE_ABOVE` rows only the visible window renders.
 */
export function TaskList({
  tasks,
  filter,
  onClearFilter,
}: {
  tasks: BoardTask[];
  filter: ListFilter;
  onClearFilter: () => void;
}) {
  const sorted = filter === "done" ? tasks : [...tasks].sort((a, b) => ORDER.indexOf(a.lane) - ORDER.indexOf(b.lane));
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-auto px-[12px] pb-[24px]">
      {filter === "done" ? (
        <div className="flex h-[36px] items-center gap-[8px] px-[12px] text-[12px] text-(--color-text-muted)">
          <span>
            Done · {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
          </span>
          <button
            type="button"
            onClick={onClearFilter}
            className="rounded-(--radius-chip) px-[4px] text-(--color-text-secondary) transition-colors duration-(--dur-1) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            Show all
          </button>
        </div>
      ) : null}
      <table className="w-full border-separate border-spacing-0 text-left text-[13px]">
        <thead className="sticky top-0 z-[1] bg-(--color-bg-base)">
          <tr>
            {HEADERS.map((h) => (
              <th key={h} scope="col" className="h-[36px] px-[12px] text-[12px] font-normal text-(--color-text-muted)">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        {sorted.length > VIRTUALIZE_ABOVE ? (
          <VirtualRows
            tasks={sorted}
            scrollRef={scrollRef}
            // The sticky header row (and the "Done" line) sit above the first row.
            offset={filter === "done" ? 2 * ROW_HEIGHT : ROW_HEIGHT}
          />
        ) : (
          <tbody>
            {sorted.map((t) => (
              <Row key={t.workspace.id} task={t} />
            ))}
          </tbody>
        )}
      </table>
      {sorted.length === 0 ? (
        <p className="m-0 px-[12px] py-[24px] text-[12px] text-(--color-text-muted)">
          {filter === "done" ? "Nothing is done yet." : "No tasks match the filter."}
        </p>
      ) : null}
    </div>
  );
}

/** Fixed-height rows inside the table, padded above and below the window. */
function VirtualRows({
  tasks,
  scrollRef,
  offset,
}: {
  tasks: BoardTask[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  offset: number;
}) {
  const v = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin: offset,
    initialRect: { width: 0, height: window.innerHeight },
    getItemKey: (i) => tasks[i]?.workspace.id ?? i,
  });
  const items = v.getVirtualItems();
  const top = items.length ? items[0]!.start - v.options.scrollMargin : 0;
  const bottom = items.length ? v.getTotalSize() - (items[items.length - 1]!.end - v.options.scrollMargin) : 0;
  return (
    <tbody>
      {top > 0 ? (
        <tr aria-hidden style={{ height: top }}>
          <td colSpan={HEADERS.length} />
        </tr>
      ) : null}
      {items.map((it) => {
        const t = tasks[it.index];
        return t ? <Row key={it.key} task={t} /> : null;
      })}
      {bottom > 0 ? (
        <tr aria-hidden style={{ height: bottom }}>
          <td colSpan={HEADERS.length} />
        </tr>
      ) : null}
    </tbody>
  );
}

const cell = "h-[36px] px-[12px] transition-colors duration-(--dur-1) group-hover/row:bg-(--color-bg-elevated)";

const Row = memo(function Row({ task: t }: { task: BoardTask }) {
  const ws = t.workspace;
  const navigate = useNavigate();
  const meta = LANE_META[t.lane];
  const label = t.lane === "done" && ws.outcome === "merged" ? "Merged" : meta.label;
  // The name is the link (keyboard, ↑↓); a click anywhere on the row opens too.
  const onClick = (e: MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as HTMLElement).closest("a, button")) return;
    void navigate({
      to: "/repositories/$repositoryId/workspaces/$workspaceId",
      params: { repositoryId: ws.repositoryId, workspaceId: ws.id },
      ...(t.lane === "review" ? { search: { pane: "changes" } as never } : {}),
    });
  };
  return (
    <tr className="group/row cursor-default" onClick={onClick} data-lane={t.lane} data-workspace-id={ws.id}>
      <td className={cn(cell, "max-w-[360px] rounded-l-(--radius-control)")}>
        <Link
          to="/repositories/$repositoryId/workspaces/$workspaceId"
          params={{ repositoryId: ws.repositoryId, workspaceId: ws.id }}
          {...(t.lane === "review" ? { search: { pane: "changes" } as never } : {})}
          data-board-card
          className={cn(
            "block truncate rounded-[3px] font-medium no-underline focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
            t.lane === "done" ? "text-(--color-text-secondary)" : "text-(--color-text-primary)",
          )}
        >
          {ws.name}
        </Link>
      </td>
      <td className={cn(cell, "whitespace-nowrap text-[12px] text-(--color-text-secondary)")}>
        <span className="inline-flex items-center gap-[8px]">
          <span aria-hidden className="size-[6px] rounded-full" style={{ background: meta.color }} />
          {label}
        </span>
      </td>
      <td className={cn(cell, "whitespace-nowrap text-[12px] text-(--color-text-secondary)")}>
        <span className="inline-flex items-center gap-[8px]">
          <AgentMark agent={ws.agent} className="size-[14px] text-[8px]" />
          {ws.agent ? AGENT_META[ws.agent].label : "Agent"}
        </span>
      </td>
      <td className={cn(cell, "max-w-[220px] truncate font-mono text-[12px] text-(--color-text-secondary)")}>
        {ws.branch}
      </td>
      <td className={cn(cell, "whitespace-nowrap text-[12px] text-(--color-text-secondary)")}>{t.repository?.name}</td>
      <td
        className={cn(
          cell,
          "whitespace-nowrap rounded-r-(--radius-control) text-[12px] tabular-nums text-(--color-text-muted)",
        )}
      >
        {t.lane === "running" || t.lane === "needs-you" ? (
          <ElapsedSince iso={ws.startedAt} />
        ) : t.diff && t.diff.files > 0 && t.lane !== "done" ? (
          <span className="font-mono text-[11.5px]">
            +{t.diff.adds}
            {t.diff.removes > 0 ? ` −${t.diff.removes}` : ""}
          </span>
        ) : (
          <AgoSince iso={t.finishedAt ?? ws.outcomeAt ?? ws.finishedAt ?? ws.updatedAt} />
        )}
      </td>
    </tr>
  );
});

/** Live "4m 12s": the only thing that ticks each second, so only it re-renders. */
function ElapsedSince({ iso }: { iso: string | null | undefined }) {
  const now = useNow(true);
  return <>{formatElapsed(iso ?? null, now)}</>;
}

/** "18m ago", on the minute clock. */
function AgoSince({ iso }: { iso: string | null | undefined }) {
  const now = useNow(false);
  return <>{formatAgo(iso ?? null, now)}</>;
}
