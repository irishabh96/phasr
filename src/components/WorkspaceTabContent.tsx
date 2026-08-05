import { Plus, Zap } from "lucide-react";
import { FilePreviewTab } from "@/components/FilePreviewTab";
import { SessionTerminalTab } from "@/components/SessionTerminalTab";
import { Terminal } from "@/components/Terminal";
import { GlassButton } from "@/components/ui/GlassButton";
import { useUiStore } from "@/lib/store";
import type { Workspace } from "@/lib/types";

interface WorkspaceTabContentProps {
  workspaceId: string;
  workspace: Workspace;
  onMainExit?: (exitCode: number | null) => void;
}

/**
 * Renders all inner tabs simultaneously and toggles visibility — so
 * terminal PTYs (both the main workspace process and any opened
 * session shells) survive switching to/from a tab.
 *
 * Kind dispatch:
 *  - "main"     → <Terminal> bound to the workspace's primary PTY
 *  - "terminal" → <SessionTerminalTab> (ad-hoc shell with worktree as cwd)
 *  - "preview"  → <FilePreviewTab> (read-only file viewer)
 *
 * If the user closes every tab, an empty state offers the two ways
 * to re-populate the workspace area.
 */
export function WorkspaceTabContent({
  workspaceId,
  workspace,
  onMainExit,
}: WorkspaceTabContentProps) {
  const state = useUiStore((s) => s.innerTabs[workspaceId]);
  const openInnerAgentTab = useUiStore((s) => s.openInnerAgentTab);
  const openInnerTerminalTab = useUiStore((s) => s.openInnerTerminalTab);

  const tabs = state?.tabs ?? [];
  const activeTabId = state?.activeTabId ?? null;
  const worktreePath = workspace.worktreePath ?? "";

  if (tabs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-[13px] text-(--color-text-muted)">
            No tabs open in this workspace
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <GlassButton
              variant="primary"
              size="md"
              onClick={() =>
                openInnerAgentTab(
                  workspaceId,
                  workspace.command || workspace.name || "Agent",
                )
              }
            >
              <Zap size={13} />
              Open agent
            </GlassButton>
            <GlassButton
              variant="outline"
              size="md"
              onClick={() => openInnerTerminalTab(workspaceId)}
            >
              <Plus size={13} />
              New terminal
            </GlassButton>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        if (tab.kind === "main") {
          return (
            <div key={tab.id} className="absolute inset-0">
              <Terminal
                workspaceId={workspaceId}
                status={workspace.status}
                visible={active}
                cwd={worktreePath}
                {...(onMainExit ? { onExit: onMainExit } : {})}
              />
            </div>
          );
        }
        if (tab.kind === "terminal") {
          return (
            <div key={tab.id} className="absolute inset-0">
              <SessionTerminalTab
                workspaceId={workspaceId}
                tabId={tab.id}
                cwd={worktreePath}
                ptySessionId={tab.ptySessionId}
                visible={active}
                {...(tab.initialCommand
                  ? { initialCommand: tab.initialCommand }
                  : {})}
              />
            </div>
          );
        }
        if (tab.kind === "preview" && tab.filePath) {
          return (
            <div key={tab.id} className="absolute inset-0">
              <FilePreviewTab
                repoPath={worktreePath}
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
