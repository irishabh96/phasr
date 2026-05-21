import { FileCode2, Plus, Terminal as TerminalIcon, X, Zap } from "lucide-react";
import { disposeMainXterm } from "@/components/Terminal";
import { disposeSessionXterm } from "@/components/SessionTerminalTab";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { InnerTab } from "@/lib/store";

interface WorkspaceInnerTabBarProps {
  workspaceId: string;
}

/**
 * Per-workspace tab strip embedded in the workspace header row between
 * the workspace name (left) and the action buttons (right).
 *
 * Inner tabs are user-managed:
 *  - "main" / agent — the workspace's primary process; closable. The agent
 *    PTY keeps running on the backend even when the tab is closed.
 *    Re-open via the empty-state CTA when no tabs remain.
 *  - "terminal" — ad-hoc shells (the "+" button to the right of the strip).
 *  - "preview" — file viewer (no UI to open today; ⌘P search opens one).
 */
export function WorkspaceInnerTabBar({ workspaceId }: WorkspaceInnerTabBarProps) {
  const state = useUiStore((s) => s.innerTabs[workspaceId]);
  const setActiveInnerTab = useUiStore((s) => s.setActiveInnerTab);
  const closeInnerTab = useUiStore((s) => s.closeInnerTab);
  const openInnerTerminalTab = useUiStore((s) => s.openInnerTerminalTab);

  if (!state) return null;
  const { tabs, activeTabId } = state;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {tabs.map((tab) => (
        <TabPill
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          onActivate={() => setActiveInnerTab(workspaceId, tab.id)}
          onClose={() => {
            const closed = closeInnerTab(workspaceId, tab.id);
            if (!closed) return;
            if (closed.kind === "terminal") {
              if (closed.ptySessionId) {
                void tauri.stopSessionTerminal(closed.ptySessionId).catch(() => {});
              }
              disposeSessionXterm(closed.id);
            } else if (closed.kind === "main") {
              disposeMainXterm(workspaceId);
            }
          }}
        />
      ))}
      <GlassTooltip
        content={`${SHORTCUTS.newTerminal.label} (${SHORTCUTS.newTerminal.display.join("")})`}
        side="bottom"
      >
        <button
          type="button"
          aria-label={SHORTCUTS.newTerminal.label}
          onClick={() => openInnerTerminalTab(workspaceId)}
          className="ml-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-(--color-text-muted) transition-colors duration-150 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
        >
          <Plus size={13} />
        </button>
      </GlassTooltip>
    </div>
  );
}

function TabPill({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: InnerTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group/tab flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] pl-2.5 pr-1.5",
        "text-[12.5px] font-medium leading-none",
        "transition-colors duration-150",
        active
          ? "bg-(--color-bg-elevated) text-(--color-text-primary)"
          : "text-(--color-text-secondary) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
      )}
    >
      <button type="button" onClick={onActivate} className="flex items-center gap-1.5 outline-none">
        <TabIcon kind={tab.kind} active={active} />
        <span className="max-w-[140px] truncate">{tab.title}</span>
      </button>
      {tab.closable && (
        <GlassTooltip content={`Close ${tab.title}`} side="bottom">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            aria-label={`Close ${tab.title}`}
            className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-(--color-text-muted) transition-colors hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)"
          >
            <X size={11} />
          </button>
        </GlassTooltip>
      )}
    </div>
  );
}

function TabIcon({ kind, active }: { kind: InnerTab["kind"]; active: boolean }) {
  const cls = active ? "text-(--color-accent-400)" : "text-(--color-text-muted)";
  if (kind === "terminal") return <TerminalIcon size={11} className={cls} />;
  if (kind === "preview") return <FileCode2 size={11} className={cls} />;
  return <Zap size={11} className={cls} />;
}
