import { Plus, Search } from "lucide-react";
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
  useUpdateNote,
} from "@/lib/hooks/useNotes";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import type { NoteOrigin } from "@/lib/noteProvenance";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { dayBucket } from "@/lib/time";
import type { Note } from "@/lib/types";
import { cn } from "@/lib/utils";

const FILTER_VISIBLE_AT = 8;

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
  const composerOpen = useUiStore((s) => s.notesComposerOpen);
  const composerRequest = useUiStore((s) => s.notesComposerRequest);
  const openComposer = useUiStore((s) => s.openNotesComposer);

  const [filter, setFilter] = useState("");
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

  /** Newest-first, bucketed by recency; flat index kept for roving focus. */
  const groups = useMemo(() => {
    const out: { label: string; spansDays: boolean; notes: Note[] }[] = [];
    for (const note of visible) {
      const bucket = dayBucket(note.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === bucket.label) last.notes.push(note);
      else out.push({ ...bucket, notes: [note] });
    }
    return out;
  }, [visible]);

  const focusRow = (i: number) => {
    const clamped = Math.max(0, Math.min(i, visible.length - 1));
    setActiveIndex(clamped);
    rowRefs.current[clamped]?.focus();
  };

  const handleListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(activeIndex + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(activeIndex - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusRow(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusRow(visible.length - 1);
    } else if (e.key === "/" && (notes?.length ?? 0) > FILTER_VISIBLE_AT) {
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
  const todayGroupExists = groups[0]?.label === "Today";

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
        className="min-h-0 flex-1 overflow-y-auto"
        onKeyDown={handleListKeyDown}
      >
        {/* A note written now belongs to Today, so the composer renders
            INSIDE today's group, under its header — never above it and
            never growing a second one. When today has no notes yet the
            header is synthesised here. */}
        {showComposer && !todayGroupExists && (
          <>
            <GroupHeader label="Today" />
            {composerEl}
          </>
        )}

        {(notes?.length ?? 0) > FILTER_VISIBLE_AT && (
          <div className="relative px-2 py-1.5">
            <Search
              size={11}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-(--color-text-muted)"
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
              className="!h-7 rounded-[6px] pl-7 text-[12px]"
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
          <div className="px-4 py-3">
            <h3 className="text-[13px] font-medium text-(--color-text-primary)">
              No notes yet
            </h3>
            <p className="mt-1 text-[12px] leading-[1.45] text-(--color-text-muted)">
              Setup quirks, the command that works, why you did it that way —
              kept with the repo.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-3">
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
          groups.map((group, gi) => (
            <div key={group.label}>
              <GroupHeader label={group.label} />
              {gi === 0 && todayGroupExists && composerEl}
              <ul role="list">
                {group.notes.map((note) => {
                  flatIndex += 1;
                  const i = flatIndex;
                  return (
                    <NoteRow
                      key={note.id}
                      note={note}
                      stamp={group.spansDays ? "date" : "time"}
                      originWorkspaceAlive={
                        !note.originWorkspaceId ||
                        liveWorkspaceIds.has(note.originWorkspaceId)
                      }
                      focusable={i === activeIndex}
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
                      onDelete={() => setPendingDelete(note)}
                    />
                  );
                })}
              </ul>
            </div>
          ))
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
                "group/c mx-2 mt-1 flex h-7 shrink-0 items-center gap-2 rounded-[6px] px-2 text-left",
                "text-[12px] text-(--color-text-muted)",
                "hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)",
                "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
              )}
            >
              <Plus size={13} />
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

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="sticky top-0 z-10 flex h-7 items-center bg-(--color-bg-surface) px-4 text-[11px] font-medium leading-none text-(--color-text-muted)">
      {label}
    </div>
  );
}

/**
 * Skeleton shaped like real note rows (two ragged text bars + a meta
 * bar, same block geometry) so the panel doesn't visibly re-lay-out
 * when the query resolves.
 */
function NotesSkeleton() {
  return (
    <div aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="mx-2 my-1 flex flex-col gap-1.5 px-2 py-2">
          <div className="skeleton-bar h-[10px] w-full rounded" />
          <div
            className="skeleton-bar h-[10px] rounded"
            style={{ width: i === 1 ? "45%" : "62%" }}
          />
          <div className="mt-1 skeleton-bar h-[10px] w-[60px] rounded" />
        </div>
      ))}
    </div>
  );
}
