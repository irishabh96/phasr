import { useQueries } from "@tanstack/react-query";
import { AlertTriangle, Check, GitBranch } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { DiffList } from "@/components/diff/DiffList";
import type { DiffCardFile } from "@/components/diff/DiffCard";
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
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { tauri } from "@/lib/tauri";
import type { DiffScope, FileChange } from "@/lib/types";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";

const COMMIT_SHORTCUT = SHORTCUTS.submitForm;
const COMMIT_AND_PUSH_SHORTCUT = SHORTCUTS.commitAndPush;
const SUCCESS_FADE_MS = 4_000;

interface ChangesPanelProps {
  workspaceId: string;
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
export function ChangesPanel({ workspaceId }: ChangesPanelProps) {
  const { data: changes } = useGitStatus(workspaceId);
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

  const allFiles = useDiffFiles(workspaceId, changes ?? []);

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
  const canPush =
    !!branchStatus &&
    branchStatus.hasRemote &&
    !branchStatus.detached &&
    branchStatus.ahead > 0;

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
  const handleUseOurs = (p: string) =>
    resolveConflict.mutate({ path: p, side: "ours" });
  const handleUseTheirs = (p: string) =>
    resolveConflict.mutate({ path: p, side: "theirs" });

  const handleCommit = async () => {
    if (!message.trim() || stagedCount === 0) return;
    await commit.mutateAsync(message.trim());
    setMessage("");
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

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-(--color-border-subtle) px-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-(--color-text-muted)">
          Changes{" "}
          <span className="text-(--color-text-secondary)">{changes?.length ?? 0}</span>
        </span>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-2">
        {(changes ?? []).length === 0 && !inMerge && (
          <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
            No changes in this worktree yet.
          </div>
        )}

        {conflicts.length > 0 && (
          <Section
            title={mergeKind === "rebase" ? "Conflicts (rebase)" : "Conflicts"}
            count={conflicts.length}
          >
            <DiffList
              files={conflicts}
              defaultExpanded={10}
              onCopyPath={copyPath}
              onUseOurs={handleUseOurs}
              onUseTheirs={handleUseTheirs}
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
              defaultExpanded={10}
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
              defaultExpanded={10}
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
              defaultExpanded={10}
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
                ? extractMessage(continueMerge.error)
                : abortMerge.error
                  ? extractMessage(abortMerge.error)
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
            disabled={commit.isPending || !message.trim() || stagedCount === 0}
            title={`Commit (${COMMIT_SHORTCUT.display.join(" ")})`}
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
                  : branchStatus.ahead === 0
                    ? "Nothing to push"
                    : `Push ${branchStatus.ahead} commit${branchStatus.ahead === 1 ? "" : "s"} (${COMMIT_AND_PUSH_SHORTCUT.display.join(" ")} commits then pushes)`
            }
          >
            <GitBranch size={12} />
            {push.isPending ? "Pushing…" : "Push"}
            {branchStatus && branchStatus.ahead > 0 && ` (${branchStatus.ahead})`}
          </GlassButton>
        </div>
        {commit.error && (
          <p className="mt-2 text-[11px] text-(--color-danger)">
            {extractMessage(commit.error)}
          </p>
        )}
        {push.error && (
          <p className="mt-2 text-[11px] text-(--color-danger)">
            {extractMessage(push.error)}
          </p>
        )}
        {showPushSuccess && (
          <p className="mt-2 text-[11px] text-(--color-success)">Pushed.</p>
        )}
        {showCommitSuccess && !showPushSuccess && (
          <p className="mt-2 text-[11px] text-(--color-success)">Committed.</p>
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
            resolved ? "mt-0.5 text-(--color-success)" : "mt-0.5 text-(--color-warning)"
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

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
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
      <header className="flex items-center justify-between px-1">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.12em] text-(--color-text-muted)">
          {title}{" "}
          <span className="text-(--color-text-secondary)">{count}</span>
        </span>
        {action}
      </header>
      {children}
    </section>
  );
}

function bucketFor(f: DiffCardFile): Bucket {
  if (f.staged === "conflicted" || f.unstaged === "conflicted") return "conflicts";
  const hasStaged = f.staged !== undefined && f.staged !== "other";
  const hasUnstaged = f.unstaged !== undefined && f.unstaged !== "other";
  if (hasStaged && hasUnstaged) return "partial";
  if (hasStaged) return "staged";
  return "unstaged";
}

function useDiffFiles(workspaceId: string, changes: FileChange[]): DiffCardFile[] {
  const scopePerFile = useMemo<DiffScope[]>(
    () => changes.map((c) => pickScope(c)),
    [changes],
  );

  const results = useQueries({
    queries: changes.map((c, i) => ({
      queryKey: ["git", "diff", workspaceId, scopePerFile[i], c.path],
      queryFn: () => tauri.gitDiff(workspaceId, scopePerFile[i] as DiffScope, c.path),
      enabled: !!workspaceId,
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
