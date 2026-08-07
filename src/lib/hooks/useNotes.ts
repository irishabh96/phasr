import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";
import type { Note } from "@/lib/types";

export const noteKeys = {
  byRepository: (repositoryId: string) =>
    ["notes", "repository", repositoryId] as const,
};

export function useNotes(repositoryId: string | null | undefined) {
  return useQuery({
    queryKey: noteKeys.byRepository(repositoryId ?? ""),
    queryFn: () => tauri.listNotesForRepository(repositoryId ?? ""),
    enabled: !!repositoryId,
  });
}

export function useCreateNote(repositoryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["mirror", "createNote"],
    mutationFn: (
      input: Omit<Parameters<typeof tauri.createNote>[0], "repositoryId">,
    ) => tauri.createNote({ ...input, repositoryId }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: noteKeys.byRepository(repositoryId) }),
  });
}

export function useUpdateNote(repositoryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["mirror", "updateNote"],
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: Parameters<typeof tauri.updateNote>[1];
    }) => tauri.updateNote(id, input),
    // Refetch on error too: a conflict ("changed in another window")
    // should pull the winner's text into view.
    onSettled: () =>
      qc.invalidateQueries({ queryKey: noteKeys.byRepository(repositoryId) }),
  });
}

/**
 * Toggle done. Optimistic: the checkbox must respond on the same frame
 * as the click, and a round-trip is far slower than the eye. On failure
 * the cache rolls back so the box reverts rather than lying.
 */
export function useSetNoteDone(repositoryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["mirror", "setNoteDone"],
    mutationFn: ({ id, done }: { id: string; done: boolean }) =>
      tauri.setNoteDone(id, done),
    onMutate: async ({ id, done }) => {
      const key = noteKeys.byRepository(repositoryId);
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<Note[]>(key);
      qc.setQueryData<Note[]>(key, (old) =>
        (old ?? []).map((n) =>
          n.id === id
            ? { ...n, doneAt: done ? new Date().toISOString() : null }
            : n,
        ),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) {
        qc.setQueryData(noteKeys.byRepository(repositoryId), ctx.previous);
      }
    },
    onSettled: () =>
      qc.invalidateQueries({ queryKey: noteKeys.byRepository(repositoryId) }),
  });
}

export function useDeleteNote(repositoryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["mirror", "deleteNote"],
    mutationFn: (id: string) => tauri.deleteNote(id),
    onSettled: () =>
      qc.invalidateQueries({ queryKey: noteKeys.byRepository(repositoryId) }),
  });
}
