import { ChevronsLeft, ChevronsRight, Play, Plus, Square } from "lucide-react";
import { useState, type ReactNode } from "react";
import { SyncButton } from "@/components/SyncButton";
import { AgentMark } from "@/components/ui/AgentMark";
import { Button } from "@/components/ui/Button";
import { DiffCount } from "@/components/ui/Chip";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { GroupHeader } from "@/components/ui/GroupHeader";
import { Kbd } from "@/components/ui/Kbd";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { formatElapsed } from "@/lib/board";
import { useGitBranchStatus, useGitStatus } from "@/lib/hooks/useGit";
import { useNotes } from "@/lib/hooks/useNotes";
import { useRespondToAttention, useTaskAgentState, useTaskUsage } from "@/lib/hooks/useAgentSignals";
import { useRunningCommands } from "@/lib/hooks/useReview";
import type { RunningCommand } from "@/lib/types";

export function portOf(running: RunningCommand[] | undefined | null, runCommandId: string): number | null {
  return (Array.isArray(running) ? running : []).find((r) => r.runCommandId === runCommandId && r.running)?.port ?? null;
}
import { useNow } from "@/lib/hooks/useNow";
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

function tildePath(path: string | null): string {
  if (!path) return "—";
  return path.replace(/^\/Users\/[^/]+/, "~");
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5 border-b border-(--color-border-subtle) px-4 py-3.5">
      <GroupHeader as="h3" action={aside}>
        {title}
      </GroupHeader>
      {children}
    </section>
  );
}

/**
 * Task inspector (A-Workspace right column, 300px, ⌘I): what this task is,
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
  const [resizing, setResizing] = useState(false);
  const hasWorktree = !!workspace.worktreePath;
  const { data: changes } = useGitStatus(hasWorktree ? workspace.id : null);
  const adds = changes?.reduce((n, f) => n + (f.adds ?? 0), 0) ?? 0;
  const removes = changes?.reduce((n, f) => n + (f.removes ?? 0), 0) ?? 0;

  if (collapsed) {
    return (
      <aside
        aria-label="Inspector"
        className="flex w-(--layout-rail-right) shrink-0 flex-col items-center gap-3 border-l border-(--color-border-subtle) bg-(--color-bg-sidebar) py-3"
      >
        <GlassTooltip content={`Show inspector (${SHORTCUTS.toggleRightPanel.display.join("")})`} side="left">
          <button
            type="button"
            aria-label="Show inspector"
            onClick={toggle}
            className="grid size-6 place-items-center rounded-(--radius-chip) border border-(--color-border-default) text-(--color-text-muted) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
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
      </aside>
    );
  }

  return (
    <aside
      aria-label="Inspector"
      style={{ width }}
      className={cn(
        "relative flex shrink-0 flex-col overflow-y-auto border-l border-(--color-border-subtle) bg-(--color-bg-sidebar)",
        !resizing && "transition-[width] duration-200 [transition-timing-function:var(--ease-glass)]",
      )}
    >
      <ResizeHandle
        edge="left"
        width={width}
        min={RIGHT_PANEL_WIDTH_MIN}
        max={RIGHT_PANEL_WIDTH_MAX}
        onResize={setWidth}
        onResizeStart={() => setResizing(true)}
        onResizeEnd={() => setResizing(false)}
      />
      <NeedsYouBanner workspace={workspace} />
      <TaskSection workspace={workspace} onCollapse={toggle} />
      {hasWorktree ? (
        <Section
          title="Changes"
          aside={
            changes && changes.length > 0 ? (
              <span className="font-mono text-[11px] text-(--color-text-muted)">
                <DiffCount adds={adds} removes={removes} /> · {changes.length} {changes.length === 1 ? "file" : "files"}
              </span>
            ) : null
          }
        >
          {changes && changes.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-1 p-0 font-mono text-[11px]">
              {changes.slice(0, 6).map((f) => {
                const { letter, color } = changeLetter(f);
                return (
                  <li key={f.path} className="flex gap-2">
                    <span className="w-2.5 shrink-0" style={{ color }}>
                      {letter}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-(--color-text-secondary)" title={f.path}>
                      {f.path}
                    </span>
                    {f.adds ? <span className="text-(--diff-add-fg)">+{f.adds}</span> : null}
                    {f.removes ? <span className="text-(--diff-remove-fg)">−{f.removes}</span> : null}
                  </li>
                );
              })}
              {changes.length > 6 ? (
                <li className="text-(--color-text-muted)">+{changes.length - 6} more</li>
              ) : null}
            </ul>
          ) : (
            <p className="m-0 text-[12px] text-(--color-text-muted)">No changes yet.</p>
          )}
          <Button className="w-full" onClick={onReview} disabled={!changes || changes.length === 0}>
            Review diff
          </Button>
        </Section>
      ) : null}
      <RunCommandsSection repositoryId={workspace.repositoryId} taskId={workspace.id} target={runTarget(workspace)} />
      <NotesSection repositoryId={workspace.repositoryId} onOpenNotes={onOpenNotes} />
    </aside>
  );
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

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
      className="flex flex-col gap-2 border-b border-(--color-border-subtle) bg-(--color-warning-tint) px-4 py-3"
    >
      <span className="flex items-center gap-2 text-[12px] font-medium text-(--color-warning)">
        Needs you
        <span className="font-normal tabular-nums">{formatElapsed(att.since, now)}</span>
      </span>
      <p className="m-0 text-[12px] leading-[1.5] text-(--color-text-secondary)">
        {att.title}
        {att.detail ? (
          <>
            {": "}
            <span className="font-mono text-(--color-text-primary)">{att.detail}</span>
          </>
        ) : null}
        {". The agent is paused."}
      </p>
      {att.canRespond ? (
        <span className="flex gap-1.5">
          <Button
            variant="primary"
            size="sm"
            shortcut="⌘Y"
            disabled={respond.isPending}
            onClick={() => respond.mutate({ taskId: workspace.id, attentionId: att.id, response: "allow-once" })}
          >
            Allow
          </Button>
          <Button
            size="sm"
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

function TaskSection({ workspace, onCollapse }: { workspace: Workspace; onCollapse: () => void }) {
  const { data: repo } = useRepository(workspace.repositoryId);
  const { data: branch } = useGitBranchStatus(workspace.worktreePath ? workspace.id : null);
  const { data: usage } = useTaskUsage(workspace.agent ? workspace.id : null);
  const running = workspace.status === "running";
  const now = useNow(running);
  const started = workspace.startedAt ? new Date(workspace.startedAt) : null;
  const base = mergeTargetBranch(branch, workspace, repo);
  const baseState =
    !branch || branch.targetRef === null
      ? null
      : branch.behindOfTarget > 0
        ? `${branch.behindOfTarget} behind`
        : "up to date";

  return (
    <Section
      title={workspace.workspaceKind === "local" ? "Workspace" : "Task"}
      aside={
        <GlassTooltip content={`Hide inspector (${SHORTCUTS.toggleRightPanel.display.join("")})`} side="left">
          <button
            type="button"
            aria-label="Collapse inspector"
            onClick={onCollapse}
            className="grid size-[22px] place-items-center rounded-(--radius-chip) border border-(--color-border-default) text-(--color-text-muted) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            <ChevronsRight className="size-3.5" aria-hidden />
          </button>
        </GlassTooltip>
      }
    >
      <dl className="m-0 grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12px]">
        {workspace.agent ? (
          <>
            <dt className="text-(--color-text-muted)">Agent</dt>
            <dd className="m-0">
              <AgentMark agent={workspace.agent} withLabel />
            </dd>
          </>
        ) : null}
        <dt className="text-(--color-text-muted)">Branch</dt>
        <dd className="m-0 truncate font-mono text-[11px]">{workspace.branch ?? "—"}</dd>
        {workspace.workspaceKind === "agent" ? (
          <>
            <dt className="text-(--color-text-muted)">Base</dt>
            <dd className="m-0 flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
              <span className="truncate">
                {base}
                {baseState ? ` · ${baseState}` : ""}
              </span>
              {branch && branch.behindOfTarget > 0 ? <SyncButton workspaceId={workspace.id} /> : null}
            </dd>
          </>
        ) : null}
        <dt className="text-(--color-text-muted)">{workspace.workspaceKind === "local" ? "Path" : "Worktree"}</dt>
        <dd className="m-0 truncate font-mono text-[11px]" title={workspace.worktreePath ?? undefined}>
          {tildePath(workspace.worktreePath)}
        </dd>
        {usage ? (
          <>
            <dt className="text-(--color-text-muted)">Tokens</dt>
            <dd className="m-0 font-mono text-[11px]" title={usage.model ?? undefined}>
              {formatTokens(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)}
              {usage.costUsd !== null ? ` · ${usage.costPartial ? "≥ " : ""}$${usage.costUsd.toFixed(2)}` : ""}
            </dd>
          </>
        ) : null}
        {started ? (
          <>
            <dt className="text-(--color-text-muted)">Started</dt>
            <dd className="m-0">
              {started.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {running ? ` · ${formatElapsed(workspace.startedAt, now)}` : ""}
            </dd>
          </>
        ) : null}
      </dl>
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
    <Section title="Run commands">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {[...commands]
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder)
          .map((rc) => {
            const open = openHere.has(rc.id);
            return (
              <li
                key={rc.id}
                className={cn(
                  "group/rc flex h-[30px] items-center gap-2 rounded-(--radius-control) border px-2",
                  open ? "border-(--color-border-default) bg-(--color-bg-surface)" : "border-(--color-border-subtle)",
                )}
              >
                <span
                  aria-hidden
                  className={cn("size-1.5 shrink-0 rounded-full", open ? "bg-(--color-success)" : "bg-(--color-text-faint)")}
                />
                <button
                  type="button"
                  onClick={() => runPanel.openTab(rc.id, taskId)}
                  className="min-w-0 flex-1 truncate text-left text-[12px] focus-visible:outline-none focus-visible:underline"
                >
                  {rc.name}
                </button>
                <span className="truncate font-mono text-[11px] text-(--color-text-muted) group-hover/rc:hidden group-focus-within/rc:hidden">
                  {portOf(running, rc.id) ? `:${portOf(running, rc.id)}` : rc.command}
                </span>
                {/* Always in the tab order (never display:none): revealed on
                    hover, on keyboard focus, or while the row has focus. */}
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
                  className="grid size-5 shrink-0 place-items-center rounded-(--radius-chip) text-(--color-text-muted) opacity-0 hover:text-(--color-text-primary) group-hover/rc:opacity-100 group-focus-within/rc:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
                >
                  {open ? <Square className="size-2.5" fill="currentColor" aria-hidden /> : <Play className="size-3" fill="currentColor" aria-hidden />}
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
  return (
    <Section
      title="Notes"
      aside={
        open.length > 0 ? (
          <button
            type="button"
            onClick={onOpenNotes}
            aria-label="Repository notes"
            className="text-[11px] text-(--color-text-muted) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:underline"
          >
            View all {open.length}
          </button>
        ) : null
      }
    >
      {open.slice(0, 3).map((n) => (
        <p key={n.id} className="m-0 line-clamp-3 text-[12px] leading-[1.5] text-(--color-text-secondary)">
          {n.body}
        </p>
      ))}
      <Button
        variant="dashed"
        className="w-full"
        onClick={() => {
          onOpenNotes();
          openNotesComposer();
        }}
      >
        <Plus className="size-3" aria-hidden />
        Add note <Kbd tone="bare">{SHORTCUTS.openNotes.display.join("")}</Kbd>
      </Button>
    </Section>
  );
}
