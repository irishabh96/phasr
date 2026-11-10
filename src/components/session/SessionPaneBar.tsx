import { FileCode2, NotebookPen, PanelRight, Plus, Settings2, Terminal as TerminalIcon, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { disposeSessionTerminal } from "@/components/SessionTerminalTab";
import { useSettingsRoute } from "@/components/settings/useSettingsRoute";
import { disposeMainTerminal } from "@/components/Terminal";
import { AGENT_META, AgentMark } from "@/components/ui/AgentMark";
import { GlassTooltip } from "@/components/ui/GlassTooltip";
import { Kbd } from "@/components/ui/Kbd";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { PaneTab } from "@/components/ui/PaneTab";
import { useAgents } from "@/lib/hooks/useAgents";
import { useTaskAgentState } from "@/lib/hooks/useAgentSignals";
import { useGitStatus } from "@/lib/hooks/useGit";
import { useRunCommands } from "@/lib/hooks/useRunCommands";
import { useRunningCommands } from "@/lib/hooks/useReview";
import { isRunning, portOf } from "./Inspector";
import { activeRunTabFor, runTabsForTask, runTarget } from "@/lib/runScope";
import { SHORTCUTS } from "@/lib/shortcuts";
import { useUiStore, type InnerTab, type SessionPane } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import type { Workspace } from "@/lib/types";
import { cn } from "@/lib/utils";

// Overlaid on the tab's right edge (on the bar's bg so it masks the label
// end), so a closable tab is as wide as the design draws it: the X takes no
// room until hover. ⌘W closes from the keyboard.
const closeGlyph =
  "absolute right-[2px] top-1/2 grid size-[16px] -translate-y-1/2 place-items-center rounded-(--radius-chip) bg-(--color-bg-base) text-(--color-text-muted) opacity-0 shadow-[-6px_0_6px_var(--color-bg-base)] hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) group-hover/pane-tab:opacity-100";

/** A-Workspace tab box: 0 10px, 8px gap (explicit px: 1rem is 13px here). */
const tabBox = "gap-[8px] px-[10px]";

/**
 * On the agent tab while another pane is in front: the agent is paused on
 * a dialog whose card only shows on its own pane. The tab is the button
 * that goes there.
 */
function NeedsYouMark() {
  return (
    <span
      data-needs-you
      className="flex shrink-0 items-center gap-[5px] text-[11px] font-medium text-(--color-status-attention)"
    >
      <span aria-hidden className="size-[6px] rounded-full" style={{ background: "var(--color-status-attention)" }} />
      needs you
    </span>
  );
}

/** 28px ghost icon button used on the bar (+, inspector toggle). */
const iconButton =
  "grid size-[28px] shrink-0 place-items-center self-center rounded-(--radius-control) text-(--color-text-muted) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus) data-[state=open]:bg-(--color-bg-elevated) data-[state=open]:text-(--color-text-primary)";

/**
 * The inspector toggle at the end of the session bar (⌘I). Its name swaps
 * with the state, like the control it replaces in the inspector's header.
 */
export function InspectorToggle() {
  const collapsed = useUiStore((s) => s.rightPanelCollapsed);
  const toggle = useUiStore((s) => s.toggleRightPanel);
  const keys = SHORTCUTS.toggleRightPanel.display.join("");
  return (
    <GlassTooltip content={`${collapsed ? "Show" : "Hide"} inspector (${keys})`} side="bottom">
      <button
        type="button"
        aria-label={collapsed ? "Show inspector" : "Collapse inspector"}
        aria-keyshortcuts="Meta+I"
        onClick={toggle}
        className={iconButton}
      >
        <PanelRight className="size-[14px]" aria-hidden />
      </button>
    </GlassTooltip>
  );
}

/**
 * The 44px pane-tab strip of a task session (A-Workspace): underline tabs
 * for the agent, any terminals and open run commands, then Changes and
 * Files, then `+` (new terminal / agent session / run command / notes).
 * The right side holds the session actions (passed in).
 */
export function SessionPaneBar({ workspace, actions }: { workspace: Workspace; actions: ReactNode }) {
  const workspaceId = workspace.id;
  const state = useUiStore((s) => s.innerTabs[workspaceId]);
  const pane = useUiStore((s) => s.sessionPane[workspaceId] ?? "tabs");
  const setPane = useUiStore((s) => s.setSessionPane);
  const setActiveInnerTab = useUiStore((s) => s.setActiveInnerTab);
  const closeInnerTab = useUiStore((s) => s.closeInnerTab);
  const openInnerTerminalTab = useUiStore((s) => s.openInnerTerminalTab);
  const openInnerAgentTab = useUiStore((s) => s.openInnerAgentTab);
  const runPanel = useUiStore((s) => s.runPanel);
  const agentState = useTaskAgentState(workspaceId);
  const needsYou = agentState?.state === "needs-you" && !!agentState.attention;
  const { data: runCommands } = useRunCommands(workspace.repositoryId);
  const { data: changes } = useGitStatus(workspace.worktreePath ? workspaceId : null);
  const { data: agents } = useAgents();
  const settingsRoute = useSettingsRoute();
  const target = runTarget(workspace);
  const { data: running } = useRunningCommands(target);

  const tabs = state?.tabs ?? [];
  const runTabIds = runTabsForTask(runPanel.openTabs, runPanel.shown, running, workspaceId, target).filter((id) =>
    runCommands?.some((rc) => rc.id === id),
  );
  const activeRunTab = activeRunTabFor(runPanel.activeTab, runTabIds);
  const runTabs = runTabIds
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
    pane === p && (p !== "tabs" || id === state?.activeTabId) && (p !== "run" || id === activeRunTab);

  return (
    <div className="flex h-(--layout-panetabs-height) shrink-0 items-stretch gap-[4px] border-b border-(--color-border-subtle) bg-(--color-bg-base) px-[12px]">
      <div
        role="tablist"
        aria-label="Workspace tabs"
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-stretch gap-[4px] overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = isActive("tabs", tab.id);
          return (
            <PaneTab
              className={tabBox}
              key={tab.id}
              active={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveInnerTab(workspaceId, tab.id)}
              icon={
                tab.kind === "main" ? (
                  <AgentMark agent={workspace.agent} className="size-[14px] text-[8px]" />
                ) : tab.kind === "preview" ? (
                  <FileCode2 className="size-[14px] text-(--color-text-muted)" aria-hidden />
                ) : (
                  <TerminalIcon className="size-[14px] text-(--color-text-muted)" aria-hidden />
                )
              }
              trailing={
                tab.closable ? (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Close ${tab.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      close(tab);
                    }}
                    className={closeGlyph}
                  >
                    <X className="size-[12px]" aria-hidden />
                  </span>
                ) : null
              }
            >
              <span className="max-w-[140px] truncate">
                {tab.kind === "main" && workspace.agent ? AGENT_META[workspace.agent].label : tab.title}
              </span>
              {tab.kind === "main" && needsYou && !active ? <NeedsYouMark /> : null}
            </PaneTab>
          );
        })}
        {needsYou && !tabs.some((t) => t.kind === "main") ? (
          // The agent tab was closed while the agent waits: a stand-in that
          // reopens it (on the agent's live terminal), card and all.
          <PaneTab
            className={tabBox}
            active={false}
            tabIndex={-1}
            onClick={() => openInnerAgentTab(workspaceId, workspace.command || workspace.name || "Main")}
            icon={<AgentMark agent={workspace.agent} className="size-[14px] text-[8px]" />}
          >
            <span className="max-w-[140px] truncate">
              {workspace.agent ? AGENT_META[workspace.agent].label : "Agent"}
            </span>
            <NeedsYouMark />
          </PaneTab>
        ) : null}
        {runTabs.map((rc) => {
          const active = isActive("run", rc.id);
          const live = isRunning(running, rc.id);
          const port = portOf(running, rc.id);
          return (
            <PaneTab
              className={tabBox}
              key={rc.id}
              active={active}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                runPanel.setActiveTab(rc.id);
                setPane(workspaceId, "run");
              }}
              icon={
                <span
                  aria-hidden
                  className={cn(
                    "size-[6px] shrink-0 rounded-full",
                    live ? "bg-(--color-success)" : "bg-(--color-text-faint)",
                  )}
                />
              }
              trailing={
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Close ${rc.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void tauri.stopRunCommand(rc.id, target).catch(() => {});
                    runPanel.closeTab(rc.id, workspaceId);
                    if (active) setPane(workspaceId, "tabs");
                  }}
                  className={closeGlyph}
                >
                  <X className="size-[12px]" aria-hidden />
                </span>
              }
            >
              {rc.name}
              {port ? <span className="font-normal text-(--color-text-muted)">:{port}</span> : null}
            </PaneTab>
          );
        })}
        {workspace.worktreePath ? (
          <>
            <PaneTab
              className={tabBox}
              active={pane === "changes"}
              tabIndex={pane === "changes" ? 0 : -1}
              onClick={() => setPane(workspaceId, "changes")}
              trailing={
                changes && changes.length > 0 ? (
                  <span className="whitespace-nowrap font-mono text-[11px] font-normal text-(--color-text-muted)">
                    +{adds} −{removes}
                  </span>
                ) : null
              }
            >
              Changes
            </PaneTab>
            <PaneTab
              className={tabBox}
              active={pane === "files"}
              tabIndex={pane === "files" ? 0 : -1}
              onClick={() => setPane(workspaceId, "files")}
            >
              Files
            </PaneTab>
          </>
        ) : null}
        {pane === "notes" ? (
          <PaneTab active tabIndex={0} className={tabBox}>
            Notes
          </PaneTab>
        ) : null}
      </div>
      <Menu>
        <GlassTooltip content={`New pane (${SHORTCUTS.newTerminal.display.join("")} for a terminal)`} side="bottom">
          <MenuTrigger asChild>
            <button type="button" aria-label="New pane" className={iconButton}>
              <Plus className="size-[14px]" aria-hidden />
            </button>
          </MenuTrigger>
        </GlassTooltip>
        <MenuContent width={240}>
          <MenuItem
            icon={<TerminalIcon className="size-[14px]" />}
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
                  icon={<AgentMark agent={a.agent} className="size-[14px] text-[8px]" />}
                  onSelect={() => openInnerTerminalTab(workspaceId, { title: a.label, initialCommand: a.command })}
                >
                  {a.label}
                </MenuItem>
              ))}
            </>
          ) : null}
          {/* "Run ▾" used to be its own button on the bar. */}
          <MenuSeparator />
          <MenuLabel>Run command</MenuLabel>
          {(runCommands ?? []).map((rc) => (
            <MenuItem
              key={rc.id}
              icon={
                <span
                  className={cn(
                    "size-[6px] rounded-full",
                    isRunning(running, rc.id) ? "bg-(--color-success)" : "bg-(--color-text-faint)",
                  )}
                />
              }
              trailing={
                <code className="max-w-[110px] truncate font-mono text-[11px] text-(--color-text-muted)">{rc.command}</code>
              }
              onSelect={() => runPanel.openTab(rc.id, workspaceId)}
            >
              {rc.name}
            </MenuItem>
          ))}
          <MenuItem
            icon={<Settings2 className="size-[14px]" />}
            onSelect={() => settingsRoute.open("run-commands", { repositoryId: workspace.repositoryId })}
          >
            {runCommands && runCommands.length > 0 ? "Edit run commands…" : "Add run command…"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<NotebookPen className="size-[14px]" />} onSelect={() => setPane(workspaceId, "notes")}>
            Repository notes
          </MenuItem>
        </MenuContent>
      </Menu>
      <div className="flex-1" />
      <div className="flex items-center gap-[4px] pl-[8px]">{actions}</div>
    </div>
  );
}
