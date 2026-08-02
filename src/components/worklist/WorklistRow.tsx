import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  Ref,
} from "react";
import { Eye, Lock } from "lucide-react";
import { AgentStatusBadgeView } from "@/components/AgentStatusBadge";
import {
  ApprovedChip,
  ChangesRequestedChip,
  InReviewChip,
} from "@/components/board/GateChips";
import { AgentStatusIndicator } from "@/components/ui/AgentStatusIndicator";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import type { BoardCardState } from "@/lib/deriveBoardState";
import type { AgentUiState } from "@/lib/deriveAgentState";
import type { WorklistItem } from "@/lib/deriveWorklist";
import type { Agent } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Short neutral agent-type mark (mockup Page 01: claude→C, codex→O, …). */
const AGENT_MARK: Record<Agent, string> = {
  claude: "C",
  codex: "O",
  copilot: "CP",
  gemini: "G",
  opencode: "OC",
};

/** A board-only bucket state (never a plain honest agent state). */
function isAgentUiState(state: BoardCardState): state is AgentUiState {
  return (
    state !== "blocked" &&
    state !== "needs-review" &&
    state !== "in-review" &&
    state !== "qas-changes-requested"
  );
}

/**
 * One Worklist row (mockup Page 01 row anatomy): leading honest-status glyph ·
 * {ticket name · persona chip · agent-type mark} + a sub-line {repo · epic ·
 * branch/merge-target} · a right-aligned honest status.
 *
 * CRAFT: the row is a BORDERLESS list item on the pane's base surface — no
 * per-row card border (which stacked into a noisy box-list). Separation comes
 * from a clean grid + generous rhythm; a calm `--color-bg-hover` fill on hover
 * and the coral-tinted `--color-bg-selected` on the roving keyboard selection.
 * Coral is scarce by design: the SELECTION is the surface's single warm beacon,
 * so persona/agent marks stay neutral and only honest STATUS carries semantic
 * color.
 *
 * REUSES the Step 0 honest-status components verbatim (`AgentStatusIndicator` +
 * `AgentStatusBadgeView`) so a worklist row can never lie; the board-only buckets
 * get calm, purpose-built chips — `blocked` is MUTED (never coral: it is not the
 * user's fault), `needs-review`/`in-review` are soft `info` review invites, and a
 * bounced `qas-changes-requested` ticket gets the neutral re-work chip (M4), so
 * the worklist tells "awaiting your review" apart from "the agent must rework".
 *
 * Roving-tabindex list item: `selected` sets `tabIndex=0` + `aria-selected`;
 * `Enter`/`Space`/click `open` it (subtask → ticket detail, loose agent → its
 * workspace — same route).
 */
export function WorklistRow({
  item,
  selected,
  rowRef,
  onOpen,
  onFocus,
}: {
  item: WorklistItem;
  selected: boolean;
  rowRef?: Ref<HTMLDivElement>;
  onOpen: () => void;
  onFocus: () => void;
}) {
  const subline = buildSubline(item);

  return (
    <div
      ref={rowRef}
      id={`worklist-row-${item.id}`}
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-testid="worklist-row"
      data-row-id={item.id}
      data-bucket={item.bucket}
      data-state={item.state}
      onClick={onOpen}
      onFocus={onFocus}
      onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-3 rounded-(--radius-control) px-3 py-2.5",
        "outline-none transition-colors duration-150",
        selected
          ? "bg-(--color-bg-selected)"
          : "hover:bg-(--color-bg-hover)",
        "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
      )}
    >
      <span className="flex w-[18px] shrink-0 justify-center">
        <RowGlyph state={item.state} />
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium leading-none text-(--color-text-primary)">
            {item.name}
          </span>
          {item.role ? <PersonaChip role={item.role} /> : null}
          {item.agent ? <AgentTypeMark agent={item.agent} /> : null}
        </div>
        <div className="truncate text-[11.5px] leading-none text-(--color-text-muted)">
          {subline}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2.5 pl-2">
        {item.parentId && item.state === "done" ? (
          // An epic subtask only reaches `done` via review APPROVAL — say the
          // precise word. (A loose agent's `done` stays the honest Done badge.)
          <ApprovedChip />
        ) : isAgentUiState(item.state) ? (
          <AgentStatusBadgeView
            state={item.state}
            since={item.since}
            {...(item.exitCode != null ? { exitCode: item.exitCode } : {})}
          />
        ) : item.state === "blocked" ? (
          <BlockedChip blockedOnRoles={item.blockedOnRoles} />
        ) : item.state === "in-review" ? (
          <InReviewChip />
        ) : item.state === "qas-changes-requested" ? (
          <ChangesRequestedChip />
        ) : (
          <ReviewChip />
        )}
      </div>
    </div>
  );
}

/** repo · epic · branch/merge-target — muted, mono branch (mockup Page 01). */
function buildSubline(item: WorklistItem) {
  const tail = item.merged ? (
    <span>merged into main</span>
  ) : item.branch ? (
    <span className="font-mono text-[11px]">{item.branch}</span>
  ) : null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="truncate">{item.repoName}</span>
      {item.epicName ? (
        <>
          <Dot />
          <span className="truncate">{item.epicName}</span>
        </>
      ) : null}
      {tail ? (
        <>
          <Dot />
          <span className="truncate">{tail}</span>
        </>
      ) : null}
    </span>
  );
}

/** A dim mid-dot separator for the sub-line — quieter than an inline "·". */
function Dot() {
  return (
    <span
      aria-hidden="true"
      className="size-[2.5px] shrink-0 rounded-full bg-(--color-text-muted) opacity-60"
    />
  );
}

/** Leading glyph — reuses the Step 0 indicator for honest agent states. */
function RowGlyph({ state }: { state: BoardCardState }) {
  if (isAgentUiState(state)) return <AgentStatusIndicator state={state} />;
  const Icon = state === "blocked" ? Lock : Eye;
  const color =
    state === "blocked" ? "var(--color-text-muted)" : "var(--color-info)";
  return (
    <span className="inline-flex size-4 shrink-0 items-center justify-center">
      <Icon className="size-[14px]" style={{ color }} aria-hidden="true" />
    </span>
  );
}

/** Neutral persona / DAG-slot chip (never colored — discipline: only status is). */
function PersonaChip({ role }: { role: string }) {
  return (
    <span
      data-testid="worklist-persona"
      className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-(--color-bg-hover) px-2 text-[10.5px] font-medium capitalize leading-none text-(--color-text-secondary)"
    >
      {role}
    </span>
  );
}

/**
 * Small neutral agent-type mark (C/O/G/OC…). The full agent name rides a
 * `GlassTooltip` (L2) — the app's tooltip, not a native `title=` that breaks the
 * glass look.
 */
function AgentTypeMark({ agent }: { agent: Agent }) {
  return (
    <GlassTooltip content={agent} side="top">
      <span
        data-testid="worklist-agent-mark"
        className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-(--color-bg-hover) px-[3px] text-[9px] font-bold leading-none tracking-wide text-(--color-text-muted)"
      >
        {AGENT_MARK[agent]}
      </span>
    </GlassTooltip>
  );
}

/** The blocked "waiting for backend" chip — MUTED (never coral): not the user's fault. */
function BlockedChip({ blockedOnRoles }: { blockedOnRoles: string[] }) {
  const waiting = blockedOnRoles.length
    ? `waiting for ${blockedOnRoles.join(", ")}`
    : "waiting upstream";
  return (
    <span
      role="status"
      data-testid="worklist-blocked-chip"
      className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12px] font-medium leading-none"
    >
      <Lock
        className="size-[13px] shrink-0 text-(--color-text-muted)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">Blocked</span>
      <span className="text-(--color-text-muted)">· {waiting}</span>
    </span>
  );
}

/** The "ready for review" chip — a soft `info` invite for the human's turn. */
function ReviewChip() {
  const style: CSSProperties = {
    background:
      "color-mix(in oklab, var(--color-info) 14%, var(--color-bg-surface))",
    borderColor: "color-mix(in oklab, var(--color-info) 34%, transparent)",
  };
  return (
    <span
      role="status"
      data-testid="worklist-review-chip"
      className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[12px] font-medium leading-none"
      style={style}
    >
      <Eye
        className="size-[13px] shrink-0 text-(--color-info)"
        aria-hidden="true"
      />
      <span className="text-(--color-text-primary)">Ready for review</span>
    </span>
  );
}
