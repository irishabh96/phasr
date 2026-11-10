import type { InnerTabState, SessionPane } from "@/lib/store";

/**
 * Whether a task's agent pane — its agent ("main") tab, in front — is what
 * the session shows. The approval card lives only there: on a shell tab,
 * a run tab, Changes, Files or Notes it would be answering a dialog you
 * can't see, so those panes get a "needs you" mark on the agent tab instead.
 *
 * Before the session seeds its tabs (`ensureInnerTabs`) the agent tab is
 * what it will open on, so no tab state reads as the agent pane.
 */
export function isAgentPaneActive(
  state: { sessionPane: Record<string, SessionPane>; innerTabs: Record<string, InnerTabState | undefined> },
  taskId: string,
): boolean {
  if ((state.sessionPane[taskId] ?? "tabs") !== "tabs") return false;
  const inner = state.innerTabs[taskId];
  if (!inner) return true;
  return inner.tabs.find((t) => t.id === inner.activeTabId)?.kind === "main";
}
