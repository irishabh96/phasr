import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  FolderGit2,
  ChevronDown,
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
import { formatAbsolute, formatCompactStamp } from "@/lib/time";
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
  const cls =
    "shrink-0 text-(--color-text-muted) group-hover:text-(--color-text-secondary)";
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
   * Which section the row is RENDERED in. Deliberately separate from
   * `note.doneAt` (its live state): checking a note flips the live
   * state instantly but leaves presentation alone until the list
   * settles, so nothing moves out from under the pointer.
   */
  presentation: "open" | "done";
  onToggleDone: (done: boolean) => void;
  /** Lets the panel hold layout still while this row has an open editor. */
  onEditingChange?: (editing: boolean) => void;
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
  presentation,
  onToggleDone,
  onEditingChange,
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
  const editorRef = useRef<HTMLTextAreaElement>(null);

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

  // `rows` counts logical lines; a long unwrapped note would render one
  // 30px row over 130px of content and hide the rest behind an internal
  // scrollbar. Size to the wrapped content instead, capped at 12 lines.
  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el || !editing) return;
    const fit = () => {
      // Measure with the scrollbar suppressed: at height:auto an
      // overflow-y:auto textarea shows one, which narrows the text and
      // inflates scrollHeight — set that height and the bar disappears,
      // the text re-wraps shorter, and the box ends up a line too tall
      // (or short) forever. Only re-enable scrolling at the cap.
      el.style.overflowY = "hidden";
      el.style.height = "auto";
      // scrollHeight excludes the border, but box-sizing is border-box —
      // and the @layer base field reset puts a 1px border on every
      // textarea. Without adding it back the box is always 2px short and
      // clips the last line.
      const border = el.offsetHeight - el.clientHeight;
      const content = el.scrollHeight + border;
      el.style.height = `${Math.min(content, 250)}px`;
      el.style.overflowY = content > 250 ? "auto" : "hidden";
    };
    fit();
    // Width changes reflow the text, so a height measured once goes stale
    // — dragging the rail while editing, or any late layout settle, would
    // otherwise clip the last line behind an internal scrollbar.
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [draft, editing]);

  const nl = note.body.indexOf("\n");
  const hasTitle = nl > 0 && nl <= TITLE_MAX;
  const title = hasTitle ? note.body.slice(0, nl) : null;
  const rest = (hasTitle ? note.body.slice(nl + 1) : note.body)
    .replace(/^\s*\n+/, "")
    .trimStart();

  const beginEdit = () => {
    setDraft(note.body);
    setSaveError(null);
    setEditing(true);
    onEditingChange?.(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    onEditingChange?.(false);
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
      onEditingChange?.(false);
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
    if (e.key === "ArrowRight" && overflowing) {
      e.preventDefault();
      setExpanded(true);
      return;
    }
    if (e.key === "ArrowLeft" && expanded) {
      e.preventDefault();
      setExpanded(false);
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
          // Explicit px: html{font-size:13px} makes rem utilities render
          // at 0.8125x, so `py-2` is 6.5px and nothing lands on a pixel.
          // 5 + 20 + 5 = a 30px row, and every extra line is exactly +20.
          "group mx-[4px] grid grid-cols-[14px_minmax(0,1fr)_auto] items-start",
          "gap-x-[8px] rounded-[6px] px-[8px] py-[5px] min-h-[30px]",
          // No row transition: a sweep crosses 8 rows in ~200ms and a
          // fade on each leaves a comet trail.
          "hover:bg-(--color-bg-hover)",
          // Inset ring — rows are flush, so an outer ring would overlap
          // its neighbours and clip at the scroll container.
          "focus-visible:bg-(--color-bg-hover) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus-inset)]",
          pending && "opacity-90",
          menuOpen && "bg-(--color-bg-hover)",
        )}
      >
        <NoteCheckbox
          checked={done}
          // No className override: the caller's -ml/-mt beat the
          // component's own -mx-[5px] -my-[2px] in the built CSS and sat
          // the tick 1.25px high on every row.
          // Ticking mid-edit would toggle done under an open editor.
          disabled={editing}
          onToggle={() => onToggleDone(!done)}
        />
        <div className="flex min-w-0 flex-col gap-1.5">
          {editing ? (
            // Breaks out of column 2 to the article's full border box, so
            // the field is the same rectangle as the composer and the
            // checkbox lives inside its 30px gutter. Safe only because
            // column 3 is unmounted while editing (see below).
            <div className="-ml-[30px] -mr-[16px] flex flex-col gap-[8px]">
              <textarea
                ref={editorRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={handleEditorKeyDown}
                rows={Math.min(Math.max(draft.split("\n").length, 1), 12)}
                autoFocus
                disabled={saving}
                aria-label="Edit note"
                className={cn(
                  // Same metrics as the resting body so edit-in-place
                  // doesn't shift a single character.
                  // pl-30 reserves the checkbox gutter so the caret lands on
                  // the same 34px origin it had at rest; -mt cancels the row's
                  // top padding so the first line box doesn't move either.
                  "block w-full resize-none rounded-[6px] bg-transparent",
                  "-mt-[5px] py-[5px] pl-[30px] pr-[8px]",
                  "text-[13px] leading-[20px] text-(--color-text-primary)",
                  "min-h-[30px] max-h-[250px]",
                  // Hairline at rest, coral on focus — a permanent focus ring
                  // meant tabbing to Save left two focus indicators, one lying.
                  "outline outline-1 -outline-offset-1 outline-(--glass-border-hairline)",
                  "focus:outline-2 focus:outline-(--color-focus-ring)",
                  "transition-[outline-color] duration-[var(--duration-glass)] [transition-timing-function:var(--ease-glass)] motion-reduce:transition-none",
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
                    className="!h-[24px] shrink-0 px-2 text-[11px]"
                    onClick={() => void save()}
                  >
                    Retry
                  </GlassButton>
                </div>
              )}
              <div className="flex h-[24px] items-center justify-end gap-[6px]">
                {/* Delete is reachable from the editor: Cancel/Save were
                    the only actions here, so a note you'd opened to fix
                    and then decided to bin had no way out. */}
                <GlassButton
                  variant="ghost"
                  size="sm"
                  className="!h-[24px] mr-[8px] px-[8px] text-[11px] text-(--color-text-muted) hover:!text-(--color-danger)"
                  disabled={saving}
                  title="Delete (⌫)"
                  onClick={onDelete}
                >
                  Delete…
                </GlassButton>
                <GlassButton
                  variant="ghost"
                  size="sm"
                  className="!h-[24px] px-2 text-[11px]"
                  disabled={saving}
                  title="Discard (Esc)"
                  onClick={cancelEdit}
                >
                  Cancel
                </GlassButton>
                <GlassButton
                  variant="primary"
                  size="sm"
                  className="!h-[24px] px-2 text-[11px]"
                  disabled={!canSave || saving}
                  title={canSave ? "Save (⌘↵)" : "No changes to save"}
                  onClick={() => void save()}
                >
                  {saving ? "Saving…" : "Save"}
                </GlassButton>
              </div>
            </div>
          ) : collapsed ? (
            // Body only — the stamp lives in the right cluster for EVERY
            // state; rendering one here too put two on a done row.
            // Tooltip because a collapsed row never measures overflow
            // (no bodyRef), so the expand chevron can't appear here.
            <GlassTooltip content={title ?? rest} side="top">
              <p className="min-w-0 truncate text-[13px] leading-[20px] text-(--color-text-secondary)">
                {title ?? rest}
              </p>
            </GlassTooltip>
          ) : (
            <>
              {title !== null ? (
                <>
                  <p
                    className={cn(
                      "truncate text-[13px] font-medium leading-[20px]",
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
                      "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-[20px] text-(--color-text-secondary)",
                      !expanded && "line-clamp-1",
                    )}
                  >
                    {rest}
                  </p>
                </>
              ) : (
                <p
                  ref={bodyRef}
                  className={cn(
                    "whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[13px] leading-[20px]",
                    done
                      ? "text-(--color-text-secondary)"
                      : "text-(--color-text-primary)",
                    !expanded && "line-clamp-2",
                  )}
                >
                  {rest}
                </p>
              )}
            </>
          )}
        </div>
        {/* Provenance costs ZERO vertical space now: it lives in
                the right cluster, locked to the 20px first line box so
                it can never grow the row. The origin glyph doubles as
                the actions trigger — a 12px mark that says "this note
                remembers where it came from" and opens the menu. The
                workspace ref and the absolute time are one hover
                deeper, in the tooltip and the menu header; at a 300px
                rail a visible ref would eat 44% of the task text.
                The row's aria-label still carries all of it verbatim,
                so nothing moved out of reach of a screen reader. */}
        {!editing && (
          <div
            className={cn(
              "col-start-3 flex h-[20px] shrink-0 items-center gap-[6px]",
              "transition-opacity duration-[var(--duration-glass)] motion-reduce:transition-none",
              pending && "pointer-events-none opacity-0",
            )}
            aria-hidden={pending}
          >
            {(overflowing || expanded) && (
              <button
                type="button"
                tabIndex={-1}
                aria-label={expanded ? "Collapse note" : "Expand note"}
                onClick={() => setExpanded((v) => !v)}
                className="grid h-[24px] w-[24px] -my-[2px] place-items-center rounded-[5px] text-(--color-text-muted) opacity-0 hover:bg-(--color-bg-elevated) hover:text-(--color-text-secondary) group-hover:opacity-100 group-focus-within:opacity-100"
              >
                <ChevronDown
                  size={12}
                  className={cn(
                    "transition-transform duration-[var(--duration-glass)] motion-reduce:transition-none",
                    expanded && "rotate-180",
                  )}
                />
              </button>
            )}
            <span
              className={cn(
                "min-w-[34px] shrink-0 text-right text-[11px] leading-[20px] tabular-nums text-(--color-text-muted)",
                "transition-opacity duration-[var(--duration-glass)] motion-reduce:transition-none",
                // A done row's stamp is its point — always visible.
                collapsed || menuOpen
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
              )}
            >
              {formatCompactStamp(
                collapsed && note.doneAt ? note.doneAt : note.createdAt,
              )}
              {edited && !collapsed ? " · edited" : ""}
            </span>
            <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
              <GlassTooltip
                content={`${note.originLabel}${note.originWorkspaceName ? ` · ${note.originWorkspaceName}` : ""}${originWorkspaceAlive ? "" : " (removed)"}`}
                side="top"
              >
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label="Note actions"
                    aria-haspopup="menu"
                    className="grid h-[24px] w-[24px] -my-[2px] -mr-[6px] shrink-0 place-items-center rounded-[5px] hover:bg-(--color-bg-elevated) data-[state=open]:bg-(--color-bg-elevated)"
                  >
                    <span
                      className={cn(menuOpen ? "hidden" : "group-hover:hidden")}
                    >
                      <OriginIcon kind={note.originKind} />
                    </span>
                    <MoreHorizontal
                      size={13}
                      className={cn(
                        "text-(--color-text-secondary)",
                        menuOpen ? "block" : "hidden group-hover:block",
                      )}
                    />
                  </button>
                </DropdownMenu.Trigger>
              </GlassTooltip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  align="end"
                  sideOffset={6}
                  className="glass-modal z-(--z-popover) min-w-[180px] overflow-hidden p-1"
                >
                  <div
                    role="presentation"
                    className="px-2 py-1.5 text-[11px] text-(--color-text-muted)"
                  >
                    <span>{note.originLabel}</span>
                    {note.originWorkspaceName && (
                      <>
                        {" · "}
                        <span
                          className={cn(
                            "font-mono",
                            !originWorkspaceAlive && "line-through",
                          )}
                        >
                          {note.originWorkspaceName}
                        </span>
                        {!originWorkspaceAlive && " (removed)"}
                      </>
                    )}
                    <div className="mt-0.5">
                      {formatAbsolute(note.createdAt)}
                    </div>
                  </div>
                  <DropdownMenu.Separator className="my-1 h-px bg-(--color-border-subtle)" />
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
