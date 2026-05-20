import { ChevronDown, ChevronUp, Square, X } from "lucide-react";
import { RunCommandTerminal } from "@/components/RunCommandTerminal";
import { GlassButton } from "@/components/ui/GlassButton";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface RunCommandsPaneProps {
  repositoryId: string;
}

/**
 * Dockable bottom pane that hosts a tab per open run-command. The
 * panel collapses (activeTab → null) but keeps tabs around so the
 * PTY connections persist while the user works in other parts of
 * the app.
 */
export function RunCommandsPane({ repositoryId }: RunCommandsPaneProps) {
  const { data: runCommands } = useRunCommands(repositoryId);
  const runPanel = useUiStore((s) => s.runPanel);

  const openedHere = runPanel.openTabs.filter((id) =>
    runCommands?.some((rc) => rc.id === id),
  );

  if (openedHere.length === 0) return null;

  const collapsed = runPanel.activeTab === null;

  return (
    <div
      className="flex shrink-0 flex-col border-t border-(--glass-border-hairline) bg-(--color-bg-surface)"
      style={{ height: collapsed ? 36 : 280 }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {openedHere.map((id) => {
            const rc = runCommands?.find((r) => r.id === id);
            if (!rc) return null;
            const isActive = runPanel.activeTab === id;
            return (
              <div
                key={id}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-0.5 rounded-full pl-2.5 pr-1",
                  "text-[12px] leading-none",
                  "transition-colors duration-150",
                  isActive
                    ? "bg-[color-mix(in_oklab,var(--color-accent-500)_18%,transparent)] text-(--color-text-primary)"
                    : "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
                )}
              >
                <button
                  type="button"
                  onClick={() => runPanel.setActiveTab(id)}
                  className="flex items-center gap-1.5"
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      isActive ? "bg-(--color-accent-500)" : "bg-(--color-text-muted)",
                    )}
                  />
                  {rc.name}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void tauri.stopRunCommand(id).catch(() => {});
                    runPanel.closeTab(id);
                  }}
                  title="Stop and close"
                  aria-label={`Close ${rc.name}`}
                  className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-(--color-text-muted) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-1 pl-1">
          {!collapsed && runPanel.activeTab && (
            <GlassButton
              variant="danger"
              size="sm"
              onClick={() => void tauri.stopRunCommand(runPanel.activeTab!).catch(() => {})}
              title="Send SIGTERM"
              className="h-6"
            >
              <Square size={9} fill="currentColor" />
              Stop
            </GlassButton>
          )}
          <GlassButton
            variant="ghost"
            size="icon"
            onClick={() => (collapsed ? runPanel.showPanel() : runPanel.hidePanel())}
            title={collapsed ? "Expand pane" : "Collapse pane"}
            className="h-6 w-6"
          >
            {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </GlassButton>
        </div>
      </div>

      {!collapsed && (
        <div className="relative min-h-0 flex-1 border-t border-(--glass-border-hairline)">
          {openedHere.map((id) => (
            <div
              key={id}
              className="absolute inset-0"
              style={{ display: runPanel.activeTab === id ? "block" : "none" }}
            >
              <RunCommandTerminal runCommandId={id} visible={runPanel.activeTab === id} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
