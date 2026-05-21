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
  Minus,
  Paperclip,
  Plus,
  Undo2,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { DiffView, type DiffViewMode } from "@/components/diff/DiffView";
import { parseUnifiedDiff, type ParsedDiff } from "@/lib/diff/parse";
import { GlassButton } from "@/components/ui/GlassButton";
import type { FileStatus as GitFileStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

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
  className?: string;
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "binary";

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
  className,
}: DiffCardProps) {
  const canStage = onStage && file.unstaged !== undefined && file.unstaged !== "other";
  const canUnstage = onUnstage && file.staged !== undefined && file.staged !== "other";
  const parsed = useMemo<ParsedDiff | null>(
    () => (file.raw === null ? null : parseUnifiedDiff(file.raw)),
    [file.raw],
  );
  const { adds, removes } = useMemo(() => countAddsRemoves(parsed), [parsed]);
  const status = inferStatus(parsed);

  const [copied, setCopied] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

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
        style={{ backgroundColor: edgeColorFor(status) }}
      />

      <header className="flex h-10 shrink-0 items-center gap-2 pl-3 pr-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse file" : "Expand file"}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 cursor-pointer truncate text-left text-[12.5px] font-medium text-(--color-text-primary)"
          title={file.path}
        >
          {file.path}
        </button>

        <button
          type="button"
          onClick={copyPath}
          aria-label="Copy file path"
          title="Copy file path"
          className="flex h-6 w-6 items-center justify-center rounded text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
        >
          {copied ? (
            <Check size={12} className="text-(--color-success)" />
          ) : (
            <Copy size={12} />
          )}
        </button>

        <CountsBadge adds={adds} removes={removes} status={status} />

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
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
            <IconButton label="Add comment" onClick={() => onComment(file.path)}>
              <Paperclip size={13} />
            </IconButton>
          )}
          {onDiscard && (
            <IconButton
              label="Discard changes"
              tone="danger"
              onClick={() => setConfirmDiscard(true)}
            >
              <Undo2 size={13} />
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
        onConfirm={() => {
          setConfirmDiscard(false);
          onDiscard?.(file.path);
        }}
        onCancel={() => setConfirmDiscard(false)}
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
        "flex h-7 w-7 items-center justify-center rounded hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
        tone === "success" && "text-(--color-success)",
        tone === "danger" && "text-(--color-danger)",
        !tone && "text-(--color-text-muted)",
      )}
    >
      {children}
    </button>
  );
}

function CountsBadge({
  adds,
  removes,
  status,
}: {
  adds: number;
  removes: number;
  status: FileStatus;
}) {
  if (status === "binary") {
    return (
      <span className="shrink-0 rounded bg-(--color-bg-elevated) px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-(--color-text-muted)">
        binary
      </span>
    );
  }
  if (adds === 0 && removes === 0) {
    return (
      <span className="shrink-0 rounded bg-(--color-bg-elevated) px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-(--color-text-muted)">
        empty
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1 rounded bg-(--color-bg-elevated) px-1.5 py-0.5 font-mono text-[11px]">
      <span className="text-(--color-success)">+{adds}</span>
      <span className="text-(--color-text-muted)">·</span>
      <span className="text-(--color-danger)">-{removes}</span>
    </span>
  );
}

function DiscardConfirm({
  open,
  path,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  path: string;
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
                  Discard changes?
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
                All changes to{" "}
                <code className="font-mono text-(--color-text-primary)">{path}</code>{" "}
                will be reset to HEAD. This cannot be undone.
              </div>
            </Dialog.Description>
            <footer className="flex justify-end gap-2 border-t border-(--glass-border-hairline) px-4 py-3">
              <GlassButton variant="outline" size="sm" onClick={onCancel}>
                Cancel
              </GlassButton>
              <GlassButton variant="danger" size="sm" onClick={onConfirm}>
                Discard
              </GlassButton>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
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
