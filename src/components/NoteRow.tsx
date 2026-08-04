import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  FolderGit2,
  MoreHorizontal,
  SquareChevronRight,
  Terminal as TerminalIcon,
  Zap,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { humanizeError } from "@/lib/humanizeError";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { formatAbsolute, formatNoteStamp } from "@/lib/time";
import type { Note } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A first line longer than this is a paragraph, not a title. */
const TITLE_MAX = 120;

function OriginIcon({ kind }: { kind: Note["originKind"] }) {
  const cls = "shrink-0 text-(--color-text-muted)";
  switch (kind) {
    case "workspace":
      return <Zap size={11} className={cls} />;
    case "terminal":
      return <TerminalIcon size={11} className={cls} />;
    case "runCommand":
      return <SquareChevronRight size={11} className={cls} />;
    case "repository":
      return <FolderGit2 size={11} className={cls} />;
  }
}

export interface NoteRowProps {
  note: Note;
  /** Whether the origin workspace still exists (live-resolved by the panel). */
  originWorkspaceAlive: boolean;
  /** Roving tabindex: the one row that is in the tab order. */
  focusable: boolean;
  onFocusRow: () => void;
  onSave: (body: string, expectedUpdatedAt: string) => Promise<void>;
  onDelete: () => void;
  registerRef: (el: HTMLElement | null) => void;
}

/**
 * One note. At rest it carries no chrome at all — body text and a quiet
 * provenance line; actions appear on hover or focus. Optimistic rows
 * (id `optimistic-*`) render without provenance until the write lands,
 * which is what makes the save read as the text becoming the note.
 */
export function NoteRow({
  note,
  originWorkspaceAlive,
  focusable,
  onFocusRow,
  onSave,
  onDelete,
  registerRef,
}: NoteRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const bodyRef = useRef<HTMLParagraphElement>(null);

  const pending = note.id.startsWith("optimistic-");
  const edited = Date.parse(note.updatedAt) - Date.parse(note.createdAt) > 1000;

  // "Show more" must be driven by MEASURED overflow. Inferring it from
  // newline count misses the common case — a long single paragraph is
  // clamped by CSS at 5 visual lines with no hard newline anywhere, so
  // the rest of the note would be unreachable.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || editing) return;
    const measure = () =>
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [note.body, editing, expanded]);

  const nl = note.body.indexOf("\n");
  const hasTitle = nl > 0 && nl <= TITLE_MAX;
  const title = hasTitle ? note.body.slice(0, nl) : null;
  const rest = hasTitle ? note.body.slice(nl + 1).trimStart() : note.body;

  const beginEdit = () => {
    setDraft(note.body);
    setSaveError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setSaveError(null);
    setDraft(note.body);
  };

  const save = async () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed === note.body || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(trimmed, note.updatedAt);
      setEditing(false);
    } catch (err) {
      setSaveError(humanizeError(err));
    } finally {
      setSaving(false);
    }
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (matchShortcut(e.nativeEvent as KeyboardEvent, SHORTCUTS.submitForm)) {
      e.preventDefault();
      void save();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const handleRowKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (editing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      beginEdit();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      onDelete();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void navigator.clipboard?.writeText(note.body).catch(() => {});
    }
  };

  const canSave = draft.trim().length > 0 && draft.trim() !== note.body;

  return (
    <li>
      <article
        ref={registerRef}
        tabIndex={focusable ? 0 : -1}
        onFocus={onFocusRow}
        onKeyDown={handleRowKeyDown}
        onDoubleClick={() => !pending && beginEdit()}
        aria-label={`Note from ${note.originLabel}${
          note.originWorkspaceName
            ? `, ${note.originWorkspaceName}${originWorkspaceAlive ? "" : " (workspace removed)"}`
            : ""
        }`}
        className={cn(
          "group mx-2 my-1 flex flex-col gap-1.5 rounded-[8px] px-2 py-2",
          "transition-colors duration-100",
          "hover:bg-(--color-bg-hover)",
          "focus-visible:bg-(--color-bg-hover) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
          pending && "opacity-90",
        )}
      >
        {editing ? (
          <div className="flex flex-col gap-1.5">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleEditorKeyDown}
              rows={Math.min(Math.max(draft.split("\n").length, 2), 12)}
              autoFocus
              disabled={saving}
              aria-label="Edit note"
              className={cn(
                // Same metrics as the resting body so edit-in-place
                // doesn't shift a single character.
                "block w-full resize-none rounded-[6px] bg-transparent px-0 py-0",
                "text-[13px] leading-[1.5] text-(--color-text-primary)",
                "outline outline-2 -outline-offset-2 outline-(--color-focus-ring)",
                "disabled:opacity-50",
              )}
            />
            {saveError && (
              <div
                role="alert"
                className="flex items-center justify-between gap-2 rounded-[6px] bg-[color-mix(in_oklab,var(--color-danger)_12%,transparent)] px-2 py-1.5"
              >
                <span className="min-w-0 truncate text-[12px] text-(--color-danger-text)">
                  {saveError}
                </span>
                <GlassButton
                  variant="ghost"
                  size="sm"
                  className="!h-6 shrink-0 px-2 text-[11px]"
                  onClick={() => void save()}
                >
                  Retry
                </GlassButton>
              </div>
            )}
            <div className="flex h-6 items-center justify-between gap-2">
              <span className="text-[11px] leading-none text-(--color-text-muted)">
                ⌘↵ save · esc discard
              </span>
              <div className="flex items-center gap-1.5">
                <GlassButton
                  variant="ghost"
                  size="sm"
                  className="!h-6 px-2 text-[11px]"
                  disabled={saving}
                  onClick={cancelEdit}
                >
                  Cancel
                </GlassButton>
                <GlassButton
                  variant="primary"
                  size="sm"
                  className="!h-6 px-2 text-[11px]"
                  disabled={!canSave || saving}
                  {...(!canSave ? { title: "No changes to save" } : {})}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </GlassButton>
              </div>
            </div>
          </div>
        ) : (
          <>
            {title !== null ? (
              <>
                <p className="truncate text-[13px] font-medium leading-[1.5] text-(--color-text-primary)">
                  {title}
                </p>
                <p
                  ref={bodyRef}
                  className={cn(
                    "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-[1.5] text-(--color-text-secondary)",
                    !expanded && "line-clamp-4",
                  )}
                >
                  {rest}
                </p>
              </>
            ) : (
              <p
                ref={bodyRef}
                className={cn(
                  "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-[1.5] text-(--color-text-primary)",
                  !expanded && "line-clamp-5",
                )}
              >
                {rest}
              </p>
            )}

            {(overflowing || expanded) && (
              <button
                type="button"
                tabIndex={-1}
                onClick={() => setExpanded((v) => !v)}
                className="self-start text-[11px] text-(--color-text-muted) transition-colors hover:text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}

            {/* Provenance renders only once the note actually exists —
                on an optimistic row its absence is the "not yet saved"
                signal, and its arrival is the confirmation. */}
            {!pending && (
              <div className="flex h-6 items-center gap-2">
                {/* Icon-only origin: the glyph already says agent vs
                    terminal vs run-command vs repo. The full label
                    ("Terminal 2") lives in its tooltip so the detail is
                    available without being shouted on every row. */}
                <GlassTooltip content={note.originLabel} side="top">
                  <span
                    tabIndex={0}
                    className="flex shrink-0 items-center rounded-[4px] focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
                  >
                    <OriginIcon kind={note.originKind} />
                  </span>
                </GlassTooltip>
                {note.originWorkspaceName &&
                  (originWorkspaceAlive ? (
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-none text-(--color-text-muted)">
                      {note.originWorkspaceName}
                    </span>
                  ) : (
                    <GlassTooltip
                      content="This workspace no longer exists."
                      side="top"
                    >
                      {/* tabIndex so the explanation is reachable by
                          keyboard — Radix's trigger doesn't add one. */}
                      <span
                        tabIndex={0}
                        className="min-w-0 flex-1 truncate font-mono text-[11px] leading-none text-(--color-text-muted) line-through focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
                      >
                        {note.originWorkspaceName}
                        <span className="sr-only"> (workspace removed)</span>
                      </span>
                    </GlassTooltip>
                  ))}
                {!note.originWorkspaceName && <span className="flex-1" />}
                {/* Every note carries a stamp — clock time within today,
                    the date beyond it. A note is a receipt of work; when
                    it was written is part of judging whether it's still
                    true. Full date-time on hover/focus. */}
                <GlassTooltip content={formatAbsolute(note.createdAt)} side="top">
                  <time
                    dateTime={note.createdAt}
                    tabIndex={0}
                    className="shrink-0 font-mono text-[11px] leading-none text-(--color-text-muted) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
                  >
                    {formatNoteStamp(note.createdAt)}
                  </time>
                </GlassTooltip>
                {edited && (
                  <span className="shrink-0 text-[11px] leading-none text-(--color-text-muted)">
                    edited
                  </span>
                )}
                <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Note actions"
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px]",
                        "text-(--color-text-muted) transition-opacity",
                        "hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
                        "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
                        "data-[state=open]:opacity-100",
                      )}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={6}
                      className="glass-modal z-(--z-popover) min-w-[160px] overflow-hidden p-1"
                    >
                      <MenuItem onSelect={beginEdit} hint="↵">
                        Edit
                      </MenuItem>
                      <MenuItem
                        onSelect={() =>
                          void navigator.clipboard
                            ?.writeText(note.body)
                            .catch(() => {})
                        }
                        hint="⌘C"
                      >
                        Copy text
                      </MenuItem>
                      <DropdownMenu.Separator className="my-1 h-px bg-(--color-border-subtle)" />
                      <MenuItem onSelect={onDelete} hint="⌫" danger>
                        Delete…
                      </MenuItem>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            )}
          </>
        )}
      </article>
    </li>
  );
}

function MenuItem({
  children,
  onSelect,
  hint,
  danger,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <DropdownMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-1.5 text-[12px] outline-none",
        "data-[highlighted]:bg-(--color-bg-hover)",
        danger
          ? "text-(--color-danger) data-[highlighted]:text-(--color-danger)"
          : "text-(--color-text-secondary) data-[highlighted]:text-(--color-text-primary)",
      )}
    >
      <span className="flex-1">{children}</span>
      {hint && (
        <span className="text-[11px] text-(--color-text-muted)">{hint}</span>
      )}
    </DropdownMenu.Item>
  );
}
