import { ChevronRight, Plus, Search } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { NoteComposer } from "@/components/NoteComposer";
import { NoteRow } from "@/components/NoteRow";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { GlassInput } from "@/components/ui/GlassInput";
import { KBD_CLS } from "@/components/ui/palette";
import { PanelState } from "@/components/ui/PanelState";
import {
  useCreateNote,
  useDeleteNote,
  useNotes,
  useSetNoteDone,
  useUpdateNote,
} from "@/lib/hooks/useNotes";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import type { NoteOrigin } from "@/lib/noteProvenance";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { useSettledLayout } from "@/lib/notesLayout";
import type { Note } from "@/lib/types";
import { cn } from "@/lib/utils";

const FILTER_VISIBLE_AT = 12;

export interface NotesPanelProps {
  repositoryId: string;
  /** Called at save time so provenance reflects the surface right now. */
  getOrigin: () => NoteOrigin;
}

/**
 * The repository-notes panel — a READING surface. At rest it contains
 * notes and nothing else: no pinned input, no chrome on the rows, no
 * accent colour anywhere. Capture is summoned (⌘⇧N, the header +, or
 * the "New note" canvas row) and appears as row zero.
 */
export function NotesPanel({ repositoryId, getOrigin }: NotesPanelProps) {
  const { data: notes, isPending, error, refetch } = useNotes(repositoryId);
  const { data: workspaces } = useWorkspaces(repositoryId);
  const createNote = useCreateNote(repositoryId);
  const updateNote = useUpdateNote(repositoryId);
  const deleteNote = useDeleteNote(repositoryId);
  const setNoteDone = useSetNoteDone(repositoryId);
  const composerOpen = useUiStore((s) => s.notesComposerOpen);
  const composerRequest = useUiStore((s) => s.notesComposerRequest);
  const openComposer = useUiStore((s) => s.openNotesComposer);

  const [filter, setFilter] = useState("");
  // See notesLayout.ts: the list tidies a beat after the last change,
  // not when the pointer leaves — the pointer is always still here
  // right after a click.
  const [doneOpen, setDoneOpen] = useState(false);
  // A settle that remounts a row mid-edit discards the draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const rowRefs = useRef<(HTMLElement | null)[]>([]);
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const liveWorkspaceIds = useMemo(
    () => new Set((workspaces ?? []).map((w) => w.id)),
    [workspaces],
  );

  const visible = useMemo(() => {
    if (!notes) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return notes;
    return notes.filter((n) => n.body.toLowerCase().includes(q));
  }, [notes, filter]);

  const { open: openNotes, done: doneNotes } = useSettledLayout(
    visible,
    pendingDelete !== null || editingId !== null,
  );

  // Only rows that are actually mounted are navigable: done rows exist
  // in the DOM only while the section is expanded.
  const navCount = openNotes.length + (doneOpen ? doneNotes.length : 0);
  const active = Math.min(activeIndex, Math.max(0, navCount - 1));

  const focusRow = (i: number) => {
    const clamped = Math.max(0, Math.min(i, navCount - 1));
    setActiveIndex(clamped);
    rowRefs.current[clamped]?.focus();
  };

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // The handler sits on the scroll container, which also holds the
    // composer, the filter and every row editor. Without this, arrows
    // moved row focus instead of the caret, Home/End jumped rows, and
    // "/" was un-typeable inside a note.
    const t = e.target as HTMLElement;
    if (
      t.tagName === "TEXTAREA" ||
      t.tagName === "INPUT" ||
      t.isContentEditable
    )
      return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(active - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(navCount - 1);
    } else if (
      e.key === "/" &&
      ((notes?.length ?? 0) > FILTER_VISIBLE_AT || filter.length > 0)
    ) {
      e.preventDefault();
      scrollRef.current?.scrollTo({ top: 0 });
      filterRef.current?.focus();
    }
  };

  const handleCreate = async (body: string) => {
    await createNote.mutateAsync({ body, ...getOrigin() });
  };

  const isEmpty = !isPending && !error && (notes?.length ?? 0) === 0;
  // With zero notes the composer IS the empty state's affordance — but
  // unfocused, so opening the panel never opens with a blinking caret.
  const showComposer = composerOpen || isEmpty;

  const composerEl = showComposer ? (
    <NoteComposer
      repositoryId={repositoryId}
      onCreate={handleCreate}
      focusRequest={composerRequest}
      autoFocus={composerOpen}
    />
  ) : null;

  let flatIndex = -1;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        onKeyDown={handleListKeyDown}
      >
        {/* A note written now belongs to Today, so the composer renders
            INSIDE today's group, under its header — never above it and
            never growing a second one. When today has no notes yet the
            header is synthesised here. */}
        {/* Composer is row zero — no synthesised day header above it. */}
        {composerEl}

        {((notes?.length ?? 0) > FILTER_VISIBLE_AT || filter.length > 0) && (
          <div className="relative px-[4px] py-[4px]">
            <Search
              size={12}
              className="pointer-events-none absolute left-[13px] top-1/2 -translate-y-1/2 text-(--color-text-muted)"
            />
            <GlassInput
              ref={filterRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setFilter("");
                  rowRefs.current[0]?.focus();
                }
              }}
              placeholder="Filter notes"
              aria-label="Filter notes"
              className="!h-[26px] rounded-[6px] pl-[30px] pr-[8px] text-[12px]"
            />
          </div>
        )}

        {isPending ? (
          <NotesSkeleton />
        ) : error ? (
          <PanelState
            kind="error"
            title="Couldn't load notes"
            error={error}
            onRetry={() => void refetch()}
          />
        ) : isEmpty ? (
          <div className="px-[12px] py-[8px]">
            <h3 className="text-[13px] font-medium text-(--color-text-primary)">
              No notes yet
            </h3>
            <p className="mt-1 text-[12px] leading-[1.45] text-(--color-text-muted)">
              Setup quirks, the command that works, why you did it that way —
              kept with the repo.
            </p>
          </div>
        ) : openNotes.length === 0 && doneNotes.length > 0 ? (
          <div className="flex h-[30px] items-center px-[8px] text-[13px] text-(--color-text-muted)">
            <span className="pl-[26px]">Nothing open.</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="px-[12px] py-[8px]">
            <p className="text-[12px] text-(--color-text-muted)">
              No notes match “{filter.trim()}”.
            </p>
            <button
              type="button"
              onClick={() => setFilter("")}
              className="mt-1 text-[12px] text-(--color-text-secondary) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
            >
              Clear
            </button>
          </div>
        ) : (
          <ul role="list">
            {openNotes.map((note) => {
              flatIndex += 1;
              const i = flatIndex;
              return (
                <NoteRow
                  key={note.id}
                  note={note}
                  presentation="open"
                  onToggleDone={(next) =>
                    setNoteDone.mutate({ id: note.id, done: next })
                  }
                  originWorkspaceAlive={
                    !note.originWorkspaceId ||
                    liveWorkspaceIds.has(note.originWorkspaceId)
                  }
                  focusable={i === active}
                  onFocusRow={() => setActiveIndex(i)}
                  registerRef={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  onSave={async (body, expectedUpdatedAt) => {
                    await updateNote.mutateAsync({
                      id: note.id,
                      input: { body, expectedUpdatedAt },
                    });
                  }}
                  onEditingChange={(on) => setEditingId(on ? note.id : null)}
                  onDelete={() => setPendingDelete(note)}
                />
              );
            })}
          </ul>
        )}

        {doneNotes.length > 0 && (
          <div className="mt-1 border-t border-(--color-border-subtle) pt-1">
            <button
              type="button"
              onClick={() => setDoneOpen((v) => !v)}
              aria-expanded={doneOpen}
              className={cn(
                "mx-[4px] flex h-[24px] w-[calc(100%-8px)] items-center gap-[8px] rounded-[6px] px-[8px] text-[11px] font-medium",
                "text-(--color-text-muted) hover:text-(--color-text-secondary)",
                "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
              )}
            >
              <span className="grid w-[14px] shrink-0 place-items-center">
                <ChevronRight
                  size={12}
                  className={cn(
                    "transition-transform duration-[var(--duration-glass)] motion-reduce:transition-none",
                    doneOpen && "rotate-90",
                  )}
                />
              </span>
              <span className="flex-1 text-left">Done</span>
              <span
                aria-live="polite"
                className="-mr-[6px] w-[24px] text-center text-(--color-text-secondary)"
              >
                {doneNotes.length}
              </span>
            </button>
            {doneOpen && (
              <ul role="list">
                {doneNotes.map((note) => {
                  flatIndex += 1;
                  const i = flatIndex;
                  return (
                    <NoteRow
                      key={note.id}
                      note={note}
                      presentation="done"
                      onToggleDone={(next) =>
                        setNoteDone.mutate({ id: note.id, done: next })
                      }
                      originWorkspaceAlive={
                        !note.originWorkspaceId ||
                        liveWorkspaceIds.has(note.originWorkspaceId)
                      }
                      focusable={i === active}
                      onFocusRow={() => setActiveIndex(i)}
                      registerRef={(el) => {
                        rowRefs.current[i] = el;
                      }}
                      onSave={async (body, expectedUpdatedAt) => {
                        await updateNote.mutateAsync({
                          id: note.id,
                          input: { body, expectedUpdatedAt },
                        });
                      }}
                      onEditingChange={(on) =>
                        setEditingId(on ? note.id : null)
                      }
                      onDelete={() => setPendingDelete(note)}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        )}

        {/* The canvas: the space below the last note is the primary
            "new note" target rather than dead grey. */}
        {!isPending && !error && !isEmpty && (
          <div
            className="flex min-h-0 flex-1 cursor-text flex-col"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) openComposer();
            }}
          >
            <button
              type="button"
              onClick={openComposer}
              className={cn(
                "group/c mx-[4px] mt-[2px] flex h-[30px] shrink-0 items-center gap-[8px] rounded-[6px] px-[8px] text-left",
                "text-[12px] text-(--color-text-muted)",
                "hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)",
                "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
              )}
            >
              <span className="grid w-[14px] shrink-0 place-items-center">
                <Plus size={12} />
              </span>
              <span className="flex-1">New note</span>
              <kbd
                className={cn(
                  KBD_CLS,
                  "opacity-0 transition-opacity group-hover/c:opacity-100",
                )}
              >
                {SHORTCUTS.openNotes.display.join("")}
              </kbd>
            </button>
            <div
              className="min-h-[80px] flex-1"
              aria-hidden
              onMouseDown={openComposer}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Delete note?"
        description={
          pendingDelete
            ? `“${pendingDelete.body.slice(0, 80)}${
                pendingDelete.body.length > 80 ? "…" : ""
              }” will be removed. This can't be undone.`
            : ""
        }
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        destructive
        pending={deleteNote.isPending}
        size="sm"
        onConfirm={() => {
          if (!pendingDelete) return;
          deleteNote.mutate(pendingDelete.id, {
            onSettled: () => setPendingDelete(null),
          });
        }}
      />
    </div>
  );
}

/**
 * Skeleton at the REAL row geometry (30px, 14px checkbox column, 34px
 * text origin) so data landing doesn't reflow the panel.
 *
 * Styling is self-contained on purpose: `.skeleton-bar` has no base
 * rule — its only definition lives inside a prefers-reduced-motion
 * media query — so relying on it rendered nothing at all.
 */
function NotesSkeleton() {
  const widths = ["72%", "54%", "83%", "46%"];
  return (
    <div aria-hidden>
      {widths.map((width, i) => (
        <div
          key={i}
          className="mx-[4px] flex h-[30px] items-center gap-x-[8px] px-[8px]"
        >
          <div className="h-[14px] w-[14px] shrink-0 animate-[pulse-skeleton_1.4s_ease-in-out_infinite] rounded-[4px] bg-(--color-bg-hover)" />
          <div
            className="h-[10px] animate-[pulse-skeleton_1.4s_ease-in-out_infinite] rounded-[3px] bg-(--color-bg-hover)"
            style={{ width }}
          />
        </div>
      ))}
    </div>
  );
}
