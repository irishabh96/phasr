/**
 * Collapsible per-file diff card used by DiffList. Renders the file
 * header chrome (chevron, path, copy, +N·-N badge, action icons) plus a
 * colored edge bar inferred from the diff's status. Body is a nested
 * DiffView with its own header suppressed, controlled by the parent
 * list so ⌘\ toggles every card in sync.
 */

import * as Dialog from "@radix-ui/react-dialog";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  GitBranch,
  GitMerge,
  Minus,
  Paperclip,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { DiffView, Pill, type DiffViewMode } from "@/components/diff/DiffView";
import { parseUnifiedDiff, type ParsedDiff } from "@/lib/diff/parse";
import { GlassButton } from "@/components/ui/GlassButton";
import type { FileStatus as GitFileStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

/** One resolve action for a conflicted file. The parent computes the
 *  git side + human labels per merge vs rebase (git inverts ours/theirs
 *  during a rebase), so this component stays presentational. */
export interface ConflictAction {
  /** Icon-button tooltip / aria-label. */
  label: string;
  /** Confirmation dialog title. */
  confirmTitle: string;
  /** Confirmation dialog body — states exactly what is kept/discarded. */
  confirmBody: string;
  /** Confirmation dialog primary-button text. */
  confirmLabel: string;
  onResolve: (path: string) => void;
}

export interface ConflictActions {
  /** Keep the workspace branch's version of the file. */
  keepMine: ConflictAction;
  /** Take the other branch's version (incoming / rebase base). */
  useOther: ConflictAction;
}

export interface DiffCardFile {
  path: string;
  raw: string | null;
  loading?: boolean;
  errorMessage?: string;
  /**
   * Per-side git status used to decide whether stage/unstage actions
   * apply. When omitted, those icons are hidden even if their callbacks
   * are wired.
   */
  staged?: GitFileStatus;
  unstaged?: GitFileStatus;
  /**
   * Original path for a rename. Lets a collapsed card render the
   * "old → new" header without parsing the diff. Standalone callers
   * (who only have `raw`) omit it and the header derives it from parse.
   */
  oldPath?: string | null;
  /**
   * Lines added / removed for this file, straight from git's numstat
   * (see `FileChange.adds`). When present, the collapsed card renders its
   * +N·-N badge from these WITHOUT fetching or parsing the diff — the
   * whole point of the watcher-storm fix. `null` means binary / untracked
   * / unmerged (no numstat entry). Omit the fields entirely (standalone
   * use — /design-test and the diff preview pass `{path, raw}`) to derive
   * the badge from `raw` instead.
   */
  adds?: number | null;
  removes?: number | null;
}

export interface DiffCardProps {
  file: DiffCardFile;
  expanded: boolean;
  onToggle: () => void;
  /** Shared view mode owned by DiffList. */
  mode: DiffViewMode;
  onModeChange: (m: DiffViewMode) => void;
  /** Action callbacks. Omit to hide the corresponding icon. */
  onCopyPath?: (path: string) => void;
  onComment?: (path: string) => void;
  onDiscard?: (path: string) => void;
  onOpen?: (path: string) => void;
  /** Stage this file. Shown only when `file.unstaged !== "other"`. */
  onStage?: (path: string) => void;
  /** Unstage this file. Shown only when `file.staged !== "other"`. */
  onUnstage?: (path: string) => void;
  /**
   * Resolve a merge/rebase conflict by picking one side. Shown ONLY when
   * the file is currently conflicted; replaces the stage/unstage trio.
   * Each pick opens a confirmation (it's irreversible). The parent maps
   * "keep mine"/"use other" to the correct git side per merge vs rebase.
   */
  conflict?: ConflictActions;
  className?: string;
}

export type FileStatus =
  | "added"
  | "deleted"
  | "modified"
  | "renamed"
  | "binary";

export function DiffCard({
  file,
  expanded,
  onToggle,
  mode,
  onModeChange,
  onCopyPath,
  onComment,
  onDiscard,
  onOpen,
  onStage,
  onUnstage,
  conflict,
  className,
}: DiffCardProps) {
  const isConflicted =
    file.staged === "conflicted" || file.unstaged === "conflicted";
  const canStage =
    !isConflicted &&
    onStage &&
    file.unstaged !== undefined &&
    file.unstaged !== "other";
  const canUnstage =
    !isConflicted &&
    onUnstage &&
    file.staged !== undefined &&
    file.staged !== "other";
  // When the backend supplies numstat counts we render the badge, status
  // pill, edge colour and rename header straight from git — a COLLAPSED
  // card never parses (or fetches) its diff. We only fall back to parsing
  // `raw` when no counts were supplied (standalone use: /design-test and
  // the diff preview pass `{path, raw}` with no counts).
  const hasCounts = file.adds !== undefined || file.removes !== undefined;
  const untracked =
    file.unstaged === "untracked" || file.staged === "untracked";
  const derived = useMemo(() => {
    if (hasCounts) {
      return {
        adds: file.adds ?? null,
        removes: file.removes ?? null,
        status: statusFromGit(file.staged, file.unstaged),
        oldPath: file.oldPath ?? null,
        newPath: file.path,
      };
    }
    const parsed: ParsedDiff | null = file.raw
      ? parseUnifiedDiff(file.raw)
      : null;
    const counts = countAddsRemoves(parsed);
    return {
      adds: parsed ? counts.adds : null,
      removes: parsed ? counts.removes : null,
      status: inferStatus(parsed),
      oldPath: parsed?.oldPath ?? null,
      newPath: parsed?.newPath ?? null,
    };
  }, [
    hasCounts,
    file.adds,
    file.removes,
    file.staged,
    file.unstaged,
    file.oldPath,
    file.path,
    file.raw,
  ]);
  const { adds, removes, status } = derived;
  const hasError = !!file.errorMessage;
  const renameLabel =
    status === "renamed" &&
    derived.oldPath &&
    derived.newPath &&
    derived.oldPath !== derived.newPath
      ? `${derived.oldPath} → ${derived.newPath}`
      : null;
  const pathLabel = renameLabel ?? file.path;

  const [copied, setCopied] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [resolveAction, setResolveAction] = useState<ConflictAction | null>(
    null,
  );

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked — ignore */
    }
    onCopyPath?.(file.path);
  };

  return (
    <article
      className={cn(
        "relative overflow-hidden rounded-md border border-(--color-border-default)",
        "bg-(--color-bg-surface)",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-0 top-0 w-[3px]"
        style={{
          backgroundColor: hasError
            ? "var(--color-danger)"
            : !hasCounts && file.loading
              ? "var(--color-border-default)"
              : edgeColorFor(status),
        }}
      />

      <header className="flex h-10 shrink-0 items-center gap-2 pl-3 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse file" : "Expand file"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 cursor-pointer truncate rounded text-left text-[12.5px] font-medium text-(--color-text-primary) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
          title={pathLabel}
        >
          {renameLabel ? (
            <>
              <span className="text-(--color-text-muted)">
                {derived.oldPath} →{" "}
              </span>
              {derived.newPath}
            </>
          ) : (
            file.path
          )}
        </button>

        {!hasError && (hasCounts || !file.loading) && (
          <StatusPill status={status} />
        )}

        <button
          type="button"
          onClick={copyPath}
          aria-label="Copy file path"
          title="Copy file path"
          className="flex h-8 w-8 items-center justify-center rounded text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
        >
          {copied ? (
            <Check size={12} className="text-(--color-success)" />
          ) : (
            <Copy size={12} />
          )}
        </button>

        {hasError ? (
          <span
            title={file.errorMessage}
            className="shrink-0 rounded bg-[color-mix(in_oklab,var(--color-danger)_15%,transparent)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-(--color-danger)"
          >
            error
          </span>
        ) : !hasCounts && file.loading ? (
          <span
            aria-hidden
            className="h-3.5 w-9 shrink-0 animate-pulse rounded bg-(--color-bg-elevated)"
          />
        ) : (
          <CountsBadge
            adds={adds}
            removes={removes}
            status={status}
            untracked={untracked}
            conflicted={isConflicted}
          />
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {isConflicted && conflict && (
            <>
              <IconButton
                label={conflict.keepMine.label}
                onClick={() => setResolveAction(conflict.keepMine)}
              >
                <GitBranch size={13} />
              </IconButton>
              <IconButton
                label={conflict.useOther.label}
                onClick={() => setResolveAction(conflict.useOther)}
              >
                <GitMerge size={13} />
              </IconButton>
            </>
          )}
          {canStage && (
            <IconButton
              label="Stage file"
              tone="success"
              onClick={() => onStage(file.path)}
            >
              <Plus size={13} />
            </IconButton>
          )}
          {canUnstage && (
            <IconButton
              label="Unstage file"
              onClick={() => onUnstage(file.path)}
            >
              <Minus size={13} />
            </IconButton>
          )}
          {onComment && (
            <IconButton
              label="Add comment"
              onClick={() => onComment(file.path)}
            >
              <Paperclip size={13} />
            </IconButton>
          )}
          {!isConflicted && onDiscard && (
            <IconButton
              label={
                file.unstaged === "untracked"
                  ? "Delete untracked file"
                  : "Discard changes"
              }
              tone="danger"
              onClick={() => setConfirmDiscard(true)}
            >
              {file.unstaged === "untracked" ? (
                <Trash2 size={13} />
              ) : (
                <RotateCcw size={13} />
              )}
            </IconButton>
          )}
          {onOpen && (
            <IconButton label="Open file" onClick={() => onOpen(file.path)}>
              <ExternalLink size={13} />
            </IconButton>
          )}
        </div>
      </header>

      {expanded && (
        <div className="border-t border-(--color-border-subtle)">
          <DiffView
            raw={file.raw}
            filePath={file.path}
            {...(file.loading !== undefined ? { loading: file.loading } : {})}
            {...(file.errorMessage !== undefined
              ? { errorMessage: file.errorMessage }
              : {})}
            mode={mode}
            onModeChange={onModeChange}
            noHeader
            className="max-h-[600px]"
          />
        </div>
      )}

      <DiscardConfirm
        open={confirmDiscard}
        path={file.path}
        untracked={file.unstaged === "untracked"}
        onConfirm={() => {
          setConfirmDiscard(false);
          onDiscard?.(file.path);
        }}
        onCancel={() => setConfirmDiscard(false)}
      />

      <ResolveConfirm
        action={resolveAction}
        path={file.path}
        onConfirm={() => {
          const action = resolveAction;
          setResolveAction(null);
          action?.onResolve(file.path);
        }}
        onCancel={() => setResolveAction(null)}
      />
    </article>
  );
}

function IconButton({
  label,
  onClick,
  children,
  tone,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  tone?: "success" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none",
        tone === "success" && "text-(--color-success)",
        tone === "danger" && "text-(--color-danger)",
        !tone && "text-(--color-text-muted)",
      )}
    >
      {children}
    </button>
  );
}

/** Status chip mirroring DiffView's header pills. `modified`/`binary`
 *  render nothing here — modified is the default, binary is covered by
 *  CountsBadge. */
function StatusPill({ status }: { status: FileStatus }) {
  switch (status) {
    case "added":
      return <Pill tone="success">new</Pill>;
    case "deleted":
      return <Pill tone="danger">deleted</Pill>;
    case "renamed":
      return <Pill tone="info">renamed</Pill>;
    default:
      return null;
  }
}

function CountsBadge({
  adds,
  removes,
  status,
  untracked,
  conflicted,
}: {
  adds: number | null;
  removes: number | null;
  status: FileStatus;
  untracked?: boolean;
  conflicted?: boolean;
}) {
  // No numeric line counts. Either a binary diff (detected via parse in
  // standalone mode → status "binary") or the backend reported null counts
  // (git numstat has no entry for binary, untracked or unmerged files).
  // Untracked files already carry a "new" status pill and conflicted files
  // live in the Conflicts section, so we skip a redundant badge for those;
  // any other count-less file is binary.
  if (status === "binary" || adds === null || removes === null) {
    if (untracked || conflicted) return null;
    return (
      <span
        aria-label="Binary file"
        className="shrink-0 rounded bg-(--color-bg-elevated) px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-(--color-text-muted)"
      >
        binary
      </span>
    );
  }
  if (adds === 0 && removes === 0) {
    return (
      <span
        aria-label="No line changes"
        className="shrink-0 rounded bg-(--color-bg-elevated) px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-(--color-text-muted)"
      >
        empty
      </span>
    );
  }
  return (
    <span
      aria-label={`${adds} addition${adds === 1 ? "" : "s"}, ${removes} deletion${
        removes === 1 ? "" : "s"
      }`}
      className="flex shrink-0 items-center gap-1 rounded bg-(--color-bg-elevated) px-1.5 py-0.5 font-mono text-[11px]"
    >
      <span aria-hidden="true" className="text-(--diff-add-fg)">
        +{adds}
      </span>
      <span aria-hidden="true" className="text-(--color-text-muted)">
        ·
      </span>
      <span aria-hidden="true" className="text-(--diff-remove-fg)">
        -{removes}
      </span>
    </span>
  );
}

function DiscardConfirm({
  open,
  path,
  untracked,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  path: string;
  /** Untracked files have no HEAD — discarding DELETES them from disk. */
  untracked?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[180] bg-(--color-bg-overlay) backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[30vh] z-[190] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal overflow-hidden">
            <header className="flex h-11 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
              <Dialog.Title asChild>
                <h2 className="text-[13.5px] font-semibold leading-none">
                  {untracked ? "Delete untracked file?" : "Discard changes?"}
                </h2>
              </Dialog.Title>
              <div className="ml-auto">
                <GlassButton
                  variant="ghost"
                  size="icon"
                  onClick={onCancel}
                  className="h-7 w-7"
                  title="Close"
                >
                  <X size={13} />
                </GlassButton>
              </div>
            </header>
            <Dialog.Description asChild>
              <div className="px-4 py-3 text-[13px] text-(--color-text-secondary)">
                <code className="font-mono text-(--color-text-primary)">
                  {path}
                </code>{" "}
                {untracked
                  ? "isn't tracked by git — discarding permanently deletes it from disk. This cannot be undone."
                  : "will be reset to HEAD, discarding all changes. This cannot be undone."}
              </div>
            </Dialog.Description>
            <footer className="flex justify-end gap-2 border-t border-(--glass-border-hairline) px-4 py-3">
              <GlassButton variant="outline" size="sm" onClick={onCancel}>
                Cancel
              </GlassButton>
              <GlassButton variant="danger" size="sm" onClick={onConfirm}>
                {untracked ? "Delete file" : "Discard"}
              </GlassButton>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Confirms an irreversible conflict side-pick, spelling out in plain
 *  language which side is kept and which is discarded. */
function ResolveConfirm({
  action,
  path,
  onConfirm,
  onCancel,
}: {
  action: ConflictAction | null;
  path: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const basename = path.split("/").pop() || path;
  return (
    <Dialog.Root open={action !== null} onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[180] bg-(--color-bg-overlay) backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[30vh] z-[190] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 outline-none">
          <div className="glass-modal overflow-hidden">
            <header className="flex h-11 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
              <Dialog.Title asChild>
                <h2 className="text-[13.5px] font-semibold leading-none">
                  {action?.confirmTitle ?? ""}
                </h2>
              </Dialog.Title>
              <div className="ml-auto">
                <GlassButton
                  variant="ghost"
                  size="icon"
                  onClick={onCancel}
                  className="h-7 w-7"
                  title="Close"
                >
                  <X size={13} />
                </GlassButton>
              </div>
            </header>
            <Dialog.Description asChild>
              <div className="px-4 py-3 text-[13px] text-(--color-text-secondary)">
                <code className="font-mono text-(--color-text-primary)">
                  {basename}
                </code>{" "}
                — {action?.confirmBody}
              </div>
            </Dialog.Description>
            <footer className="flex justify-end gap-2 border-t border-(--glass-border-hairline) px-4 py-3">
              <GlassButton variant="outline" size="sm" onClick={onCancel}>
                Cancel
              </GlassButton>
              <GlassButton variant="primary" size="sm" onClick={onConfirm}>
                {action?.confirmLabel ?? "Resolve"}
              </GlassButton>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Visual status for a collapsed card, derived from git's per-side status
 * WITHOUT parsing the diff. Binary is intentionally never returned here —
 * we can't tell binary from text without the diff body, so binary is
 * inferred from null numstat counts by CountsBadge instead.
 */
function statusFromGit(
  staged?: GitFileStatus,
  unstaged?: GitFileStatus,
): FileStatus {
  if (staged === "renamed" || unstaged === "renamed") return "renamed";
  if (
    staged === "added" ||
    unstaged === "added" ||
    staged === "untracked" ||
    unstaged === "untracked"
  ) {
    return "added";
  }
  if (staged === "deleted" || unstaged === "deleted") return "deleted";
  return "modified";
}

function inferStatus(parsed: ParsedDiff | null): FileStatus {
  if (!parsed) return "modified";
  if (parsed.isNewFile) return "added";
  if (parsed.isDeletedFile) return "deleted";
  if (parsed.isBinary) return "binary";
  if (parsed.isRename) return "renamed";
  return "modified";
}

function edgeColorFor(status: FileStatus): string {
  switch (status) {
    case "added":
      return "var(--color-success)";
    case "deleted":
      return "var(--color-danger)";
    case "modified":
    case "renamed":
    case "binary":
      return "var(--color-info)";
  }
}

function countAddsRemoves(parsed: ParsedDiff | null): {
  adds: number;
  removes: number;
} {
  if (!parsed) return { adds: 0, removes: 0 };
  let adds = 0;
  let removes = 0;
  for (const h of parsed.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add") adds += 1;
      else if (l.kind === "remove") removes += 1;
    }
  }
  return { adds, removes };
}
