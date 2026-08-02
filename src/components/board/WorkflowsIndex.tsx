import { useNavigate } from "@tanstack/react-router";
import { GitFork, Plus } from "lucide-react";
import { GlassButton } from "@/components/ui/GlassButton";
import { PanelState } from "@/components/ui/PanelState";
import { useAllAgentLiveness } from "@/lib/agentLiveness";
import { isLiveState } from "@/components/ui/agentStatusMeta";
import {
  boardColumn,
  deriveBoardState,
  type BoardColumn,
} from "@/lib/deriveBoardState";
import { deriveNextGate, isIntegrateEligible } from "@/lib/deriveNextGate";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useWorklist } from "@/lib/hooks/useWorklist";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/utils";
import type { Workspace, WorklistBoard } from "@/lib/types";

const LANES: readonly { key: BoardColumn; label: string }[] = [
  { key: "backlog", label: "backlog" },
  { key: "in-progress", label: "in progress" },
  { key: "review", label: "review" },
  { key: "done", label: "done" },
];

/**
 * The Workflows index (`/repositories/:id/board`) — the screen that answers
 * "what's in flight in this repo?", which previously had NO answer: boards
 * were reachable only via the create-redirect, a sidebar node, or a
 * breadcrumb, so three in-flight workflows after a relaunch were findable
 * only by memory.
 *
 * Active section: every un-shipped, un-archived parent, straight off the
 * worklist payload (subtask reviews ride inline, so the lane counts and the
 * derived gate are the SAME truth the board shows). Completed section: the
 * durable facts — `shippedAt` / `archived` — where a finished workflow lives
 * on (archived boards stay viewable read-only).
 *
 * Calm by design: rows are navigation, the gate is a STATIC label here (the
 * real button lives on the board), and nothing is coral — status text and
 * counts carry the meaning.
 */
export function WorkflowsIndex({ repositoryId }: { repositoryId: string }) {
  const navigate = useNavigate();
  const requestDecompose = useUiStore((s) => s.requestDecompose);
  const worklist = useWorklist();
  const workspaces = useWorkspaces(repositoryId);
  const { data: repository } = useRepository(repositoryId);
  const liveness = useAllAgentLiveness();

  const boards = (worklist.data?.boards ?? []).filter(
    (b) =>
      b.parent.repositoryId === repositoryId &&
      b.parent.shippedAt == null &&
      b.parent.status !== "archived",
  );
  const anyLive = boards.some((b) =>
    b.subtasks.some((s) =>
      isLiveState(
        liveness[s.id]?.derivedState ??
          (s.status === "running" ? "working" : "stopped"),
      ),
    ),
  );
  const now = useNow(anyLive);

  const completed = (workspaces.data ?? [])
    .filter(
      (w) =>
        w.workspaceKind === "parent" &&
        (w.shippedAt != null || w.status === "archived"),
    )
    .sort((a, b) =>
      (b.shippedAt ?? b.archivedAt ?? b.updatedAt).localeCompare(
        a.shippedAt ?? a.archivedAt ?? a.updatedAt,
      ),
    );

  const openBoard = (parentId: string) =>
    void navigate({
      to: "/repositories/$repositoryId/board/$parentId",
      params: { repositoryId, parentId },
    });

  if (worklist.isLoading || workspaces.isLoading) {
    return <PanelState kind="loading" rows={4} />;
  }
  if (worklist.error) {
    return (
      <PanelState
        kind="error"
        title="Couldn't load workflows"
        error={worklist.error}
        onRetry={() => void worklist.refetch()}
      />
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-[15px] font-semibold leading-tight text-(--color-text-primary)">
            Workflows
          </h1>
          <p className="text-[11.5px] text-(--color-text-muted)">
            {repository?.name ?? "Repository"} ·{" "}
            <span className="tabular-nums">{boards.length}</span> active ·{" "}
            <span className="tabular-nums">{completed.length}</span> completed
          </p>
        </div>
        {/* When the active section is empty, ITS state carries the one
            primary CTA — a second header button would just be noise. */}
        {boards.length > 0 && (
          <GlassButton
            variant="outline"
            size="sm"
            onClick={() => requestDecompose(repositoryId)}
          >
            <Plus size={13} aria-hidden />
            New workflow
          </GlassButton>
        )}
      </header>

      <section aria-label="Active workflows" className="flex flex-col gap-1">
        {boards.length === 0 ? (
          <PanelState
            kind="empty"
            title="No active workflows"
            description="Describe a goal and the planner proposes the tickets."
            action={
              <GlassButton
                variant="primary"
                size="sm"
                onClick={() => requestDecompose(repositoryId)}
              >
                <Plus size={13} aria-hidden />
                New workflow
              </GlassButton>
            }
          />
        ) : (
          boards.map((board) => (
            <ActiveWorkflowRow
              key={board.parent.id}
              board={board}
              liveness={liveness}
              now={now}
              onOpen={() => openBoard(board.parent.id)}
            />
          ))
        )}
      </section>

      <section aria-label="Completed workflows" className="flex flex-col gap-1">
        <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-(--color-text-muted)">
          Completed
        </h2>
        {completed.length === 0 ? (
          <p className="rounded-md border border-(--glass-border-hairline) bg-(--color-bg-surface) px-3 py-3 text-[12px] text-(--color-text-muted)">
            Ship or archive a workflow and it lands here.
          </p>
        ) : (
          completed.map((parent) => (
            <CompletedWorkflowRow
              key={parent.id}
              parent={parent}
              onOpen={() => openBoard(parent.id)}
            />
          ))
        )}
      </section>
    </div>
  );
}

function ActiveWorkflowRow({
  board,
  liveness,
  now,
  onOpen,
}: {
  board: WorklistBoard;
  liveness: ReturnType<typeof useAllAgentLiveness>;
  now: number;
  onOpen: () => void;
}) {
  const { parent, subtasks } = board;
  const goal = parent.prompt?.trim() || parent.name;

  const counts: Record<BoardColumn, number> = {
    backlog: 0,
    "in-progress": 0,
    review: 0,
    done: 0,
  };
  const states = subtasks.map(
    (s) => deriveBoardState(s, board, liveness[s.id], now, s.review ?? undefined).state,
  );
  for (const state of states) counts[boardColumn(state)] += 1;

  const integrable =
    subtasks.length > 0 && states.every((s) => isIntegrateEligible(s));
  const gate = deriveNextGate({
    kind: "epic",
    ticketCount: subtasks.length,
    integrable,
    integrated: !!parent.branch,
    // The index reads the durable fact only; pre-0016 shipped epics resolve
    // on the board itself (which also consults branch status).
    shipped: parent.shippedAt != null,
    autopilotEnabled: parent.autopilotEnabled,
  });

  return (
    <button
      type="button"
      data-testid="workflow-row"
      onClick={onOpen}
      className={cn(
        "flex w-full flex-wrap items-center gap-x-5 gap-y-2 rounded-(--radius-panel) border border-(--color-border-subtle) bg-(--color-bg-surface) px-4 py-3 text-left",
        "transition-colors duration-150 hover:bg-(--color-bg-hover)",
        "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
      )}
    >
      <GitFork
        size={14}
        aria-hidden
        className="shrink-0 text-(--color-text-muted)"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium leading-tight text-(--color-text-primary)">
          {parent.name || goal}
        </span>
        <span className="truncate text-[11.5px] leading-tight text-(--color-text-muted)">
          {goal}
        </span>
      </span>
      <span
        className="flex shrink-0 items-center gap-3 text-[11.5px] tabular-nums text-(--color-text-muted)"
        aria-label={LANES.map((l) => `${counts[l.key]} ${l.label}`).join(", ")}
      >
        {LANES.map((lane) => (
          <span
            key={lane.key}
            className={cn(
              "inline-flex items-baseline gap-1",
              counts[lane.key] === 0 && "opacity-50",
            )}
          >
            <span className="font-medium text-(--color-text-secondary)">
              {counts[lane.key]}
            </span>
            {lane.label}
          </span>
        ))}
      </span>
      {parent.autopilotEnabled && (
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-(--color-bg-hover) px-2 text-[10.5px] font-medium leading-none text-(--color-text-secondary)">
          Autopilot
        </span>
      )}
      <span
        data-testid="workflow-gate"
        className={cn(
          "shrink-0 text-[11.5px] font-medium leading-none",
          gate.intent === "success"
            ? "text-(--color-success)"
            : gate.enabled
              ? "text-(--color-accent-text)"
              : "text-(--color-text-muted)",
        )}
      >
        {gate.label}
      </span>
    </button>
  );
}

function CompletedWorkflowRow({
  parent,
  onOpen,
}: {
  parent: Workspace;
  onOpen: () => void;
}) {
  const goal = parent.prompt?.trim() || parent.name;
  const meta =
    parent.shippedAt != null
      ? `Shipped ${shortDate(parent.shippedAt)}`
      : `Archived ${shortDate(parent.archivedAt ?? parent.updatedAt)}`;
  return (
    <button
      type="button"
      data-testid="workflow-completed-row"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-3 rounded-(--radius-panel) border border-(--glass-border-hairline) bg-(--color-bg-surface) px-4 py-2.5 text-left",
        "transition-colors duration-150 hover:bg-(--color-bg-hover)",
        "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
      )}
    >
      <GitFork
        size={13}
        aria-hidden
        className="shrink-0 text-(--color-text-muted) opacity-70"
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12.5px] font-medium leading-tight text-(--color-text-secondary)">
          {parent.name || goal}
        </span>
        <span className="truncate text-[11px] leading-tight text-(--color-text-muted)">
          {goal}
        </span>
      </span>
      <span className="shrink-0 text-[11px] text-(--color-text-muted)">
        {meta}
      </span>
    </button>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
