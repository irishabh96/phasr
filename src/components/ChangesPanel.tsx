import { useQueries } from "@tanstack/react-query";
import { Check, GitBranch } from "lucide-react";
import { useMemo, useState } from "react";
import { DiffList } from "@/components/diff/DiffList";
import type { DiffCardFile } from "@/components/diff/DiffCard";
import {
  useGitCommit,
  useGitDiscard,
  useGitPush,
  useGitStage,
  useGitStatus,
  useGitUnstage,
} from "@/lib/hooks/useGit";
import { tauri } from "@/lib/tauri";
import type { DiffScope, FileChange } from "@/lib/types";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTextarea } from "@/components/ui/GlassInput";

interface ChangesPanelProps {
  workspaceId: string;
}

type Bucket = "staged" | "unstaged" | "partial";

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
  const stage = useGitStage(workspaceId);
  const unstage = useGitUnstage(workspaceId);
  const discard = useGitDiscard(workspaceId);
  const commit = useGitCommit(workspaceId);
  const push = useGitPush(workspaceId);

  const [message, setMessage] = useState("");

  const allFiles = useDiffFiles(workspaceId, changes ?? []);

  const { staged, unstaged, partial } = useMemo(() => {
    const groups: Record<Bucket, DiffCardFile[]> = {
      staged: [],
      unstaged: [],
      partial: [],
    };
    for (const f of allFiles) groups[bucketFor(f)].push(f);
    return groups;
  }, [allFiles]);

  const stagedCount = staged.length + partial.length;

  const copyPath = (p: string) => {
    void navigator.clipboard?.writeText(p);
  };
  const handleStage = (p: string) => stage.mutate([p]);
  const handleUnstage = (p: string) => unstage.mutate([p]);
  const handleDiscard = (p: string) => discard.mutate([p]);

  const handleCommit = async () => {
    if (!message.trim() || stagedCount === 0) return;
    await commit.mutateAsync(message.trim());
    setMessage("");
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
        {(changes ?? []).length === 0 && (
          <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
            No changes in this worktree yet.
          </div>
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
        <GlassTextarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          placeholder="Commit message"
        />
        <div className="mt-2 flex items-center gap-1">
          <GlassButton
            variant="primary"
            size="sm"
            onClick={handleCommit}
            disabled={commit.isPending || !message.trim() || stagedCount === 0}
          >
            <Check size={12} />
            Commit {stagedCount > 0 && `(${stagedCount})`}
          </GlassButton>
          <GlassButton
            variant="outline"
            size="sm"
            onClick={() => push.mutate()}
            disabled={push.isPending}
            className="ml-auto"
          >
            <GitBranch size={12} />
            {push.isPending ? "Pushing…" : "Push"}
          </GlassButton>
        </div>
        {push.error && (
          <p className="mt-2 text-[11px] text-(--color-danger)">{String(push.error)}</p>
        )}
        {push.isSuccess && (
          <p className="mt-2 text-[11px] text-(--color-success)">Pushed.</p>
        )}
      </div>
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
