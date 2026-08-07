import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  FolderGit2,
  MoreHorizontal,
  Play,
  Terminal as TerminalIcon,
  Zap,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { NoteCheckbox } from "@/components/ui/NoteCheckbox";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { humanizeError } from "@/lib/humanizeError";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { formatAbsolute, formatDoneStamp, formatNoteStamp } from "@/lib/time";
import type { Note } from "@/lib/types";
import { cn } from "@/lib/utils";

/** A first line longer than this is a paragraph, not a title. */
const TITLE_MAX = 120;

/**
 * The origin glyph is now the SOLE categorical signal (the word was
 * dropped), so it takes the tonal promotion the label gave up. `Play`
 * for run commands, not a boxed chevron — that reads identically to the
 * terminal chevron at this size.
 */
function OriginIcon({ kind }: { kind: Note["originKind"] }) {
  const cls = "shrink-0 text-(--color-text-secondary)";
  switch (kind) {
    case "workspace":
      return <Zap size={12} className={cls} />;
    case "terminal":
      return <TerminalIcon size={12} className={cls} />;
    case "runCommand":
      return <Play size={12} className={cls} />;
    case "repository":
      return <FolderGit2 size={12} className={cls} />;
  }
}

export interface NoteRowProps {
  note: Note;
  /** Whether the origin workspace still exists (live-resolved by the panel). */
  originWorkspaceAlive: boolean;
  /**
   * Follows the group header: named-day buckets ("Today", "Mon 12 Jul")
   * already give the date, so the row shows clock time; month/year
   * buckets need the date instead. Never duplicates the header.
   */
  stamp: "time" | "date";
  /**
   * Which section the row is RENDERED in. Deliberately separate from
   * `note.doneAt` (its live state): checking a note flips the live
   * state instantly but leaves presentation alone until the list
   * settles, so nothing moves out from under the pointer.
   */
  presentation: "open" | "done";
  onToggleDone: (done: boolean) => void;
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
  stamp,
  presentation,
  onToggleDone,
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
  const done = note.doneAt !== null;
  const collapsed = presentation === "done";
  const edited = Date.parse(note.updatedAt) - Date.parse(note.createdAt) > 1000;

  // "Show more" must be driven by MEASURED overflow. Inferring it from
  // newline count misses the common case — a long single paragraph is
  // clamped by CSS at 5 visual lines with no hard newline anywhere, so
  // the rest of the note would be unreachable.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || editing) return;
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
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
    if (e.key === " " || e.code === "Space") {
      // Space is the universal checkbox key. preventDefault or the
      // scroll container pages down under us.
      e.preventDefault();
      onToggleDone(!done);
      return;
    }
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
        aria-keyshortcuts="Space"
        aria-label={`${done ? "Done" : "To do"}, note from ${note.originLabel}${
          note.originWorkspaceName
            ? `, ${note.originWorkspaceName}${originWorkspaceAlive ? "" : " (workspace removed)"}`
            : ""
        }, ${formatAbsolute(note.createdAt)}`}
        className={cn(
          "group mx-2 grid grid-cols-[20px_1fr] items-start gap-x-2 rounded-[8px] px-2",
          collapsed ? "my-0.5 py-1.5" : "my-1 py-2",
          "transition-colors duration-100",
          "hover:bg-(--color-bg-hover)",
          "focus-visible:bg-(--color-bg-hover) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
          pending && "opacity-90",
        )}
      >
        <NoteCheckbox
          checked={done}
          onToggle={() => onToggleDone(!done)}
          className="-ml-1.5 -mt-1"
        />
        <div className="flex min-w-0 flex-col gap-1.5">
        {editing ? (
          <div className="flex flex-col gap-2">
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
            <div className="flex h-6 items-center justify-end gap-2">
              <div className="flex items-center gap-1.5">
                <GlassButton
                  variant="ghost"
                  size="sm"
                  className="!h-6 px-2 text-[11px]"
                  disabled={saving}
                  title="Discard (Esc)"
                  onClick={cancelEdit}
                >
                  Cancel
                </GlassButton>
                <GlassButton
                  variant="primary"
                  size="sm"
                  className="!h-6 px-2 text-[11px]"
                  disabled={!canSave || saving}
                  title={canSave ? "Save (⌘↵)" : "No changes to save"}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </GlassButton>
              </div>
            </div>
          </div>
        ) : collapsed ? (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] leading-[1.5] text-(--color-text-secondary)">
              {note.body}
            </p>
            {note.doneAt && (
              <GlassTooltip content={formatAbsolute(note.doneAt)} side="top">
                <span className="shrink-0 font-mono text-[11px] leading-none text-(--color-text-muted)">
                  {formatDoneStamp(note.doneAt)}
                </span>
              </GlassTooltip>
            )}
          </div>
        ) : (
          <>
            {title !== null ? (
              <>
                <p
                  className={cn(
                    "truncate text-[13px] font-medium leading-[1.5]",
                    done
                      ? "text-(--color-text-secondary)"
                      : "text-(--color-text-primary)",
                  )}
                >
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
                  "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-[1.5]",
                  done
                    ? "text-(--color-text-secondary)"
                    : "text-(--color-text-primary)",
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
            {/* The meta line keeps its height on a pending row (content
                hidden, not absent) so the provenance arriving on save
                doesn't shove the list — the receipt fades in, in place.
                Two tonal groups: [origin: icon + ref] … [when: time].
                None of these are tab stops — the panel runs a roving
                tabindex, and the row's aria-label carries all of this
                text for keyboard and screen-reader users. */}
            <div
              className={cn(
                "flex h-6 items-center gap-1.5",
                "transition-opacity duration-[var(--duration-glass)] motion-reduce:transition-none",
                pending && "pointer-events-none opacity-0",
              )}
              aria-hidden={pending}
            >
              <GlassTooltip content={note.originLabel} side="top">
                <span className="flex h-6 w-4 shrink-0 items-center justify-center">
                  <OriginIcon kind={note.originKind} />
                </span>
              </GlassTooltip>
              {note.originWorkspaceName &&
                (originWorkspaceAlive ? (
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-none text-(--color-text-secondary)">
                    {note.originWorkspaceName}
                  </span>
                ) : (
                  <GlassTooltip
                    content="This workspace no longer exists."
                    side="top"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-none text-(--color-text-muted) line-through">
                      {note.originWorkspaceName}
                      <span className="sr-only"> (workspace removed)</span>
                    </span>
                  </GlassTooltip>
                ))}
              {!note.originWorkspaceName && <span className="flex-1" />}
              <GlassTooltip content={formatAbsolute(note.createdAt)} side="top">
                <div className="flex shrink-0 items-center gap-1 text-[11px] leading-none text-(--color-text-muted)">
                  <time dateTime={note.createdAt} className="font-mono">
                    {formatNoteStamp(note.createdAt, stamp)}
                  </time>
                  {edited && <span>· edited</span>}
                </div>
              </GlassTooltip>
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
          </>
        )}
        </div>
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
