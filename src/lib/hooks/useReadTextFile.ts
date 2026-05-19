import { useQuery } from "@tanstack/react-query";
import { tauri } from "@/lib/tauri";

/**
 * Reads a UTF-8 text file via the Rust `read_text_file` command. Capped
 * at 1 MB on the backend; oversized / binary files surface as a query
 * error the caller can render as a tasteful empty-state.
 */
export function useReadTextFile(path: string | null | undefined) {
  return useQuery({
    queryKey: ["readTextFile", path ?? ""],
    queryFn: () => tauri.readTextFile(path ?? ""),
    enabled: !!path,
    // File contents don't change while the preview is open; load once.
    staleTime: Infinity,
    gcTime: 5 * 60_000,
    retry: false,
  });
}
