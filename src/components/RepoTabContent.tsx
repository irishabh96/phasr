import { FilePreviewTab } from "@/components/FilePreviewTab";
import { RepoHomeContent } from "@/components/RepoHomeContent";
import { useUiStore } from "@/lib/store";
import type { Repository } from "@/lib/types";

interface RepoTabContentProps {
  repo: Repository;
}

/**
 * Renders the body of the currently-active repo inner tab. Mirrors
 * `WorkspaceTabContent` — every tab is rendered with `visible` toggling
 * `display: none` so xterm.js / Shiki / read caches don't churn on
 * tab switches.
 */
export function RepoTabContent({ repo }: RepoTabContentProps) {
  const state = useUiStore((s) => s.repoInnerTabs[repo.id]);

  if (!state) return null;

  return (
    <div className="relative min-h-0 flex-1">
      {state.tabs.map((tab) => {
        const active = tab.id === state.activeTabId;
        if (tab.kind === "home") {
          return (
            <div
              key={tab.id}
              style={{ display: active ? "block" : "none" }}
              className="absolute inset-0"
            >
              <RepoHomeContent repo={repo} />
            </div>
          );
        }
        if (tab.kind === "preview" && tab.filePath && repo.localPath) {
          return (
            <div key={tab.id} className="absolute inset-0">
              <FilePreviewTab
                repoPath={repo.localPath}
                filePath={tab.filePath}
                visible={active}
              />
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
