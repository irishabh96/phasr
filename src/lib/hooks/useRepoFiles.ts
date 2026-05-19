import { useQuery } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";

/**
 * Lists files inside a repo path, honoring .gitignore when present.
 * Disabled when path is null — used by the file-search modal which
 * only wants results once a repo is in scope.
 */
export function useRepoFiles(path: string | null | undefined) {
  return useQuery({
    queryKey: ["repoFiles", path ?? ""],
    queryFn: () => tauri.listRepoFiles(path ?? ""),
    enabled: !!path,
    // Files don't change while the modal is open; cache for the session.
    staleTime: 60_000,
    gcTime: 5 * 60_000,
  });
}
