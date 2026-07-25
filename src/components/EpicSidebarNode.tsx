import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, GitFork } from "lucide-react";
import { WorkspaceLink } from "@/components/AppSidebar";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { agentStatusMeta, isLiveState } from "@/components/ui/agentStatusMeta";
import { useAllAgentLiveness } from "@/lib/agentLiveness";
import { deriveAgentState } from "@/lib/deriveAgentState";
import { deriveBoardState, type BoardCardState } from "@/lib/deriveBoardState";
import { useBoard } from "@/lib/hooks/useBoard";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/utils";
import type { Workspace } from "@/lib/types";

/**
 * The epic group in the sidebar — a peer of the flat per-repo workspace list.
 * Every board `parent` in the repo renders as a collapsible node whose subtasks
 * nest beneath as the EXISTING `WorkspaceLink` rows (a subtask id IS a workspace
 * id, so the row's drill-in reuses the `/workspaces/$workspaceId` route
 * verbatim). Progressive disclosure: a repo with zero epics renders nothing, so
 * the single-agent tree stays pixel-identical.
 *
 * TODO(deferred — needs product/backend calls): an epic right-click menu
 * (`EpicSidebarMenu`: rename/open board), relaunch board-restore (persist the
 * last-open board like `lastWorkspace`), and epic delete/cascade (removing a
 * parent must also unwind its subtask worktrees). Out of scope for this
 * connective-tissue pass.
 */
export function RepoEpics({
  repoId,
  activeWorkspaceId,
  activeParentId,
  isExpanded,
}: {
  repoId: string;
  activeWorkspaceId: string | null;
  /** The board route's `parentId` param (present only on that route). */
  activeParentId: string | null;
  isExpanded: boolean;
}) {
  const workspaces = useWorkspaces(repoId);
  const all = workspaces.data ?? [];
  const epics = all
    .filter((w) => w.workspaceKind === "parent" && w.status !== "archived")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (!epics.length) return null;

  // Resolve the active epic: the board route names it directly; a subtask
  // drill-in resolves it from the active subtask's `parentId` (so the drilled
  // subtask's siblings auto-reveal beside it).
  const activeSubtask = activeWorkspaceId
    ? all.find(
        (w) => w.id === activeWorkspaceId && w.workspaceKind === "subtask",
      )
    : undefined;
  const effectiveActiveParentId =
    activeParentId ?? activeSubtask?.parentId ?? null;

  return (
    <div
      className={cn(
        "mt-1.5 flex flex-col gap-0.5",
        isExpanded
          ? "ml-3.5 border-l border-(--glass-border-hairline) pl-2"
          : "items-center",
      )}
    >
      {epics.map((epic) => (
        <EpicSidebarNode
          key={epic.id}
          epic={epic}
          subtasks={all.filter(
            (w) => w.workspaceKind === "subtask" && w.parentId === epic.id,
          )}
          repoId={repoId}
          activeWorkspaceId={activeWorkspaceId}
          isActiveEpic={epic.id === effectiveActiveParentId}
          // The epic's OWN board is the open route (vs. merely being the
          // ancestor of an open subtask). Only the former earns the coral
          // selection tint — the ancestor case reads through brighter text so
          // the open subtask row stays the single warm beacon (coral scarcity).
          isBoardOpen={epic.id === activeParentId}
          isExpanded={isExpanded}
        />
      ))}
    </div>
  );
}

function EpicSidebarNode({
  epic,
  subtasks,
  repoId,
  activeWorkspaceId,
  isActiveEpic,
  isBoardOpen,
  isExpanded,
}: {
  epic: Workspace;
  subtasks: Workspace[];
  repoId: string;
  activeWorkspaceId: string | null;
  isActiveEpic: boolean;
  isBoardOpen: boolean;
  isExpanded: boolean;
}) {
  const navigate = useNavigate();
  const stored = useUiStore((s) => s.epicExpanded[epic.id]);
  const setEpicExpanded = useUiStore((s) => s.setEpicExpanded);
  // Default: expanded when it's the active epic (a subtask drill-in reveals its
  // siblings), collapsed otherwise. An explicit user toggle always wins.
  const expanded = stored ?? isActiveEpic;

  // The full goal (long prompt) rides the rail tooltip; the row itself shows the
  // short epic NAME so the tree stays scannable (and matches the board/worklist,
  // which label an epic by name — not its multi-clause goal sentence).
  const goal = epic.prompt?.trim() || epic.name;
  const label = epic.name || goal;
  const ExpandIcon = expanded ? ChevronDown : ChevronRight;

  const openBoard = () =>
    void navigate({
      to: "/repositories/$repositoryId/board/$parentId",
      params: { repositoryId: repoId, parentId: epic.id },
    });

  // Narrow icon rail: just the epic glyph (click → board), tooltip = goal.
  if (!isExpanded) {
    return (
      <GlassTooltip content={goal} side="right">
        <button
          type="button"
          onClick={openBoard}
          aria-label={`Workflow: ${goal}`}
          aria-current={isActiveEpic ? "page" : undefined}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-[8px]",
            "transition-colors duration-150 hover:bg-(--color-bg-elevated)",
            "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
            isBoardOpen && "bg-(--color-bg-selected)",
          )}
        >
          <GitFork
            size={14}
            className={
              isBoardOpen
                ? "text-(--color-accent-text)"
                : isActiveEpic
                  ? "text-(--color-text-secondary)"
                  : "text-(--color-text-muted)"
            }
          />
        </button>
      </GlassTooltip>
    );
  }

  return (
    <div className="flex flex-col">
      <div
        role="button"
        tabIndex={0}
        aria-label={`Workflow: ${goal}`}
        aria-current={isActiveEpic ? "page" : undefined}
        aria-expanded={expanded}
        onClick={openBoard}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openBoard();
          }
        }}
        className={cn(
          "group/epic flex h-[36px] cursor-pointer items-center gap-2 rounded-[8px] px-2",
          "outline-none transition-colors duration-150 hover:bg-(--color-bg-elevated)",
          "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
          // Coral tint ONLY when this epic's board is the open route; an epic
          // that merely owns the open subtask is an ancestor, not the leaf.
          isBoardOpen && "bg-(--color-bg-selected)",
        )}
      >
        <GitFork
          size={14}
          aria-hidden="true"
          className={cn(
            "shrink-0",
            isBoardOpen
              ? "text-(--color-accent-text)"
              : "text-(--color-text-muted)",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] leading-none",
            isActiveEpic
              ? "text-(--color-text-primary)"
              : "text-(--color-text-secondary)",
          )}
        >
          {label}
        </span>
        <EpicRollup epic={epic} subtasks={subtasks} />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            setEpicExpanded(epic.id, !expanded);
          }}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${goal}`}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[6px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-active) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
        >
          <ExpandIcon size={12} />
        </button>
      </div>

      {expanded && subtasks.length > 0 && (
        <div className="mt-0.5 ml-1.5 flex flex-col gap-0.5 border-l border-(--glass-border-hairline) pl-2">
          {subtasks.map((st) => (
            <WorkspaceLink
              key={st.id}
              ws={st}
              repoId={repoId}
              active={st.id === activeWorkspaceId}
              isExpanded={isExpanded}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A compact rollup on the epic row: one status dot per subtask, colored by its
 * derived board state (`deriveBoardState`, so `blocked`/`needs-review` read
 * honestly). Meaning rides each dot's `aria-label`/`title`, never color alone.
 * When the board hasn't loaded yet it falls back to the plain agent state.
 */
function EpicRollup({
  epic,
  subtasks,
}: {
  epic: Workspace;
  subtasks: Workspace[];
}) {
  const { data: board } = useBoard(epic.id);
  const livenessMap = useAllAgentLiveness();
  const anyLive = subtasks.some((s) => {
    const snap = livenessMap[s.id];
    return isLiveState(
      snap?.derivedState ?? (s.status === "running" ? "working" : "stopped"),
    );
  });
  const now = useNow(anyLive);

  if (!subtasks.length) return null;

  return (
    <span
      role="group"
      aria-label="Subtask status"
      className="flex shrink-0 items-center gap-1"
    >
      {subtasks.map((st) => {
        const state: BoardCardState = board
          ? deriveBoardState(st, board, livenessMap[st.id], now).state
          : deriveAgentState(st, livenessMap[st.id], now).state;
        const label = `${st.role ?? st.name}: ${boardStateLabel(state)}`;
        return (
          <span
            key={st.id}
            title={label}
            aria-label={label}
            className="inline-block size-1.5 rounded-full"
            style={{ background: boardDotColor(state) }}
          />
        );
      })}
    </span>
  );
}

/** The dot color for a board-card state (reuses the honest status palette). */
function boardDotColor(state: BoardCardState): string {
  if (state === "blocked" || state === "qas-changes-requested")
    return "var(--color-text-muted)";
  if (state === "needs-review" || state === "in-review")
    return "var(--color-info)";
  return agentStatusMeta(state).colorVar;
}

/** The accessible label for a board-card state. */
function boardStateLabel(state: BoardCardState): string {
  if (state === "blocked") return "Blocked";
  if (state === "needs-review") return "Ready for review";
  if (state === "in-review") return "In review";
  if (state === "qas-changes-requested") return "Changes requested";
  return agentStatusMeta(state).label;
}
