import { FileCode2, FolderTree, Terminal as TerminalIcon, X } from "lucide-react";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { RepoTab } from "@/lib/store";

interface RepoTabBarProps {
  repositoryId: string;
}

export function RepoTabBar({ repositoryId }: RepoTabBarProps) {
  const state = useUiStore((s) => s.repoTabs[repositoryId]);
  const setActiveRepoTab = useUiStore((s) => s.setActiveRepoTab);
  const closeRepoTab = useUiStore((s) => s.closeRepoTab);

  if (!state) return null;
  const { tabs, activeTabId } = state;
  if (tabs.length === 0) return null;

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-(--color-border-subtle) bg-(--color-bg-base) p-1">
      {tabs.map((tab) => (
        <TabPill
          key={tab.id}
          tab={tab}
          active={tab.id === activeTabId}
          onActivate={() => setActiveRepoTab(repositoryId, tab.id)}
          onClose={() => {
            const closed = closeRepoTab(repositoryId, tab.id);
            if (closed?.kind === "terminal" && closed.ptySessionId) {
              void tauri.stopSessionTerminal(closed.ptySessionId).catch(() => {});
            }
          }}
        />
      ))}
    </div>
  );
}

function TabPill({
  tab,
  active,
  onActivate,
  onClose,
}: {
  tab: RepoTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "group/tab flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] pl-3.5 pr-1.5",
        "text-[13px] font-medium leading-none",
        "transition-colors duration-150",
        active
          ? "bg-(--color-bg-elevated) text-(--color-text-primary)"
          : "text-(--color-text-secondary) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
      )}
    >
      <button type="button" onClick={onActivate} className="flex items-center gap-1.5 outline-none">
        <TabIcon kind={tab.kind} active={active} />
        <span className="max-w-[180px] truncate">{tab.title}</span>
      </button>
      {tab.closable && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          title={`Close ${tab.title}`}
          aria-label={`Close ${tab.title}`}
          className="ml-0.5 flex h-5 w-5 items-center justify-center rounded-full text-(--color-text-muted) transition-colors hover:bg-[color-mix(in_oklab,white_10%,transparent)] hover:text-(--color-text-primary)"
        >
          <X size={11} />
        </button>
      )}
    </div>
  );
}

function TabIcon({ kind, active }: { kind: RepoTab["kind"]; active: boolean }) {
  const cls = active ? "text-(--color-accent-400)" : "text-(--color-text-muted)";
  if (kind === "terminal") return <TerminalIcon size={11} className={cls} />;
  if (kind === "preview") return <FileCode2 size={11} className={cls} />;
  return <FolderTree size={11} className={cls} />;
}
