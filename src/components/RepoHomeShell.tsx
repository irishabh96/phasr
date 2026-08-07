import { Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { NotesPanel } from "@/components/NotesPanel";
import { RepoInnerTabBar } from "@/components/RepoInnerTabBar";
import { RepoTabContent } from "@/components/RepoTabContent";
import { GlassButton } from "@/components/ui/GlassButton";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { PanelTab, PanelTabBar } from "@/components/ui/PanelTabs";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useNotes } from "@/lib/hooks/useNotes";
import { originFromRepoHome } from "@/lib/noteProvenance";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import {
  REPO_HOME_TAB_ID,
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  useUiStore,
} from "@/lib/store";
import type { Repository } from "@/lib/types";
import { cn } from "@/lib/utils";

interface RepoHomeShellProps {
  repo: Repository;
}

/**
 * Repo home surface used by both the welcome-state empty-repo fallback
 * (`src/routes/_app/index.tsx`) and the explicit
 * `/repositories/$repositoryId` route. Owns:
 *  - seeding the inner-tab bar's "home" tab on first mount,
 *  - the local ⌘W binding that closes the active non-home tab (the
 *    global ⌘W in `_app.tsx` requires an active workspace context),
 *  - the local ⌘⇧N binding + right rail hosting the repository Notes
 *    panel (the workspace rail's counterpart; shares the width store).
 *
 * Stateless beyond the tab system itself; passes `repo` straight to
 * the tab bar + content router.
 */
export function RepoHomeShell({ repo }: RepoHomeShellProps) {
  const ensureRepoInnerTabs = useUiStore((s) => s.ensureRepoInnerTabs);
  const closeRepoInnerTab = useUiStore((s) => s.closeRepoInnerTab);
  const activeTabId = useUiStore(
    (s) => s.repoInnerTabs[repo.id]?.activeTabId ?? null,
  );
  const railCollapsed = useUiStore((s) => s.repoRailCollapsed);
  const setRailCollapsed = useUiStore((s) => s.setRepoRailCollapsed);
  const railWidth = useUiStore((s) => s.rightPanelWidth);
  const setRailWidth = useUiStore((s) => s.setRightPanelWidth);
  const { data: notes } = useNotes(repo.id);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    ensureRepoInnerTabs(repo.id);
  }, [repo.id, ensureRepoInnerTabs]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchShortcut(e, SHORTCUTS.openNotes)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const s = useUiStore.getState();
        s.setRepoRailCollapsed(false);
        s.openNotesComposer();
        return;
      }
      if (!matchShortcut(e, SHORTCUTS.closeActiveTab)) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      if (!activeTabId || activeTabId === REPO_HOME_TAB_ID) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeRepoInnerTab(repo.id, activeTabId);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeTabId, closeRepoInnerTab, repo.id]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RepoInnerTabBar
        repositoryId={repo.id}
        onOpenNotes={() => {
          const s = useUiStore.getState();
          s.setRepoRailCollapsed(!railCollapsed);
        }}
      />
      <div className="flex min-h-0 flex-1">
        <RepoTabContent repo={repo} />
        <aside
          aria-hidden={railCollapsed}
          aria-label="Repository notes"
          style={railCollapsed ? undefined : { width: railWidth }}
          className={cn(
            "relative flex h-full shrink-0 flex-col overflow-hidden border-l border-(--glass-border-hairline) bg-(--color-bg-surface)",
            !resizing &&
              "transition-[width] duration-[220ms] [transition-timing-function:var(--ease-glass)]",
            railCollapsed && "w-0 border-l-0",
          )}
        >
          {!railCollapsed && (
            <ResizeHandle
              edge="left"
              width={railWidth}
              min={RIGHT_PANEL_WIDTH_MIN}
              max={RIGHT_PANEL_WIDTH_MAX}
              onResize={setRailWidth}
              onResizeStart={() => setResizing(true)}
              onResizeEnd={() => setResizing(false)}
            />
          )}
          <div
            className="flex h-full flex-col"
            style={{ width: railWidth, minWidth: railWidth }}
          >
            <PanelTabBar
              actions={
                <GlassTooltip
                  content={`New note (${SHORTCUTS.openNotes.display.join("")})`}
                  side="bottom"
                >
                  <GlassButton
                    variant="ghost"
                    size="icon"
                    aria-label="New note"
                    onClick={() => useUiStore.getState().openNotesComposer()}
                  >
                    <Plus size={14} />
                  </GlassButton>
                </GlassTooltip>
              }
            >
              <PanelTab
                label="Notes"
                count={notes?.filter((n) => !n.doneAt).length ?? 0}
                active
                onClick={() => setRailCollapsed(true)}
              />
            </PanelTabBar>
            <div className="min-h-0 flex-1">
              <NotesPanel
                repositoryId={repo.id}
                getOrigin={() => {
                  const inner = useUiStore.getState().repoInnerTabs[repo.id];
                  const active = inner?.tabs.find(
                    (t) => t.id === inner.activeTabId,
                  );
                  return originFromRepoHome(active);
                }}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
