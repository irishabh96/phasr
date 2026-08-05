import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";

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

export function useDeleteNote(repositoryId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ["mirror", "deleteNote"],
    mutationFn: (id: string) => tauri.deleteNote(id),
    onSettled: () =>
      qc.invalidateQueries({ queryKey: noteKeys.byRepository(repositoryId) }),
  });
}
