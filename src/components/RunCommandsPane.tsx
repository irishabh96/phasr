import { ChevronDown, ChevronUp, Square, X } from "lucide-react";
import { RunCommandTerminal } from "@/components/RunCommandTerminal";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";

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
      className="flex shrink-0 flex-col border-t border-(--color-border-subtle) bg-(--color-bg-surface)"
      style={{ height: collapsed ? 36 : 280 }}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-(--color-border-subtle) px-2">
        {openedHere.map((id) => {
          const rc = runCommands?.find((r) => r.id === id);
          if (!rc) return null;
          const isActive = runPanel.activeTab === id;
          return (
            <div
              key={id}
              className="flex items-center rounded-md text-xs"
              style={{
                background: isActive ? "var(--color-bg-input)" : "transparent",
                color: isActive ? "var(--color-text-primary)" : "var(--color-text-secondary)",
              }}
            >
              <button
                type="button"
                onClick={() => runPanel.setActiveTab(id)}
                className="py-1.5 pl-3 pr-2"
              >
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
                className="mr-1 flex h-6 w-6 items-center justify-center rounded text-(--color-text-muted) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}

        <div className="ml-auto flex items-center gap-1">
          {!collapsed && runPanel.activeTab && (
            <button
              type="button"
              onClick={() =>
                void tauri.stopRunCommand(runPanel.activeTab!).catch(() => {})
              }
              title="Send SIGTERM"
              className="flex items-center gap-1 rounded-md border border-(--color-danger) bg-(--color-danger)/15 px-2 py-0.5 text-[10px] text-(--color-danger) hover:bg-(--color-danger)/25"
            >
              <Square size={9} fill="currentColor" />
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={() => (collapsed ? runPanel.showPanel() : runPanel.hidePanel())}
            title={collapsed ? "Expand pane" : "Collapse pane"}
            className="rounded-md border border-(--color-border-default) p-1 text-(--color-text-secondary) hover:border-(--color-border-strong) hover:text-(--color-text-primary)"
          >
            {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="relative min-h-0 flex-1">
          {openedHere.map((id) => (
            <div
              key={id}
              className="absolute inset-0"
              style={{ display: runPanel.activeTab === id ? "block" : "none" }}
            >
              <RunCommandTerminal
                runCommandId={id}
                visible={runPanel.activeTab === id}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
