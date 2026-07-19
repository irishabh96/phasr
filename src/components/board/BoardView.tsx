import { GitMerge } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { BoardCardView } from "@/components/board/BoardCard";
import { useAllAgentLiveness } from "@/lib/agentLiveness";
import { isLiveState } from "@/components/ui/agentStatusMeta";
import {
  blockingRoles,
  boardColumn,
  deriveBoardState,
  type BoardColumn,
} from "@/lib/deriveBoardState";
import { useNow } from "@/lib/useNow";
import type { BoardState, Workspace } from "@/lib/types";

const COLUMNS: ReadonlyArray<{ key: BoardColumn; label: string }> = [
  { key: "backlog", label: "Backlog" },
  { key: "in-progress", label: "In progress" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
];

interface DerivedCard {
  subtask: Workspace;
  column: BoardColumn;
  render: React.ReactNode;
}

/**
 * The read-only task board (S2-T1). Places the parent + its subtask cards into
 * four DERIVED lanes (Backlog → In progress → Review → Done) via
 * `deriveBoardState` — the lanes are NOT draggable; a card's column is a pure
 * function of its honest state (edges × contracts × liveness).
 *
 * Liveness is read once from the module store (`useAllAgentLiveness`) so there
 * is no per-card hook in a variable-length loop; the "Ns ago" clock ticks only
 * while at least one subtask is actually live.
 */
export function BoardView({ board }: { board: BoardState }) {
  const livenessMap = useAllAgentLiveness();

  // Tick the shared clock only while a subtask carries a live counter.
  const anyLive = board.subtasks.some((s) => {
    const snapshot = livenessMap[s.id];
    return isLiveState(
      snapshot?.derivedState ?? (s.status === "running" ? "working" : "stopped"),
    );
  });
  const now = useNow(anyLive);

  const cards: DerivedCard[] = board.subtasks.map((subtask) => {
    const { state, since } = deriveBoardState(
      subtask,
      board,
      livenessMap[subtask.id],
      now,
    );
    const blockedOnRoles = state === "blocked" ? blockingRoles(subtask, board) : [];
    return {
      subtask,
      column: boardColumn(state),
      render: (
        <BoardCardView
          key={subtask.id}
          role={subtask.role}
          name={subtask.name}
          state={state}
          since={since}
          exitCode={subtask.exitCode}
          blockedOnRoles={blockedOnRoles}
        />
      ),
    };
  });

  return (
    <div className="flex min-h-0 flex-col gap-4" data-testid="board-view">
      <BoardParentHeader board={board} />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {COLUMNS.map(({ key, label }) => {
          const columnCards = cards.filter((c) => c.column === key);
          return (
            <section
              key={key}
              data-testid={`board-column-${key}`}
              className="flex min-h-0 flex-col gap-2 rounded-(--radius-panel) bg-[color-mix(in_oklab,var(--color-bg-surface)_50%,transparent)] p-2"
            >
              <header className="flex items-center justify-between px-1 pt-0.5">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-(--color-text-muted)">
                  {label}
                </h3>
                <span className="text-[11px] tabular-nums text-(--color-text-muted)">
                  {columnCards.length}
                </span>
              </header>
              <div className="flex flex-col gap-2">
                {columnCards.length ? (
                  columnCards.map((c) => c.render)
                ) : (
                  <p className="px-1 py-2 text-[11px] text-(--color-text-muted)">
                    —
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The parent (the decomposition itself). Rendered as a summary header, NOT a
 * lane card — a parent has no PTY and no agent status, so forcing it into a
 * status lane would make it lie. It shows the goal + progress and hosts the
 * integrate affordance.
 */
function BoardParentHeader({ board }: { board: BoardState }) {
  const done = board.contracts.filter((c) => c.publishedAt != null).length;
  const goal = board.parent.prompt?.trim() || board.parent.name;

  return (
    <div
      data-testid="board-parent-card"
      className="flex flex-wrap items-center justify-between gap-3 rounded-(--radius-panel) border border-(--color-border-default) bg-(--color-bg-surface) p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-(--color-text-muted)">
          Parent · {board.subtasks.length} subtasks
        </span>
        <h2 className="truncate text-[15px] font-semibold text-(--color-text-primary)">
          {goal}
        </h2>
        <span className="text-[11px] text-(--color-text-muted)">
          {done}/{board.subtasks.length} contracts published
        </span>
      </div>

      {/*
        DEFERRED (S2-T2 / do NOT build in this slice): the combined-diff review +
        "Integrate & review" action. It needs Chunk 4's `integrate_parent`
        (mint an integration worktree on the parent row, topological
        `merge_into`, then the ONE combined diff via `git_status`/`git_diff`
        against the parent workspace_id — spec §B1/§E3-T1). When that lands, wire
        a `tauri.integrateParent(board.parent.id, strategy)` call here, then
        render the parent's combined diff by reusing DiffList/DiffView; route
        `MergeOutcome::Conflicts` to the existing conflict-resolution flow keyed
        on the parent id. Disabled + tooltip until then so it is never a dead
        end (DDR-002).
      */}
      <GlassButton
        variant="primary"
        size="sm"
        disabled
        title="Integration ships with the combined-diff step (deferred)."
        data-testid="board-integrate"
        className="gap-1.5"
      >
        <GitMerge className="size-3.5" aria-hidden="true" />
        Integrate &amp; review
      </GlassButton>
    </div>
  );
}
