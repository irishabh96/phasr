import { FileCode2, FileText, ListChecks, NotebookPen, Plus, Terminal as TerminalIcon, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { disposeSessionTerminal } from "@/components/SessionTerminalTab";
import { disposeMainTerminal } from "@/components/Terminal";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { DiffCount } from "@/components/ui/Chip";
import { Kbd } from "@/components/ui/Kbd";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { PaneTab } from "@/components/ui/PaneTab";
import { useAgents } from "@/lib/hooks/useAgents";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useRunningCommands } from "@/lib/hooks/useReview";
import { portOf } from "./Inspector";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore, type InnerTab, type SessionPane } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The 36px pane-tab strip of a task session (A-Workspace): the agent, any
 * terminals and open run commands, then the fixed Changes and Files panes.
 * Right side holds the session actions (passed in).
 */
export function SessionPaneBar({ workspace, actions }: { workspace: Workspace; actions: ReactNode }) {
  const workspaceId = workspace.id;
  const state = useUiStore((s) => s.innerTabs[workspaceId]);
  const pane = useUiStore((s) => s.sessionPane[workspaceId] ?? "tabs");
  const setPane = useUiStore((s) => s.setSessionPane);
  const setActiveInnerTab = useUiStore((s) => s.setActiveInnerTab);
  const closeInnerTab = useUiStore((s) => s.closeInnerTab);
  const openInnerTerminalTab = useUiStore((s) => s.openInnerTerminalTab);
  const runPanel = useUiStore((s) => s.runPanel);
  const { data: runCommands } = useRunCommands(workspace.repositoryId);
  const { data: changes } = useGitStatus(workspace.worktreePath ? workspaceId : null);
  const { data: agents } = useAgents();
  const { data: running } = useRunningCommands(workspace.worktreePath ? workspaceId : null);

  const tabs = state?.tabs ?? [];
  const runTabs = runPanel.openTabs
    .map((id) => runCommands?.find((rc) => rc.id === id))
    .filter((rc): rc is NonNullable<typeof rc> => !!rc);
  const adds = changes?.reduce((n, f) => n + (f.adds ?? 0), 0) ?? 0;
  const removes = changes?.reduce((n, f) => n + (f.removes ?? 0), 0) ?? 0;

  const close = (tab: InnerTab) => {
    const closed = closeInnerTab(workspaceId, tab.id);
    if (!closed) return;
    if (closed.kind === "terminal") {
      if (closed.ptySessionId) void tauri.stopSessionTerminal(closed.ptySessionId).catch(() => {});
      disposeSessionTerminal(closed.id);
    } else if (closed.kind === "main") {
      disposeMainTerminal(workspaceId);
    }
    if ((useUiStore.getState().innerTabs[workspaceId]?.tabs.length ?? 0) === 0 && pane === "tabs") {
      setPane(workspaceId, workspace.worktreePath ? "changes" : "tabs");
    }
  };

  // Arrow keys move between tabs (roving focus); activation follows focus.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const next = els[(i + (e.key === "ArrowRight" ? 1 : -1) + els.length) % els.length];
    next?.focus();
    next?.click();
  };

  const isActive = (p: SessionPane, id?: string) =>
    pane === p && (p !== "tabs" || id === state?.activeTabId) && (p !== "run" || id === runPanel.activeTab);

  return (
    <div className="flex h-(--layout-panetabs-height) shrink-0 items-stretch gap-0.5 border-b border-(--color-border-subtle) bg-(--color-bg-sidebar) px-2 pt-1">
      <div
        role="tablist"
        aria-label="Workspace tabs"
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = isActive("tabs", tab.id);
          return (
            <PaneTab
              key={tab.id}
              active={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveInnerTab(workspaceId, tab.id)}
              icon={
                tab.kind === "main" ? (
                  <AgentMark agent={workspace.agent} />
                ) : tab.kind === "preview" ? (
                  <FileCode2 className="size-3" aria-hidden />
                ) : (
                  <TerminalIcon className="size-3" aria-hidden />
                )
              }
              trailing={
                <>
                  {tab.kind === "main" && workspace.status === "running" ? (
                    <span aria-label="running" className="size-1.5 rounded-full bg-(--color-status-running)" />
                  ) : null}
                  {tab.closable ? (
                    <span
                      role="button"
                      tabIndex={-1}
                      aria-label={`Close ${tab.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        close(tab);
                      }}
                      className="-mr-1 grid size-4 place-items-center rounded-(--radius-chip) text-(--color-text-muted) opacity-0 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) group-hover/pane-tab:opacity-100"
                    >
                      <X className="size-3" aria-hidden />
                    </span>
                  ) : null}
                </>
              }
            >
              <span className="max-w-[140px] truncate">
                {tab.kind === "main" && workspace.agent ? AGENT_META[workspace.agent].label : tab.title}
              </span>
            </PaneTab>
          );
        })}
        {runTabs.map((rc) => {
          const active = isActive("run", rc.id);
          return (
            <PaneTab
              key={rc.id}
              active={active}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                runPanel.setActiveTab(rc.id);
                setPane(workspaceId, "run");
              }}
              icon={<TerminalIcon className="size-3" aria-hidden />}
              trailing={
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Close ${rc.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void tauri.stopRunCommand(rc.id, workspace.worktreePath ? workspaceId : null).catch(() => {});
                    runPanel.closeTab(rc.id);
                    if (active) setPane(workspaceId, "tabs");
                  }}
                  className="-mr-1 grid size-4 place-items-center rounded-(--radius-chip) text-(--color-text-muted) opacity-0 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) group-hover/pane-tab:opacity-100"
                >
                  <X className="size-3" aria-hidden />
                </span>
              }
            >
              {rc.name}
              {portOf(running, rc.id) ? <span className="text-(--color-text-muted)">· :{portOf(running, rc.id)}</span> : null}
            </PaneTab>
          );
        })}
        {workspace.worktreePath ? (
          <>
            <PaneTab
              active={pane === "changes"}
              tabIndex={pane === "changes" ? 0 : -1}
              onClick={() => setPane(workspaceId, "changes")}
              icon={<ListChecks className="size-3" aria-hidden />}
              trailing={changes && changes.length > 0 ? <DiffCount adds={adds} removes={removes} /> : null}
            >
              Changes
            </PaneTab>
            <PaneTab
              active={pane === "files"}
              tabIndex={pane === "files" ? 0 : -1}
              onClick={() => setPane(workspaceId, "files")}
              icon={<FileText className="size-3" aria-hidden />}
            >
              Files
            </PaneTab>
          </>
        ) : null}
        {pane === "notes" ? (
          <PaneTab active tabIndex={0} icon={<NotebookPen className="size-3" aria-hidden />}>
            Notes
          </PaneTab>
        ) : null}
      </div>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label="New pane"
            className="mb-1 grid w-7 shrink-0 place-items-center rounded-(--radius-control) text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent width={220}>
          <MenuItem
            icon={<TerminalIcon className="size-3.5" />}
            trailing={<Kbd>{SHORTCUTS.newTerminal.display.join("")}</Kbd>}
            onSelect={() => openInnerTerminalTab(workspaceId)}
          >
            {SHORTCUTS.newTerminal.label}
          </MenuItem>
          {agents && agents.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuLabel>Agent session in this worktree</MenuLabel>
              {agents.map((a) => (
                <MenuItem
                  key={a.agent}
                  icon={<AgentMark agent={a.agent} />}
                  onSelect={() => openInnerTerminalTab(workspaceId, { title: a.label, initialCommand: a.command })}
                >
                  {a.label}
                </MenuItem>
              ))}
            </>
          ) : null}
          {runCommands && runCommands.length > 0 ? (
            <>
              <MenuSeparator />
              <MenuLabel>Run command</MenuLabel>
              {runCommands.map((rc) => (
                <MenuItem
                  key={rc.id}
                  icon={<TerminalIcon className="size-3.5" />}
                  onSelect={() => {
                    runPanel.openTab(rc.id);
                    setPane(workspaceId, "run");
                  }}
                >
                  {rc.name}
                </MenuItem>
              ))}
            </>
          ) : null}
          <MenuSeparator />
          <MenuItem
            icon={<NotebookPen className="size-3.5" />}
            onSelect={() => setPane(workspaceId, "notes")}
          >
            Repository notes
          </MenuItem>
        </MenuContent>
      </Menu>
      <div className="flex-1" />
      <div className={cn("flex items-center gap-1.5 pb-1 pl-2")}>{actions}</div>
    </div>
  );
}
