import { ChevronsLeft, Play, Square } from "lucide-react";
import type { ReactNode } from "react";
import { SyncButton } from "@/components/SyncButton";
import { SlidePanel } from "@/components/shell/SlidePanel";
import { AGENT_META } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { DiffCount } from "@/components/ui/Chip";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { formatElapsed } from "@/lib/board";
import { useGitBranchStatus, useGitStatus } from "@/lib/hooks/useGit";
import { useNotes } from "@/lib/hooks/useNotes";
import { useRespondToAttention, useTaskAgentState, useTaskUsage } from "@/lib/hooks/useAgentSignals";
import { useRunningCommands } from "@/lib/hooks/useReview";
import type { RunningCommand } from "@/lib/types";

export function portOf(running: RunningCommand[] | undefined | null, runCommandId: string): number | null {
  return (Array.isArray(running) ? running : []).find((r) => r.runCommandId === runCommandId && r.running)?.port ?? null;
}

/** Whether the run command's process is live (drives the green dot). */
export function isRunning(running: RunningCommand[] | undefined | null, runCommandId: string): boolean {
  return (Array.isArray(running) ? running : []).some((r) => r.runCommandId === runCommandId && r.running);
}
import { useNow } from "@/lib/hooks/useNow";
import { PERMISSION_LABEL } from "@/lib/planPreview";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { mergeTargetBranch } from "@/lib/mergeTarget";
import { runTabsForTask, runTarget } from "@/lib/runScope";
import { SHORTCUTS } from "@/lib/shortcuts";
import { RIGHT_PANEL_WIDTH_MAX, RIGHT_PANEL_WIDTH_MIN, useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { FileChange, Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Single-letter git status for change lists (M / A / D / R / U). */
export function changeLetter(f: FileChange): { letter: string; color: string } {
  const s = f.unstaged !== "other" ? f.unstaged : f.staged;
  switch (s) {
    case "added":
    case "untracked":
      return { letter: "A", color: "var(--color-success)" };
    case "deleted":
      return { letter: "D", color: "var(--color-danger)" };
    case "renamed":
      return { letter: "R", color: "var(--color-info)" };
    case "conflicted":
      return { letter: "U", color: "var(--color-danger)" };
    default:
      return { letter: "M", color: "var(--color-warning)" };
  }
}

/**
 * Task inspector (A-Workspace right column, 280px, ⌘I): what this task is,
 * what it changed, its run commands and the repository's notes.
 */
export function Inspector({
  workspace,
  onReview,
  onOpenNotes,
}: {
  workspace: Workspace;
  onReview: () => void;
  onOpenNotes: () => void;
}) {
  const collapsed = useUiStore((s) => s.rightPanelCollapsed);
  const toggle = useUiStore((s) => s.toggleRightPanel);
  const width = useUiStore((s) => s.rightPanelWidth);
  const setWidth = useUiStore((s) => s.setRightPanelWidth);
  const hasWorktree = !!workspace.worktreePath;
  const { data: changes } = useGitStatus(hasWorktree ? workspace.id : null);
  const adds = changes?.reduce((n, f) => n + (f.adds ?? 0), 0) ?? 0;
  const removes = changes?.reduce((n, f) => n + (f.removes ?? 0), 0) ?? 0;

  // Collapse mechanics (spec P1): the panel slides inside a clipped box and
  // the rail cross-fades in; see SlidePanel.
  const rail = (
    <div className="flex flex-1 flex-col items-center gap-3 py-3">
      <GlassTooltip content={`Show inspector (${SHORTCUTS.toggleRightPanel.display.join("")})`} side="left">
        <button
          type="button"
          aria-label="Show inspector"
          onClick={toggle}
          className="grid size-[28px] place-items-center rounded-(--radius-control) text-(--color-text-muted) transition-colors duration-(--dur-1) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          <ChevronsLeft className="size-3.5" aria-hidden />
        </button>
      </GlassTooltip>
      {changes && changes.length > 0 ? (
        <GlassTooltip content="Review changes" side="left">
          <button
            type="button"
            onClick={onReview}
            aria-label={`${changes.length} changed files — review`}
            className="flex flex-col items-center gap-0.5 font-mono text-[10px] text-(--color-text-muted) [writing-mode:vertical-rl]"
          >
            <DiffCount adds={adds} removes={removes} className="text-[10px]" />
          </button>
        </GlassTooltip>
      ) : null}
    </div>
  );

  return (
    <SlidePanel
      side="right"
      label="Inspector"
      open={!collapsed}
      width={width}
      railWidth="var(--layout-rail-right)"
      rail={rail}
      panelClassName="flex flex-col overflow-y-auto"
      resize={{ min: RIGHT_PANEL_WIDTH_MIN, max: RIGHT_PANEL_WIDTH_MAX, onResize: setWidth }}
    >
      <InspectorContent workspace={workspace} onReview={onReview} onOpenNotes={onOpenNotes} />
    </SlidePanel>
  );
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  // "48.2k" (A-Workspace) — one decimal until it stops adding information.
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * Short model name for the Agent row: "claude-opus-4-5-20251101" →
 * "Opus 4.5", "claude-3-5-sonnet-20241022" → "Sonnet 3.5". Anything else
 * passes through (minus a date suffix).
 */
export function modelLabel(model: string | null | undefined): string | null {
  if (!model) return null;
  const id = model.trim().toLowerCase();
  const family = (f: string) => f.charAt(0).toUpperCase() + f.slice(1);
  const modern = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (modern) return `${family(modern[1]!)} ${modern[2]}${modern[3] ? `.${modern[3]}` : ""}`;
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-(opus|sonnet|haiku)(?:-\d{8})?$/.exec(id);
  if (legacy) return `${family(legacy[3]!)} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ""}`;
  const gpt = /^gpt-(.+)$/.exec(id);
  if (gpt) return `GPT-${gpt[1]}`;
  return model.replace(/-\d{8}$/, "");
}

/**
 * Inspector body (A-Workspace): sections separated by 22px of space — no
 * dividers, no boxed headers. Properties first (no heading), then Changes,
 * Run and Notes. Branch is in the title bar and the worktree path is under
 * "Open in ▾", so neither repeats here.
 */
function InspectorContent({
  workspace,
  onReview,
  onOpenNotes,
}: {
  workspace: Workspace;
  onReview: () => void;
  onOpenNotes: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-[22px] px-[20px] pb-[20px] pt-[18px] text-[12.5px] leading-[1.45]">
      <NeedsYouBanner workspace={workspace} />
      <PropertiesSection workspace={workspace} />
      {workspace.worktreePath ? <ChangesSection workspaceId={workspace.id} onReview={onReview} /> : null}
      <RunCommandsSection repositoryId={workspace.repositoryId} taskId={workspace.id} target={runTarget(workspace)} />
      <NotesSection repositoryId={workspace.repositoryId} onOpenNotes={onOpenNotes} />
    </div>
  );
}

/** A titled inspector section: a text-2 weight-500 heading, no box. */
function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-[8px]">
      <h3 className="m-0 flex min-h-[18px] items-center gap-[8px] text-[12.5px] font-medium text-(--color-text-secondary)">
        <span className="flex-1">{title}</span>
        {aside}
      </h3>
      {children}
    </section>
  );
}

/** A plain-text action (Review changes →, Add note…, View all). */
const textAction =
  "self-start rounded-(--radius-chip) text-left text-[12.5px] transition-colors duration-(--dur-1) ease-(--ease-out) focus-visible:outline-none focus-visible:shadow-(--ring-focus)";

/** A-States: the inspector leads with what the agent is blocked on. */
function NeedsYouBanner({ workspace }: { workspace: Workspace }) {
  const state = useTaskAgentState(workspace.id);
  const respond = useRespondToAttention();
  const now = useNow(state?.state === "needs-you");
  const att = state?.state === "needs-you" ? state.attention : null;
  if (!att) return null;
  return (
    <section
      aria-label="Needs you"
      className="-mx-[10px] flex flex-col gap-[8px] rounded-(--radius-card) bg-(--color-warning-tint) px-[12px] py-[10px]"
    >
      <span className="flex items-center gap-[8px] font-medium text-(--color-warning)">
        <span aria-hidden className="size-[6px] rounded-full bg-(--color-warning)" />
        Needs you
        <span className="flex-1" />
        <span className="font-normal tabular-nums text-(--color-text-muted)">{formatElapsed(att.since, now)}</span>
      </span>
      <p className="m-0 leading-[1.5] text-(--color-text-secondary)">
        {att.title}
        {att.detail ? (
          <>
            {": "}
            <span className="font-mono text-[11.5px] text-(--color-text-primary)">{att.detail}</span>
          </>
        ) : null}
        {". The agent is paused."}
      </p>
      {att.canRespond ? (
        <span className="flex gap-[6px]">
          <Button
            variant="primary"
            size="sm"
            className="h-[28px] px-[12px]"
            shortcut="⌘Y"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ taskId: workspace.id, attentionId: att.id, response: "allow-once" })}
          >
            Allow
          </Button>
          <Button
            variant="danger"
            size="sm"
            className="h-[28px] px-[10px]"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ taskId: workspace.id, attentionId: att.id, response: "deny" })}
          >
            Deny
          </Button>
        </span>
      ) : null}
    </section>
  );
}

/** Key/value grid (72px keys): Agent, Base, Started, Usage, Permissions. */
function PropertiesSection({ workspace }: { workspace: Workspace }) {
  const { data: repo } = useRepository(workspace.repositoryId);
  const { data: branch } = useGitBranchStatus(workspace.worktreePath ? workspace.id : null);
  const { data: usage } = useTaskUsage(workspace.agent ? workspace.id : null);
  const running = workspace.status === "running";
  const now = useNow(running);
  const started = workspace.startedAt ? new Date(workspace.startedAt) : null;
  const base = mergeTargetBranch(branch, workspace, repo);
  const behind = branch && branch.targetRef !== null ? branch.behindOfTarget : 0;
  const baseTitle =
    !branch || branch.targetRef === null
      ? undefined
      : behind > 0
        ? `${behind} commit${behind === 1 ? "" : "s"} behind ${branch.targetRef}`
        : `Up to date with ${branch.targetRef}`;
  const isAgent = workspace.workspaceKind === "agent";
  const model = modelLabel(usage?.model);
  const key = "text-(--color-text-muted)";

  return (
    <section aria-label={workspace.workspaceKind === "local" ? "Workspace" : "Task"}>
      <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-[12px] gap-y-[7px]">
        {workspace.agent ? (
          <>
            <dt className={key}>Agent</dt>
            <dd className="m-0 flex min-w-0 items-center gap-[6px]">
              {AGENT_META[workspace.agent].label}
              {model ? (
                <span className="truncate text-(--color-text-muted)" title={usage?.model ?? undefined}>
                  {model}
                </span>
              ) : null}
            </dd>
          </>
        ) : null}
        {isAgent ? (
          <>
            <dt className={key}>Base</dt>
            <dd className="m-0 flex min-w-0 items-center gap-[6px]" title={baseTitle}>
              <span className="truncate font-mono text-[11.5px]">{base}</span>
              {behind > 0 ? (
                <>
                  <span className="shrink-0 tabular-nums text-(--color-text-muted)">{behind} behind</span>
                  <SyncButton workspaceId={workspace.id} appearance="link" />
                </>
              ) : null}
            </dd>
          </>
        ) : null}
        {started ? (
          <>
            <dt className={key}>Started</dt>
            <dd className="m-0 tabular-nums">
              {started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
              {running ? ` · ${formatElapsed(workspace.startedAt, now)}` : ""}
            </dd>
          </>
        ) : null}
        {usage ? (
          <>
            <dt className={key}>Usage</dt>
            <dd className="m-0 tabular-nums">
              {formatTokens(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)} tokens
              {usage.costUsd !== null ? ` · ${usage.costPartial ? "≥ " : ""}$${usage.costUsd.toFixed(2)}` : ""}
            </dd>
          </>
        ) : null}
        {isAgent ? (
          <>
            <dt className={key}>Permissions</dt>
            {/* `null` = a row from before permission modes, which runs skip-all. */}
            <dd className="m-0 truncate">{PERMISSION_LABEL[workspace.permissionMode ?? "skip-all"]}</dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}

const CHANGES_PREVIEW = 6;

function ChangesSection({ workspaceId, onReview }: { workspaceId: string; onReview: () => void }) {
  const { data: changes } = useGitStatus(workspaceId);
  const adds = changes?.reduce((n, f) => n + (f.adds ?? 0), 0) ?? 0;
  const removes = changes?.reduce((n, f) => n + (f.removes ?? 0), 0) ?? 0;
  const has = !!changes && changes.length > 0;
  return (
    <Section
      title="Changes"
      aside={
        has ? (
          <span
            className="whitespace-nowrap font-mono text-[11px] font-normal text-(--color-text-muted)"
            title={`${changes.length} ${changes.length === 1 ? "file" : "files"}`}
          >
            +{adds} −{removes}
          </span>
        ) : null
      }
    >
      {has ? (
        <ul className="m-0 flex list-none flex-col gap-[6px] p-0 font-mono text-[11.5px] text-(--color-text-secondary)">
          {changes.slice(0, CHANGES_PREVIEW).map((f) => {
            const { letter, color } = changeLetter(f);
            return (
              <li key={f.path} className="flex min-w-0 gap-[8px]">
                <span className="w-[8px] shrink-0" style={{ color }}>
                  {letter}
                </span>
                <span className="min-w-0 flex-1 truncate" title={f.path}>
                  {f.path}
                </span>
              </li>
            );
          })}
          {changes.length > CHANGES_PREVIEW ? (
            <li className="font-sans text-[12px] text-(--color-text-muted)">
              {changes.length - CHANGES_PREVIEW} more
            </li>
          ) : null}
        </ul>
      ) : (
        <p className="m-0 text-(--color-text-muted)">No changes yet.</p>
      )}
      {has ? (
        <button
          type="button"
          onClick={onReview}
          aria-keyshortcuts="Meta+Shift+R"
          className={cn(textAction, "text-(--color-text-secondary) hover:text-(--color-text-primary)")}
        >
          Review changes →
        </button>
      ) : null}
    </Section>
  );
}

function RunCommandsSection({ repositoryId, taskId, target }: { repositoryId: string; taskId: string; target: string | null }) {
  const { data: commands } = useRunCommands(repositoryId);
  const { data: running } = useRunningCommands(target);
  const runPanel = useUiStore((s) => s.runPanel);
  if (!commands || commands.length === 0) return null;
  // Open = in THIS task's pane bar, not open in some other task.
  const openHere = new Set(runTabsForTask(runPanel.openTabs, runPanel.shown, running, taskId, target));
  return (
    <Section title="Run">
      <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
        {[...commands]
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder)
          .map((rc) => {
            const open = openHere.has(rc.id);
            const live = isRunning(running, rc.id);
            const port = portOf(running, rc.id);
            return (
              <li
                key={rc.id}
                className={cn(
                  "group/rc relative -mx-[10px] flex h-[30px] items-center gap-[10px] rounded-(--radius-control) px-[10px]",
                  "transition-colors duration-(--dur-1) ease-(--ease-out)",
                  open || live ? "bg-(--color-bg-surface)" : "hover:bg-(--color-bg-surface)",
                )}
              >
                <span
                  aria-hidden
                  className={cn("size-[6px] shrink-0 rounded-full", live ? "bg-(--color-success)" : "bg-(--color-text-faint)")}
                />
                <button
                  type="button"
                  onClick={() => runPanel.openTab(rc.id, taskId)}
                  className={cn(
                    "min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:underline",
                    open || live ? "text-(--color-text-primary)" : "text-(--color-text-secondary)",
                  )}
                >
                  {rc.name}
                </button>
                <span
                  title={port ? `${rc.command} · :${port}` : rc.command}
                  className="max-w-[60%] truncate font-mono text-[11px] text-(--color-text-muted) group-hover/rc:invisible group-focus-within/rc:invisible"
                >
                  {rc.command}
                </span>
                {/* Always in the tab order (never display:none): revealed on
                    hover, on keyboard focus, or while the row has focus. It
                    sits over the command so the command can stay flush right. */}
                <button
                  type="button"
                  aria-label={open ? `Stop ${rc.name}` : `Run ${rc.name}`}
                  onClick={() => {
                    if (open) {
                      void tauri.stopRunCommand(rc.id, target).catch(() => {});
                      runPanel.closeTab(rc.id, taskId);
                    } else {
                      runPanel.openTab(rc.id, taskId);
                    }
                  }}
                  className="absolute right-[6px] grid size-[20px] place-items-center rounded-(--radius-chip) text-(--color-text-muted) opacity-0 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) group-hover/rc:opacity-100 group-focus-within/rc:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
                >
                  {open ? <Square className="size-[10px]" fill="currentColor" aria-hidden /> : <Play className="size-[12px]" fill="currentColor" aria-hidden />}
                </button>
              </li>
            );
          })}
      </ul>
    </Section>
  );
}

function NotesSection({ repositoryId, onOpenNotes }: { repositoryId: string; onOpenNotes: () => void }) {
  const { data: notes } = useNotes(repositoryId);
  const openNotesComposer = useUiStore((s) => s.openNotesComposer);
  const open = (notes ?? []).filter((n) => !n.doneAt);
  // Newest first from the backend: the last note written.
  const latest = open[0];
  return (
    <Section
      title="Notes"
      aside={
        open.length > 0 ? (
          <button
            type="button"
            onClick={onOpenNotes}
            aria-label="Repository notes"
            className={cn(textAction, "text-[12px] font-normal text-(--color-text-muted) hover:text-(--color-text-primary)")}
          >
            View all {open.length}
          </button>
        ) : null
      }
    >
      {latest ? (
        <p className="m-0 line-clamp-4 leading-[1.55] text-(--color-text-secondary)">{latest.body}</p>
      ) : null}
      <button
        type="button"
        onClick={() => {
          onOpenNotes();
          openNotesComposer();
        }}
        aria-keyshortcuts="Meta+Shift+N"
        title={`Add note (${SHORTCUTS.openNotes.display.join("")})`}
        className={cn(textAction, "text-(--color-text-muted) hover:text-(--color-text-primary)")}
      >
        Add note…
      </button>
    </Section>
  );
}
