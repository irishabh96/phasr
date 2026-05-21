import { X } from "lucide-react";
import { useEffect } from "react";
import { FilePreviewTab } from "@/components/FilePreviewTab";
import { useUiStore } from "@/lib/store";

/**
 * Full-screen read-only file preview shown when a file is opened from
 * the file-search modal in a context with no active workspace (e.g.
 * the empty-repo state). Esc and the × button both dismiss it.
 *
 * When a workspace IS active, the file opens as an inner tab inside
 * that workspace — this overlay never mounts. See RepoFileSearchModal
 * for the routing decision.
 */
export function RepoFilePreviewOverlay() {
  const target = useUiStore((s) => s.repoFilePreview);
  const close = useUiStore((s) => s.closeRepoFilePreview);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, close]);

  if (!target) return null;

  return (
    <div className="fixed inset-0 z-[150] flex flex-col bg-(--color-bg-base)">
      <header className="flex h-[var(--layout-header-height)] shrink-0 items-center gap-3 border-b border-(--color-border-subtle) px-4">
        <code className="min-w-0 flex-1 truncate text-[12.5px] text-(--color-text-secondary)">
          {target.filePath}
        </code>
        <button
          type="button"
          onClick={close}
          aria-label="Close preview"
          title="Close preview (Esc)"
          className="flex h-7 w-7 items-center justify-center rounded text-(--color-text-muted) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
        >
          <X size={14} />
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <FilePreviewTab
          repoPath={target.repoPath}
          filePath={target.filePath}
          visible
        />
      </div>
    </div>
  );
}
