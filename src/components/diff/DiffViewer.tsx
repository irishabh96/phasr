import { DiffView, type DiffViewMode } from "@/components/diff/DiffView";
import { useGitDiff } from "@/lib/hooks/useGit";
import type { DiffScope } from "@/lib/types";

export type { DiffViewMode };

export interface DiffViewerProps {
  workspaceId: string;
  scope: DiffScope;
  filePath: string;
  /** When set, overrides the title shown in the header. */
  displayName?: string;
  /** Reserved for future task-scoped views. Currently unused. */
  taskId?: string;
  className?: string;
  /** Hide DiffView's own header (the caller draws one). */
  noHeader?: boolean;
  /** Controlled split/inline mode (the review pane owns one toggle). */
  mode?: DiffViewMode;
  onModeChange?: (m: DiffViewMode) => void;
}

/**
 * The Tauri-backed diff viewer. Fetches the diff for `filePath` at the
 * given `scope` and renders it. Intended for use in the task detail
 * pane and (eventually) the commit history view.
 */
export function DiffViewer({
  workspaceId,
  scope,
  filePath,
  displayName,
  className,
  noHeader,
  mode,
  onModeChange,
}: DiffViewerProps) {
  const { data, isLoading, error } = useGitDiff(workspaceId, scope, filePath);

  return (
    <DiffView
      raw={typeof data === "string" ? data : null}
      filePath={filePath}
      {...(displayName !== undefined ? { displayName } : {})}
      loading={isLoading}
      {...(error
        ? { errorMessage: String((error as Error).message ?? error) }
        : {})}
      {...(className !== undefined ? { className } : {})}
      {...(noHeader ? { noHeader } : {})}
      {...(mode && onModeChange ? { mode, onModeChange } : {})}
    />
  );
}
