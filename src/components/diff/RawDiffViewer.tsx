import { DiffView, type DiffViewMode } from "@/components/diff/DiffView";

export type { DiffViewMode };

export interface RawDiffViewerProps {
  /** Raw unified-diff text (output of `git diff`). */
  raw: string;
  /** Used for language detection and as the default title. */
  filePath: string;
  displayName?: string;
  className?: string;
  /** Override the persisted view mode (mainly for stories/tests). */
  initialMode?: DiffViewMode;
}

/**
 * Convenience wrapper around `DiffView` for callers that already have
 * a diff string. Used by the dev preview route and unit tests.
 */
export function RawDiffViewer({
  raw,
  filePath,
  displayName,
  className,
  initialMode,
}: RawDiffViewerProps) {
  return (
    <DiffView
      raw={raw}
      filePath={filePath}
      {...(displayName !== undefined ? { displayName } : {})}
      {...(className !== undefined ? { className } : {})}
      {...(initialMode !== undefined ? { initialMode } : {})}
    />
  );
}
