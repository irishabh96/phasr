import { FileWarning, Loader2 } from "lucide-react";
import { useReadTextFile } from "@/lib/hooks/useReadTextFile";

interface FilePreviewTabProps {
  /** Absolute repo path (e.g. /Users/rishabh/code/phasr). */
  repoPath: string;
  /** Repo-relative path (e.g. src/main.rs). */
  filePath: string;
  visible: boolean;
}

/**
 * Read-only preview of a text file. Reads via the `read_text_file`
 * Tauri command which caps at 1 MB and rejects non-UTF-8.
 */
export function FilePreviewTab({ repoPath, filePath, visible }: FilePreviewTabProps) {
  const fullPath = `${repoPath}/${filePath}`;
  const { data, error, isLoading } = useReadTextFile(visible ? fullPath : null);

  return (
    <div
      style={{ display: visible ? "flex" : "none" }}
      className="h-full min-h-0 w-full flex-col overflow-hidden bg-(--color-bg-input)"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-(--glass-border-hairline) px-4 py-2 text-[12px] text-(--color-text-secondary)">
        <code className="truncate">{filePath}</code>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading && (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-(--color-text-muted)">
            <Loader2 size={14} className="animate-spin" />
            Loading…
          </div>
        )}
        {error && !isLoading && (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-[12px] text-(--color-text-muted)">
            <FileWarning size={18} className="text-(--color-warning)" />
            <p>{String(error)}</p>
          </div>
        )}
        {!isLoading && !error && data !== undefined && (
          <pre className="m-0 px-4 py-3 font-mono text-[12px] leading-relaxed text-(--color-text-primary) whitespace-pre">
            {data}
          </pre>
        )}
      </div>
    </div>
  );
}
