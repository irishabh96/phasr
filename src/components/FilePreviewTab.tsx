import { FileWarning, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { languageFromPath } from "@/lib/diff/parse";
import { useReadTextFile } from "@/lib/hooks/useReadTextFile";
import { useShiki } from "@/lib/hooks/useShiki";

interface FilePreviewTabProps {
  /** Absolute repo path (e.g. /Users/rishabh/code/phasr). */
  repoPath: string;
  /** Repo-relative path (e.g. src/main.rs). */
  filePath: string;
  visible: boolean;
}

/**
 * Read-only preview of a text file. Reads via the `read_text_file`
 * Tauri command which caps at 1 MB and rejects non-UTF-8. Renders with
 * Shiki syntax highlighting (line-by-line, same approach as DiffView)
 * plus a fixed-width line-number gutter.
 */
export function FilePreviewTab({ repoPath, filePath, visible }: FilePreviewTabProps) {
  const fullPath = `${repoPath}/${filePath}`;
  const { data, error, isLoading } = useReadTextFile(visible ? fullPath : null);
  const language = useMemo(() => languageFromPath(filePath), [filePath]);
  const shiki = useShiki(language);

  const lines = useMemo(
    () => (typeof data === "string" ? data.split("\n") : null),
    [data],
  );
  const lineNumberWidth = lines ? Math.max(2, String(lines.length).length) : 2;

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
        {!isLoading && !error && lines && (
          <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.55]">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i}>
                  <td
                    className="select-none px-2 text-right align-top text-(--color-text-muted)"
                    style={{ width: `${lineNumberWidth + 2}ch` }}
                  >
                    {i + 1}
                  </td>
                  <td className="whitespace-pre-wrap break-all px-2 align-top text-(--color-text-primary)">
                    {line.length === 0 ? (
                      <span aria-hidden="true">&nbsp;</span>
                    ) : (
                      shiki.highlight(line).map((t, j) => (
                        <span
                          key={j}
                          style={
                            t.color !== "currentColor" ? { color: t.color } : undefined
                          }
                        >
                          {t.content}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
