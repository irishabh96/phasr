import { useQueries } from "@tanstack/react-query";
import { AlertTriangle, Check, FileDiff, GitBranch } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DiffList } from "@/components/diff/DiffList";
import { DiffModeToggle, type DiffViewMode } from "@/components/diff/DiffView";
import type { DiffCardFile } from "@/components/diff/DiffCard";
import { PanelState } from "@/components/ui/PanelState";
import {
  useGitAbortMerge,
  useGitBranchStatus,
  useGitCommit,
  useGitContinueMerge,
  useGitDiscard,
  useGitMergeInProgress,
  useGitPush,
  useGitResolveConflict,
  useGitStage,
  useGitStatus,
  useGitUnstage,
} from "@/lib/hooks/useGit";
import { humanizeError } from "@/lib/humanizeError";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { tauri } from "@/lib/tauri";
import type {
  ConflictSide,
  DiffScope,
  FileChange,
  FileStatus,
} from "@/lib/types";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";

const COMMIT_SHORTCUT = SHORTCUTS.submitForm;
const COMMIT_AND_PUSH_SHORTCUT = SHORTCUTS.commitAndPush;
const SUCCESS_FADE_MS = 4_000;
const DIFF_MODE_KEY = "phasr.diff.viewMode";
// Cards auto-expanded per section on load; matches the old per-DiffList
// `defaultExpanded={10}`. Only expanded cards fetch their diff, so this is
// also the cap on how many diffs we fetch up front.
const DEFAULT_EXPANDED_PER_SECTION = 10;

function readDiffMode(): DiffViewMode {
  if (typeof window === "undefined") return "side-by-side";
  return window.localStorage.getItem(DIFF_MODE_KEY) === "inline"
    ? "inline"
    : "side-by-side";
}

interface ChangesPanelProps {
  workspaceId: string;
  /**
   * Diff view mode + its setter. When BOTH are supplied (the workspace right
   * sidebar) the panel is CONTROLLED — the Split/Inline toggle lives on the tab
   * row and one ⌘\ listener up there drives every section. When OMITTED (the
   * board's conflict-resolution dialog, which has no tab row) the panel falls
   * back to owning the mode itself: its own persisted state, ⌘\ listener, and a
   * Split/Inline toolbar rendered above the sections.
   */
  diffMode?: DiffViewMode;
  onDiffModeChange?: (m: DiffViewMode) => void;
}

type Bucket = "conflicts" | "staged" | "unstaged" | "partial";

/**
 * Workspace changes pane. Files are grouped into STAGED / UNSTAGED /
 * PARTIAL sections (cf. VSCode and GitHub Desktop). Each section has
 * its own bulk action; cards still show per-file stage/unstage/discard
 * icons that self-select based on the file's per-side status.
 *
 * Diffs are fetched in parallel via TanStack `useQueries` so the user
 * sees results stream in instead of waiting for the whole set.
 */
export function ChangesPanel({
  workspaceId,
  diffMode: controlledMode,
  onDiffModeChange: controlledOnChange,
}: ChangesPanelProps) {
  const {
    data: changes,
    isLoading: statusLoading,
    isError: statusError,
    error: statusErr,
    refetch: refetchStatus,
  } = useGitStatus(workspaceId);
  const { data: branchStatus } = useGitBranchStatus(workspaceId);
  const { data: mergeInProgress } = useGitMergeInProgress(workspaceId);
  const stage = useGitStage(workspaceId);
  const unstage = useGitUnstage(workspaceId);
  const discard = useGitDiscard(workspaceId);
  const commit = useGitCommit(workspaceId);
  const push = useGitPush(workspaceId);
  const resolveConflict = useGitResolveConflict(workspaceId);
  const continueMerge = useGitContinueMerge(workspaceId);
  const abortMerge = useGitAbortMerge(workspaceId);

  const [message, setMessage] = useState("");
  // Once the user has focused or typed anything, keep the textarea
  // expanded — re-focusing after typing should not shrink it back.
  const [expanded, setExpanded] = useState(false);
  // Track the most recent push success so the confirmation auto-fades
  // a few seconds after it lands (and disappears on the next commit).
  const [lastPushAt, setLastPushAt] = useState<number | null>(null);
  const [lastCommitAt, setLastCommitAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  // Controlled by the workspace right sidebar (toggle on the tab row), or
  // self-owned in the board's dialog (its own toolbar + ⌘\). One path or the
  // other — never both listeners at once.
  const controlledMode_ = controlledMode;
  const controlled =
    controlledMode_ !== undefined && controlledOnChange !== undefined;
  const [internalMode, setInternalMode] = useState<DiffViewMode>(readDiffMode);
  const diffMode = controlled ? controlledMode_ : internalMode;
  const onDiffModeChange = useCallback(
    (next: DiffViewMode) => {
      if (controlled) {
        controlledOnChange?.(next);
        return;
      }
      setInternalMode(next);
      try {
        window.localStorage.setItem(DIFF_MODE_KEY, next);
      } catch {
        /* ignore quota / sandboxed iframe */
      }
    },
    [controlled, controlledOnChange],
  );
  useEffect(() => {
    if (controlled) return;
    const handler = (e: KeyboardEvent) => {
      if (!matchShortcut(e, SHORTCUTS.toggleDiffMode)) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (target?.isContentEditable) return;
      e.preventDefault();
      onDiffModeChange(
        internalMode === "side-by-side" ? "inline" : "side-by-side",
      );
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [controlled, internalMode, onDiffModeChange]);

  // Expansion is owned HERE (not inside each DiffList) so we can gate the
  // per-file diff fetch on it: only expanded cards fetch their raw diff, so
  // collapsed cards issue ZERO gitDiff calls. One flat set of open paths
  // spans all four sections.
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const changesKey = useMemo(
    () => (changes ?? []).map((c) => c.path).join(" "),
    [changes],
  );
  useEffect(() => {
    const list = changes ?? [];
    setExpandedPaths((prev) => {
      // Keep the user's toggles for paths that survive a worktree change;
      // only auto-seed when none of the previously-open paths remain (a
      // fresh worktree / first load) — new files stay collapsed.
      const surviving = new Set<string>();
      for (const c of list) if (prev.has(c.path)) surviving.add(c.path);
      if (surviving.size > 0) return surviving;
      return seedExpandedPaths(list, DEFAULT_EXPANDED_PER_SECTION);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changesKey]);
  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const allFiles = useDiffFiles(workspaceId, changes ?? [], expandedPaths);

  const { conflicts, staged, unstaged, partial } = useMemo(() => {
    const groups: Record<Bucket, DiffCardFile[]> = {
      conflicts: [],
      staged: [],
      unstaged: [],
      partial: [],
    };
    for (const f of allFiles) groups[bucketFor(f)].push(f);
    return groups;
  }, [allFiles]);

  const stagedCount = staged.length + partial.length;
  const mergeKind = mergeInProgress?.kind ?? "none";
  const inMerge = mergeKind !== "none";
  const conflictCount = conflicts.length;
  // A branch with no upstream (`upstream === null`) has never been
  // pushed, so `ahead` is 0 even when it has commits — allow that first
  // push (git's `--set-upstream` publishes it), otherwise the button
  // would be permanently disabled on brand-new workspace branches.
  const canPush =
    !!branchStatus &&
    branchStatus.hasRemote &&
    !branchStatus.detached &&
    (branchStatus.ahead > 0 || branchStatus.upstream === null);

  // Re-render once after a success message lands so we can hide it
  // when SUCCESS_FADE_MS has elapsed. The tick state is intentionally
  // unused other than to force a render.
  void tick;
  useEffect(() => {
    if (lastPushAt === null && lastCommitAt === null) return;
    const t = setTimeout(() => setTick((n) => n + 1), SUCCESS_FADE_MS + 50);
    return () => clearTimeout(t);
  }, [lastPushAt, lastCommitAt]);

  const showPushSuccess =
    lastPushAt !== null && Date.now() - lastPushAt < SUCCESS_FADE_MS;
  const showCommitSuccess =
    lastCommitAt !== null && Date.now() - lastCommitAt < SUCCESS_FADE_MS;

  const copyPath = (p: string) => {
    void navigator.clipboard?.writeText(p);
  };
  const handleStage = (p: string) => stage.mutate([p]);
  const handleUnstage = (p: string) => unstage.mutate([p]);
  const handleDiscard = (p: string) => discard.mutate([p]);

  // Conflict resolution — framed by intent ("keep mine" / "use theirs")
  // and mapped to the correct git side. Git INVERTS --ours/--theirs
  // during a rebase (HEAD is the branch you're replaying onto), so the
  // side that preserves YOUR work is `ours` in a merge but `theirs` in
  // a rebase. Getting this wrong silently discards the user's work.
  const mineSide: ConflictSide = mergeKind === "rebase" ? "theirs" : "ours";
  const otherSide: ConflictSide = mergeKind === "rebase" ? "ours" : "theirs";
  const mineName = branchStatus?.branch ?? null;
  const otherName =
    mergeKind === "rebase"
      ? (branchStatus?.targetRef ?? "the base branch")
      : "the incoming branch";
  const conflictActions = {
    keepMine: {
      label: `Keep your changes${mineName ? ` (${mineName})` : ""}`,
      confirmTitle: "Keep your changes?",
      confirmBody: `Keep your version and discard ${otherName}'s changes to this file. This can't be undone.`,
      confirmLabel: "Keep mine",
      onResolve: (p: string) =>
        resolveConflict.mutate({ path: p, side: mineSide }),
    },
    useOther: {
      label: `Use ${otherName}'s version`,
      confirmTitle: `Use ${otherName}'s version?`,
      confirmBody: `Replace this file with ${otherName}'s version and discard your changes. This can't be undone.`,
      confirmLabel: "Use theirs",
      onResolve: (p: string) =>
        resolveConflict.mutate({ path: p, side: otherSide }),
    },
  };

  const handleCommit = async () => {
    if (!message.trim() || stagedCount === 0) return;
    await commit.mutateAsync(message.trim());
    setMessage("");
    // Collapse the textarea back to its resting height now the message is sent.
    setExpanded(false);
    setLastCommitAt(Date.now());
    setLastPushAt(null);
  };

  const handleCommitAndPush = async () => {
    if (commit.isPending || push.isPending) return;
    const hasStagedCommit = !!message.trim() && stagedCount > 0;
    // Staged changes with no message: bail so the user fills it in
    // instead of silently pushing whatever's already on HEAD.
    if (stagedCount > 0 && !message.trim()) return;
    // Nothing to commit AND nothing to push: no-op.
    if (!hasStagedCommit && !canPush) return;
    if (hasStagedCommit) {
      try {
        await commit.mutateAsync(message.trim());
        setMessage("");
        setExpanded(false);
        setLastCommitAt(Date.now());
      } catch {
        return;
      }
    }
    try {
      await push.mutateAsync();
      setLastPushAt(Date.now());
    } catch {
      /* push.error renders below */
    }
  };

  const handleTextareaKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    const native = e.nativeEvent as KeyboardEvent;
    if (matchShortcut(native, COMMIT_AND_PUSH_SHORTCUT)) {
      e.preventDefault();
      void handleCommitAndPush();
      return;
    }
    if (matchShortcut(native, COMMIT_SHORTCUT)) {
      e.preventDefault();
      void handleCommit();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Uncontrolled (board dialog) renders its own toolbar; the workspace
          sidebar folds the toggle onto the tab row, so it renders none here. */}
      {!controlled && allFiles.length > 0 && (
        <div className="flex shrink-0 items-center justify-end border-b border-(--color-border-subtle) px-2 py-1.5">
          <DiffModeToggle mode={diffMode} onChange={onDiffModeChange} />
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-5 overflow-auto p-3">
        {statusError && (
          <PanelState
            kind="error"
            title="Couldn't load changes"
            error={statusErr}
            onRetry={() => void refetchStatus()}
            className="my-auto"
          />
        )}
        {!statusError && changes === undefined && statusLoading && (
          <PanelState kind="loading" rows={4} className="pt-1" />
        )}
        {!statusError &&
          changes !== undefined &&
          changes.length === 0 &&
          !inMerge && (
            <PanelState
              kind="empty"
              icon={<FileDiff aria-hidden="true" />}
              title="No changes"
              description="This worktree is even with HEAD. Edits you or the agent make show up here, ready to stage and commit."
              className="my-auto"
            />
          )}

        {conflicts.length > 0 && (
          <Section
            title={mergeKind === "rebase" ? "Conflicts (rebase)" : "Conflicts"}
            count={conflicts.length}
          >
            <DiffList
              files={conflicts}
              expanded={expandedPaths}
              onToggle={toggleExpanded}
              mode={diffMode}
              onModeChange={onDiffModeChange}
              onCopyPath={copyPath}
              conflict={conflictActions}
            />
          </Section>
        )}

        {staged.length > 0 && (
          <Section
            title="Staged"
            count={staged.length}
            action={
              <GlassButton
                variant="ghost"
                size="sm"
                onClick={() => unstage.mutate([])}
                disabled={unstage.isPending}
              >
                Unstage all
              </GlassButton>
            }
          >
            <DiffList
              files={staged}
              expanded={expandedPaths}
              onToggle={toggleExpanded}
              mode={diffMode}
              onModeChange={onDiffModeChange}
              onCopyPath={copyPath}
              onUnstage={handleUnstage}
              onDiscard={handleDiscard}
            />
          </Section>
        )}

        {unstaged.length > 0 && (
          <Section
            title="Unstaged"
            count={unstaged.length}
            action={
              <GlassButton
                variant="ghost"
                size="sm"
                onClick={() => stage.mutate([])}
                disabled={stage.isPending}
              >
                Stage all
              </GlassButton>
            }
          >
            <DiffList
              files={unstaged}
              expanded={expandedPaths}
              onToggle={toggleExpanded}
              mode={diffMode}
              onModeChange={onDiffModeChange}
              onCopyPath={copyPath}
              onStage={handleStage}
              onDiscard={handleDiscard}
            />
          </Section>
        )}

        {partial.length > 0 && (
          <Section title="Partial" count={partial.length}>
            <DiffList
              files={partial}
              expanded={expandedPaths}
              onToggle={toggleExpanded}
              mode={diffMode}
              onModeChange={onDiffModeChange}
              onCopyPath={copyPath}
              onStage={handleStage}
              onUnstage={handleUnstage}
              onDiscard={handleDiscard}
            />
          </Section>
        )}
      </div>

      <div className="shrink-0 border-t border-(--color-border-subtle) p-3">
        {inMerge && (
          <MergeBanner
            kind={mergeKind === "rebase" ? "rebase" : "merge"}
            conflictCount={conflictCount}
            continuing={continueMerge.isPending}
            aborting={abortMerge.isPending}
            onContinue={() => {
              void continueMerge.mutateAsync().catch(() => {});
            }}
            onAbort={() => {
              void abortMerge.mutateAsync().catch(() => {});
            }}
            error={
              continueMerge.error
                ? humanizeError(continueMerge.error)
                : abortMerge.error
                  ? humanizeError(abortMerge.error)
                  : null
            }
          />
        )}
        {!inMerge && (
          <>
            <GlassTextarea
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                if (e.target.value.length > 0) setExpanded(true);
              }}
              onFocus={() => setExpanded(true)}
              onKeyDown={handleTextareaKeyDown}
              rows={expanded ? 5 : 2}
              placeholder="Commit message"
            />
            <div className="mt-2 flex items-center gap-1">
              <GlassButton
                variant="primary"
                size="sm"
                onClick={handleCommit}
                disabled={
                  commit.isPending || !message.trim() || stagedCount === 0
                }
                title={
                  stagedCount === 0
                    ? "Stage changes to commit"
                    : !message.trim()
                      ? "Enter a commit message to commit"
                      : `Commit (${COMMIT_SHORTCUT.display.join(" ")})`
                }
              >
                <Check size={12} />
                {commit.isPending ? "Committing…" : "Commit"}
                {stagedCount > 0 && ` (${stagedCount})`}
              </GlassButton>
              <GlassButton
                variant="outline"
                size="sm"
                onClick={() => {
                  void (async () => {
                    try {
                      await push.mutateAsync();
                      setLastPushAt(Date.now());
                    } catch {
                      /* surfaced below */
                    }
                  })();
                }}
                disabled={push.isPending || !canPush}
                className="ml-auto"
                title={
                  !branchStatus?.hasRemote
                    ? "No remote configured"
                    : branchStatus.detached
                      ? "Detached HEAD — checkout a branch to push"
                      : branchStatus.upstream === null
                        ? "Publish branch to origin"
                        : branchStatus.ahead === 0
                          ? "Nothing to push"
                          : `Push ${branchStatus.ahead} commit${branchStatus.ahead === 1 ? "" : "s"} (${COMMIT_AND_PUSH_SHORTCUT.display.join(" ")} commits then pushes)`
                }
              >
                <GitBranch size={12} />
                {push.isPending ? "Pushing…" : "Push"}
                {branchStatus &&
                  branchStatus.ahead > 0 &&
                  ` (${branchStatus.ahead})`}
              </GlassButton>
            </div>
            {commit.error && (
              <p className="mt-2 text-[11px] text-(--color-danger)">
                {humanizeError(commit.error)}
              </p>
            )}
            {push.error && (
              <p className="mt-2 text-[11px] text-(--color-danger)">
                {humanizeError(push.error)}
              </p>
            )}
            {showPushSuccess && (
              <p className="mt-2 text-[11px] text-(--color-success)">Pushed.</p>
            )}
            {showCommitSuccess && !showPushSuccess && (
              <p className="mt-2 text-[11px] text-(--color-success)">
                Committed.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MergeBanner({
  kind,
  conflictCount,
  continuing,
  aborting,
  onContinue,
  onAbort,
  error,
}: {
  kind: "merge" | "rebase";
  conflictCount: number;
  continuing: boolean;
  aborting: boolean;
  onContinue: () => void;
  onAbort: () => void;
  error: string | null;
}) {
  const resolved = conflictCount === 0;
  const label = kind === "rebase" ? "Rebase" : "Merge";
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 rounded-md border border-(--color-border-default) bg-(--color-bg-elevated) p-2.5">
        <AlertTriangle
          size={14}
          className={
            resolved
              ? "mt-0.5 text-(--color-success)"
              : "mt-0.5 text-(--color-warning)"
          }
        />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium text-(--color-text-primary)">
            {label} in progress
          </p>
          <p className="mt-0.5 text-[11px] text-(--color-text-muted)">
            {resolved
              ? "All conflicts resolved."
              : `${conflictCount} conflict${conflictCount === 1 ? "" : "s"} remaining.`}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {resolved && (
          <GlassButton
            variant="primary"
            size="sm"
            onClick={onContinue}
            disabled={continuing}
          >
            <Check size={12} />
            {continuing ? "Finishing…" : `Continue ${kind}`}
          </GlassButton>
        )}
        <GlassButton
          variant="outline"
          size="sm"
          onClick={onAbort}
          disabled={aborting}
          className={resolved ? "" : "ml-auto"}
        >
          {aborting ? "Aborting…" : `Abort ${kind}`}
        </GlassButton>
      </div>
      {error && <p className="text-[11px] text-(--color-danger)">{error}</p>}
    </div>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2 px-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-(--color-text-muted)">
            {title}
          </span>
          <span className="inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-(--color-bg-hover) px-1.5 text-[10.5px] font-medium tabular-nums leading-none text-(--color-text-muted)">
            {count}
          </span>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function bucketFor(f: { staged?: FileStatus; unstaged?: FileStatus }): Bucket {
  if (f.staged === "conflicted" || f.unstaged === "conflicted")
    return "conflicts";
  const hasStaged = f.staged !== undefined && f.staged !== "other";
  const hasUnstaged = f.unstaged !== undefined && f.unstaged !== "other";
  if (hasStaged && hasUnstaged) return "partial";
  if (hasStaged) return "staged";
  return "unstaged";
}

/** First `perSection` paths of each bucket — the initial auto-expanded set. */
function seedExpandedPaths(
  changes: FileChange[],
  perSection: number,
): Set<string> {
  const seen: Record<Bucket, number> = {
    conflicts: 0,
    staged: 0,
    unstaged: 0,
    partial: 0,
  };
  const out = new Set<string>();
  for (const c of changes) {
    const b = bucketFor(c);
    if (seen[b] < perSection) {
      out.add(c.path);
      seen[b] += 1;
    }
  }
  return out;
}

function useDiffFiles(
  workspaceId: string,
  changes: FileChange[],
  expandedPaths: Set<string>,
): DiffCardFile[] {
  const scopePerFile = useMemo<DiffScope[]>(
    () => changes.map((c) => pickScope(c)),
    [changes],
  );

  const results = useQueries({
    queries: changes.map((c, i) => ({
      queryKey: ["git", "diff", workspaceId, scopePerFile[i], c.path],
      queryFn: () =>
        tauri.gitDiff(workspaceId, scopePerFile[i] as DiffScope, c.path),
      // Fetch the raw diff ONLY for expanded cards. Collapsed cards render
      // their +N·-N badge from the numstat counts on the FileChange, so
      // they never hit the backend — the core of the watcher-storm fix.
      enabled: !!workspaceId && expandedPaths.has(c.path),
    })),
  });

  return useMemo(
    () =>
      changes.map((c, i) => {
        const r = results[i];
        const file: DiffCardFile = {
          path: c.path,
          raw: r?.data ?? null,
          loading: r?.isLoading ?? false,
          staged: c.staged,
          unstaged: c.unstaged,
          oldPath: c.oldPath,
          // Backend numstat counts drive the collapsed badge without a
          // fetch/parse. `null` = binary/untracked/unmerged.
          adds: c.adds,
          removes: c.removes,
        };
        if (r?.error) {
          file.errorMessage = String((r.error as Error).message ?? r.error);
        }
        return file;
      }),
    [changes, results],
  );
}

function pickScope(c: FileChange): DiffScope {
  if (c.unstaged === "untracked") return "Unstaged";
  if (c.unstaged === "other" && c.staged !== "other") return "Staged";
  return "Head";
}
