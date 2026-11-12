import { useMemo } from "react";
import { useWorkspace } from "@/lib/hooks/useWorkspaces";
import { useUiStore } from "@/lib/store";
import type { MarkdownLinks } from "./Markdown";

/** File links in a task's transcript open in that task's Files pane. */
export function useMarkdownLinks(taskId: string): MarkdownLinks {
  const { data: workspace } = useWorkspace(taskId);
  const openSessionFile = useUiStore((s) => s.openSessionFile);
  const root = workspace?.worktreePath ?? null;
  return useMemo(
    () => ({ root, openFile: (path: string) => openSessionFile(taskId, path) }),
    [root, openSessionFile, taskId],
  );
}
