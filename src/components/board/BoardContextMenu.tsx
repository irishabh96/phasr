import { cloneElement, useState, type MouseEvent, type ReactElement } from "react";
import { WorkspaceSidebarMenu } from "@/components/WorkspaceSidebarMenu";
import type { Workspace } from "@/lib/types";

type Container = ReactElement<{ onContextMenu?: (e: MouseEvent<HTMLElement>) => void }>;

/**
 * One task context menu for the whole board (or list) instead of a Radix
 * menu per card. A right-click, or the context-menu key on a focused card,
 * finds the card under it by `data-workspace-id` and opens the shared menu
 * for that task. A right-click outside any card opens nothing.
 *
 * Per-card menus were ~6 ms of a 500-task board's first render (a Radix
 * menu tree per card) for a menu that is open at most once at a time.
 */
export function BoardContextMenu({
  workspaces,
  children,
}: {
  /** Looks a card's workspace up by id. */
  workspaces: ReadonlyMap<string, Workspace>;
  /** The board/list container; it becomes the menu trigger. */
  children: Container;
}) {
  const [targetId, setTargetId] = useState<string | null>(null);
  const shown = (targetId ? workspaces.get(targetId) : undefined) ?? workspaces.values().next().value;
  if (!shown) return children;

  // Radix's Trigger (asChild) calls the child's handler before its own, and
  // skips its own when the event is default-prevented: pick the target
  // first, or veto the menu off-card.
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>("[data-workspace-id]")?.dataset.workspaceId;
    if (!id || !workspaces.has(id)) {
      e.preventDefault();
      return;
    }
    setTargetId(id);
  };

  return <WorkspaceSidebarMenu workspace={shown}>{cloneElement(children, { onContextMenu })}</WorkspaceSidebarMenu>;
}
