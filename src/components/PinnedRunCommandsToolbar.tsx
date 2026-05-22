import { Play } from "lucide-react";
import { useMemo } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useUiStore } from "@/lib/store";

interface PinnedRunCommandsToolbarProps {
  repositoryId: string;
  /** Max pills to render inline. Overflow stays in the Run ▾ dropdown. */
  max?: number;
}

/**
 * Workspace-header strip of pinned run commands. Each pill dispatches
 * the same `runPanel.openTab(id)` action the Run dropdown uses, so a
 * click on `[▶ Dev ⌘1]` opens the Dev command in the bottom pane.
 *
 * The ⌘1..⌘9 chip is informational — the actual dispatch comes from a
 * global keydown listener in the workspace route. See
 * `routes/_app/repositories/$repositoryId/workspaces/$workspaceId.tsx`.
 */
export function PinnedRunCommandsToolbar({
  repositoryId,
  max = 5,
}: PinnedRunCommandsToolbarProps) {
  const { data: runCommands } = useRunCommands(repositoryId);
  const runPanel = useUiStore((s) => s.runPanel);

  const pinned = useMemo(
    () =>
      [...(runCommands ?? [])]
        .filter((c) => c.pinned)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .slice(0, max),
    [runCommands, max],
  );

  if (pinned.length === 0) return null;

  return (
    <div className="flex shrink-0 items-center gap-1">
      {pinned.map((rc, i) => (
        <GlassButton
          key={rc.id}
          variant="ghost"
          size="sm"
          onClick={() => runPanel.openTab(rc.id)}
          title={`Run ${rc.name} (⌘${i + 1})`}
          className="gap-1.5"
        >
          <Play size={10} fill="currentColor" />
          <span className="truncate max-w-[100px]">{rc.name}</span>
          {i < 9 && (
            <kbd className="rounded border border-(--glass-border-hairline) bg-(--color-bg-elevated) px-1 py-0.5 font-mono text-[9.5px] text-(--color-text-muted)">
              ⌘{i + 1}
            </kbd>
          )}
        </GlassButton>
      ))}
    </div>
  );
}
