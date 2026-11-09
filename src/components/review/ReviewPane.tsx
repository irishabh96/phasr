import { Check, ChevronDown, ChevronRight, Eye } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { DiffViewer } from "@/components/diff/DiffViewer";
import { DiffAnnotationsContext, type DiffAnnotations, type DiffViewMode } from "@/components/diff/DiffView";
import { CommentThread } from "@/components/review/CommentThread";
import {
  useCreateReviewComment,
  useDeleteReviewComment,
  useReviewComments,
  useReviewFiles,
  useUpdateReviewComment,
} from "@/lib/hooks/useReview";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { changeLetter } from "@/components/session/Inspector";
import { DiffCount } from "@/components/ui/Chip";
import { GroupHeader } from "@/components/ui/GroupHeader";
import { PanelState } from "@/components/ui/PanelState";
import { useGitLog, useGitStatus } from "@/lib/hooks/useGit";
import { useViewedFiles, viewedKey } from "@/lib/hooks/useViewedFiles";
import type { DiffScope, FileChange } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Files expanded on open; the rest load their diff when expanded. */
const SEED_OPEN = 10;

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}
function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Review a task's changes (A-Review): files grouped by folder with a viewed
 * count, the branch's commits, and every file's diff in one scroll. "Mark
 * viewed" folds a file away until the agent changes it again.
 *
 * `files`/`scope` default to the working tree vs HEAD; the review backend
 * swaps in the whole branch vs its base.
 */
export function ReviewPane({
  workspaceId,
  files: filesProp,
  scope = "Head",
  aside,
}: {
  workspaceId: string;
  files?: FileChange[] | undefined;
  scope?: DiffScope | "Base";
  /** Rendered under the commits (e.g. a commit box for local workspaces). */
  aside?: ReactNode;
}) {
  // The whole branch vs its base (committed work included) when the review
  // backend answers; the working tree vs HEAD otherwise.
  const review = useReviewFiles(filesProp ? null : workspaceId);
  const useBase = !filesProp && Array.isArray(review.data);
  const status = useGitStatus(filesProp || useBase ? null : workspaceId);
  const files = filesProp ?? (useBase ? review.data! : status.data);
  const diffScope: DiffScope | "Base" = useBase ? "Base" : scope;
  const { data: comments } = useReviewComments(workspaceId);
  const createComment = useCreateReviewComment(workspaceId);
  const updateComment = useUpdateReviewComment(workspaceId);
  const deleteComment = useDeleteReviewComment(workspaceId);
  const [draft, setDraft] = useState<{ path: string; line: number; side: "old" | "new"; anchor: string } | null>(null);
  const annotationsFor = (path: string): DiffAnnotations => ({
    onComment: (line, side) =>
      setDraft({ path, line: (side === "old" ? line.oldLine : line.newLine) ?? 0, side, anchor: line.content }),
    renderAfter: (line, side) => {
      const n = side === "old" ? line.oldLine : line.newLine;
      if (n == null) return null;
      const here = (comments ?? []).filter((c) => c.path === path && c.line === n && c.side === side);
      const composing = draft && draft.path === path && draft.line === n && draft.side === side;
      if (here.length === 0 && !composing) return null;
      return (
        <CommentThread
          comments={here}
          composing={!!composing}
          busy={createComment.isPending}
          onCancel={() => setDraft(null)}
          onSubmit={(body) =>
            createComment.mutate(
              { path, line: n, side, anchorText: draft?.anchor ?? line.content, body },
              {
                onSuccess: () => setDraft(null),
                onError: (err) => showToast({ intent: "error", title: "Couldn't save the comment", message: humanizeError(err) }),
              },
            )
          }
          onResolve={(id) => updateComment.mutate({ id, input: { status: "resolved" } })}
          onDelete={(id) => deleteComment.mutate(id)}
        />
      );
    },
  });
  const { viewed, toggle } = useViewedFiles(workspaceId);
  const listRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<DiffViewMode>(() => {
    try {
      return localStorage.getItem("phasr.diff.mode") === "inline" ? "inline" : "side-by-side";
    } catch {
      return "side-by-side";
    }
  });
  const pickMode = (m: DiffViewMode) => {
    setMode(m);
    try {
      localStorage.setItem("phasr.diff.mode", m);
    } catch {
      /* ignore */
    }
  };

  const groups = useMemo(() => {
    const byDir = new Map<string, FileChange[]>();
    for (const f of files ?? []) {
      const d = dirOf(f.path);
      byDir.set(d, [...(byDir.get(d) ?? []), f]);
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [files]);
  const viewedCount = (files ?? []).filter((f) => viewed.has(viewedKey(f.path, f.adds, f.removes))).length;

  const [active, setActive] = useState<string | null>(null);
  const jump = (path: string) => {
    setActive(path);
    // Jumping to a file past the seeded ones expands it.
    const i = (files ?? []).findIndex((f) => f.path === path);
    if (i >= SEED_OPEN) setCollapsed((prev) => new Set(prev).add(path));
    const el = listRef.current?.querySelector<HTMLElement>(`[data-review-file="${CSS.escape(path)}"]`);
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  if ((status.isLoading || review.isLoading) && !files) return <PanelState kind="loading" rows={6} className="p-4" />;
  if (status.isError && !files)
    return <PanelState kind="error" title="Couldn't read the changes" error={status.error} onRetry={() => void status.refetch()} />;

  const total = files?.length ?? 0;
  return (
    <div className="grid h-full min-h-0 grid-cols-[240px_minmax(0,1fr)]">
      {/* The file tree keeps its structural divider (it reads like the
          sidebar edge); everything else separates by tone (A-Polish 01). */}
      <nav aria-label="Changed files" className="flex min-h-0 flex-col overflow-y-auto border-r border-(--color-border-subtle) bg-(--color-bg-sidebar)">
        <GroupHeader
          as="h2"
          count={total}
          className="px-3 pb-1.5 pt-2.5"
          action={<span className="text-[12px] tabular-nums text-(--color-text-muted)">{viewedCount} viewed</span>}
        >
          Files
        </GroupHeader>
        <div
          role="progressbar"
          aria-label="Files viewed"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={viewedCount}
          className="mx-3 mb-2 h-[3px] shrink-0 overflow-hidden rounded-full bg-(--color-bg-elevated)"
        >
          <div
            className="h-full rounded-full bg-(--color-success) transition-[width] duration-(--dur-2) ease-(--ease-out)"
            style={{ width: total ? `${Math.round((viewedCount / total) * 100)}%` : 0 }}
          />
        </div>
        <div className="flex flex-col gap-px px-1.5 pb-3">
          {groups.map(([dir, items]) => (
            <div key={dir} className="flex flex-col gap-px">
              {dir ? <span className="truncate px-2 pb-0.5 pt-1.5 text-[12px] text-(--color-text-muted)">{dir}</span> : null}
              {items.map((f) => {
                const { letter, color } = changeLetter(f);
                const isViewed = viewed.has(viewedKey(f.path, f.adds, f.removes));
                const isActive = active === f.path;
                return (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => jump(f.path)}
                    aria-current={isActive ? "true" : undefined}
                    title={f.path}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-2 rounded-(--radius-control) pl-3.5 pr-2 text-left font-mono text-[11.5px]",
                      "transition-colors duration-(--dur-1) ease-(--ease-out)",
                      "focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)",
                      // Selected = a background step, never an outline.
                      isActive
                        ? "bg-(--color-bg-elevated) text-(--color-text-primary)"
                        : "hover:bg-(--color-bg-elevated)/60",
                      !isActive && (isViewed ? "text-(--color-text-muted)" : "text-(--color-text-secondary)"),
                    )}
                  >
                    <span className="w-2.5 shrink-0 text-[11px]" style={{ color }}>
                      {letter}
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate", isViewed && "line-through decoration-(--color-text-faint)")}>
                      {baseName(f.path)}
                    </span>
                    {isViewed ? <Check className="size-3 shrink-0 text-(--color-success)" aria-label="viewed" /> : null}
                    <DiffCount adds={f.adds ?? 0} removes={f.removes ?? 0} hideRemovesWhenZero />
                  </button>
                );
              })}
            </div>
          ))}
          {files && files.length === 0 ? (
            <p className="m-0 px-2 text-[12px] text-(--color-text-muted)">No changes.</p>
          ) : null}
        </div>
        <Commits workspaceId={workspaceId} />
        {aside}
      </nav>

      <div ref={listRef} className="flex min-h-0 flex-col overflow-y-auto pb-6">
        <div className="flex h-10 shrink-0 items-center justify-end px-4">
          <SegmentedControl
            label="Diff layout"
            value={mode}
            onChange={pickMode}
            options={[
              { value: "inline", label: "Unified" },
              { value: "side-by-side", label: "Split" },
            ]}
          />
        </div>
        {(files ?? []).map((f, index) => {
          const key = viewedKey(f.path, f.adds, f.removes);
          const isViewed = viewed.has(key);
          // Only the first SEED_OPEN files start expanded (each expanded card
          // fetches its diff — a 200-file change must not fire 200 diffs).
          // `collapsed` holds the files whose state the user flipped.
          const defaultOpen = !isViewed && index < SEED_OPEN;
          const open = collapsed.has(f.path) ? !defaultOpen : defaultOpen;
          const flip = () =>
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(f.path)) next.delete(f.path);
              else next.add(f.path);
              return next;
            });
          const { letter, color } = changeLetter(f);
          return (
            // One continuous scroll (A-Review): each file is a sticky header
            // bar on the surface step over its diff, files spaced apart; no
            // boxes or rules between them.
            <section key={f.path} data-review-file={f.path} aria-label={f.path} className="flex flex-col [&+&]:mt-3">
              <header className="sticky top-0 z-[2] flex h-[34px] shrink-0 items-center gap-2 bg-(--color-bg-surface) pl-2 pr-3">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={open ? `Collapse ${f.path}` : `Expand ${f.path}`}
                  onClick={flip}
                  className="grid size-6 place-items-center rounded-(--radius-control) text-(--color-text-muted) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
                >
                  {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
                </button>
                <span className="font-mono text-[12px]" style={{ color }}>
                  {letter}
                </span>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={flip}
                  className="min-w-0 flex-1 truncate text-left font-mono text-[12px] text-(--color-text-primary) focus-visible:outline-none"
                >
                  {f.path}
                </button>
                <DiffCount adds={f.adds ?? 0} removes={f.removes ?? 0} className="text-[12px]" />
                <button
                  type="button"
                  aria-pressed={isViewed}
                  onClick={() => toggle(key)}
                  className={cn(
                    "ml-1 flex h-6 items-center gap-1.5 rounded-(--radius-control) px-2 text-[12px]",
                    "transition-colors duration-(--dur-1) ease-(--ease-out)",
                    "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
                    isViewed
                      ? "text-(--color-success) hover:bg-(--color-bg-elevated)"
                      : "text-(--color-text-secondary) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
                  )}
                >
                  {isViewed ? <Check className="size-3" aria-hidden /> : <Eye className="size-3" aria-hidden />}
                  {isViewed ? "Viewed" : "Mark viewed"}
                </button>
              </header>
              {open ? (
                <DiffAnnotationsContext.Provider value={annotationsFor(f.path)}>
                  <DiffViewer
                    workspaceId={workspaceId}
                    scope={diffScope as DiffScope}
                    filePath={f.path}
                    className="h-auto"
                    noHeader
                    mode={mode}
                    onModeChange={pickMode}
                  />
                </DiffAnnotationsContext.Provider>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Commits({ workspaceId }: { workspaceId: string }) {
  const log = useGitLog(workspaceId, { branchOnly: true });
  const commits = log.data?.pages.flat() ?? [];
  if (commits.length === 0) return null;
  return (
    <section aria-label="Commits" className="mt-auto flex flex-col gap-0.5 px-1.5 pb-3 pt-4">
      <GroupHeader as="h2" count={commits.length} className="px-2 pb-1">
        Commits
      </GroupHeader>
      {commits.slice(0, 20).map((c) => (
        <div key={c.sha} className="flex h-6 items-center gap-2 px-2 text-[12px]" title={c.subject}>
          <span className="shrink-0 font-mono text-[11px] text-(--color-text-faint)">{c.shortSha}</span>
          <span className="min-w-0 truncate text-(--color-text-secondary)">{c.subject}</span>
        </div>
      ))}
    </section>
  );
}
