import { useEffect } from "react";
import { RepoInnerTabBar } from "@/components/RepoInnerTabBar";
import { RepoTabContent } from "@/components/RepoTabContent";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";
import { REPO_HOME_TAB_ID, useUiStore } from "@/lib/store";
import type { Repository } from "@/lib/types";

interface RepoHomeShellProps {
  repo: Repository;
}

/**
 * Repo home surface used by both the welcome-state empty-repo fallback
 * (`src/routes/_app/index.tsx`) and the explicit
 * `/repositories/$repositoryId` route. Owns:
 *  - seeding the inner-tab bar's "home" tab on first mount,
 *  - the local ⌘W binding that closes the active non-home tab (the
 *    global ⌘W in `_app.tsx` requires an active workspace context).
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

  useEffect(() => {
    ensureRepoInnerTabs(repo.id);
  }, [repo.id, ensureRepoInnerTabs]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
      <RepoInnerTabBar repositoryId={repo.id} />
      <RepoTabContent repo={repo} />
    </div>
  );
}
