import { ChangesPanel } from "@/components/ChangesPanel";
import { HistoryPanel } from "@/components/HistoryPanel";
import { GroupHeader } from "@/components/ui/GroupHeader";

/**
 * Changes pane tab (A-Review). Working-tree changes with stage / commit /
 * push on the left, the branch's commits on the right.
 */
export function ChangesPane({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-h-0 flex-col">
        <ChangesPanel workspaceId={workspaceId} />
      </div>
      <section aria-label="Commits" className="flex min-h-0 flex-col border-l border-(--color-border-subtle) bg-(--color-bg-sidebar)">
        <GroupHeader as="h2" className="px-3.5 pb-1 pt-3">
          Commits
        </GroupHeader>
        <div className="min-h-0 flex-1">
          <HistoryPanel workspaceId={workspaceId} />
        </div>
      </section>
    </div>
  );
}
