import { NotebookPen, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { NoteComposer } from "@/components/NoteComposer";
import { NoteRow } from "@/components/NoteRow";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { GlassInput } from "@/components/ui/GlassInput";
import { PanelState } from "@/components/ui/PanelState";
import {
  useCreateNote,
  useDeleteNote,
  useNotes,
  useUpdateNote,
} from "@/lib/hooks/useNotes";
import { useWorkspaces } from "@/lib/hooks/useWorkspaces";
import type { NoteOrigin } from "@/lib/noteProvenance";
import { useUiStore } from "@/lib/store";
import type { Note } from "@/lib/types";

const FILTER_VISIBLE_AT = 8;

export interface NotesPanelProps {
  repositoryId: string;
  /** Called at save time so provenance reflects the surface right now. */
  getOrigin: () => NoteOrigin;
}

/**
 * The repository-notes panel: sticky composer on top, newest-first
 * hairline-divided rows below, filter past 8 notes, delete behind a
 * destructive confirm that quotes the note. Mounted in the workspace
 * right rail and the repo-home rail — same component, two hosts.
 */
export function NotesPanel({ repositoryId, getOrigin }: NotesPanelProps) {
  const { data: notes, isPending, error, refetch } = useNotes(repositoryId);
  const { data: workspaces } = useWorkspaces(repositoryId);
  const createNote = useCreateNote(repositoryId);
  const updateNote = useUpdateNote(repositoryId);
  const deleteNote = useDeleteNote(repositoryId);
  const focusRequest = useUiStore((s) => s.notesFocusRequest);
  const requestNotesFocus = useUiStore((s) => s.requestNotesFocus);

  const [filter, setFilter] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Note | null>(null);

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

  const handleCreate = async (body: string) => {
    await createNote.mutateAsync({ body, ...getOrigin() });
  };

  return (
    <div className="flex h-full min-h-0 flex-col" aria-label="Repository notes">
      <div className="sticky top-0 z-10 flex shrink-0 flex-col">
        <NoteComposer
          repositoryId={repositoryId}
          onCreate={handleCreate}
          focusRequest={focusRequest}
        />
        {(notes?.length ?? 0) > FILTER_VISIBLE_AT && (
          <div className="relative border-b border-(--color-border-subtle) bg-(--color-bg-surface) px-2 pb-2">
            <Search
              size={11}
              className="pointer-events-none absolute left-4 top-1/2 -translate-y-[calc(50%+4px)] text-(--color-text-muted)"
            />
            <GlassInput
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter notes"
              aria-label="Filter notes"
              className="!h-7 pl-7 text-[12px]"
            />
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isPending ? (
          <div className="p-3">
            <PanelState kind="loading" rows={3} />
          </div>
        ) : error ? (
          <PanelState
            kind="error"
            title="Couldn't load notes"
            error={error}
            onRetry={() => void refetch()}
          />
        ) : (notes?.length ?? 0) === 0 ? (
          <PanelState
            kind="empty"
            icon={<NotebookPen />}
            title="No notes for this repository"
            description="Jot down anything about this repo — setup quirks, commands, decisions. Notes stay with the repository, not the task."
            action={
              <button
                type="button"
                onClick={requestNotesFocus}
                className="rounded-[8px] bg-(--color-accent-500) px-3 py-1.5 text-[13px] font-medium text-(--color-accent-onfill) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
              >
                Write a note
              </button>
            }
          />
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <p className="text-[12px] text-(--color-text-muted)">
              No notes match “{filter.trim()}”.
            </p>
            <button
              type="button"
              onClick={() => setFilter("")}
              className="text-[12px] text-(--color-text-secondary) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]"
            >
              Clear filter
            </button>
          </div>
        ) : (
          <ul
            role="list"
            className="divide-y divide-(--color-border-subtle)"
          >
            {visible.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                originWorkspaceAlive={
                  !note.originWorkspaceId ||
                  liveWorkspaceIds.has(note.originWorkspaceId)
                }
                onSave={async (body, expectedUpdatedAt) => {
                  await updateNote.mutateAsync({
                    id: note.id,
                    input: { body, expectedUpdatedAt },
                  });
                }}
                onDelete={() => setPendingDelete(note)}
              />
            ))}
          </ul>
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
