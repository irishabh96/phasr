import type { ReactNode } from "react";
import { FilePreviewTab } from "@/components/FilePreviewTab";
import { SessionTerminalTab } from "@/components/SessionTerminalTab";
import { useUiStore } from "@/lib/store";

interface RepoTabContentProps {
  repositoryId: string;
  /** Absolute repo path on disk — needed for terminals (cwd) and previews (full file path). */
  repoPath: string;
  /** Body of the default "Workspaces" tab. Rendered only while that tab is active. */
  workspacesContent: ReactNode;
}

/**
 * Renders all tabs simultaneously and toggles visibility, so terminal
 * PTYs survive switching to/from a tab. The workspaces tab is rendered
 * only when active because its body is heavy and doesn't need to be
 * kept alive in the background.
 */
export function RepoTabContent({
  repositoryId,
  repoPath,
  workspacesContent,
}: RepoTabContentProps) {
  const state = useUiStore((s) => s.repoTabs[repositoryId]);
  if (!state) return null;
  const { tabs, activeTabId } = state;

  return (
    <div className="relative min-h-0 flex-1">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        if (tab.kind === "workspaces") {
          // Heavy view — only render when active.
          if (!active) return null;
          return (
            <div key={tab.id} className="absolute inset-0 overflow-y-auto">
              {workspacesContent}
            </div>
          );
        }
        if (tab.kind === "terminal") {
          return (
            <div key={tab.id} className="absolute inset-0">
              <SessionTerminalTab
                repositoryId={repositoryId}
                tabId={tab.id}
                cwd={repoPath}
                ptySessionId={tab.ptySessionId}
                visible={active}
              />
            </div>
          );
        }
        if (tab.kind === "preview" && tab.filePath) {
          return (
            <div key={tab.id} className="absolute inset-0">
              <FilePreviewTab repoPath={repoPath} filePath={tab.filePath} visible={active} />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
