import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { applyTheme, readStoredTheme, writeStoredTheme, type Theme } from "./theme";

// ---------- Active workspace context ----------

/**
 * The workspace currently shown in the main area. Set by the workspace
 * page on mount, cleared on unmount. Read by global keydown handlers
 * (⌘T / ⌘N / ⌘W / ⌘P) that can't reach React route params.
 */
export interface ActiveWorkspaceContext {
  workspaceId: string;
  repositoryId: string;
}

// ---------- Per-workspace inner tab strip ----------

export type InnerTabKind = "main" | "terminal" | "preview";

export interface InnerTab {
  id: string;
  kind: InnerTabKind;
  title: string;
  closable: boolean;
  /** Terminal — backend session uuid. Set after `start_session_terminal` returns. */
  ptySessionId?: string;
  /** Preview — repo-relative file path. */
  filePath?: string;
}

export interface InnerTabState {
  /** First entry is always the pinned "main" tab. */
  tabs: InnerTab[];
  activeTabId: string;
}

// ---------- Run-command bottom pane ----------

interface RunPanelState {
  /** ordered list of currently-open run command ids */
  openTabs: string[];
  /** which tab is in focus; null if the panel is closed */
  activeTab: string | null;
  /** open the run-command tab (and focus it) */
  openTab(id: string): void;
  /** close one tab (also moves focus or hides the pane) */
  closeTab(id: string): void;
  /** focus an already-open tab */
  setActiveTab(id: string): void;
  /** hide the panel without losing tabs */
  hidePanel(): void;
  /** show the panel and focus the first tab if none is active */
  showPanel(): void;
}

export type SidebarMode = "collapsed" | "pinned" | "hidden";

const SIDEBAR_KEY = "phasr.sidebar";
const RIGHT_PANEL_KEY = "phasr.rightPanel";

function readSidebar(): SidebarMode {
  if (typeof window === "undefined") return "collapsed";
  const v = window.localStorage.getItem(SIDEBAR_KEY);
  return v === "pinned" || v === "hidden" ? v : "collapsed";
}

function readRightPanel(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(RIGHT_PANEL_KEY) === "collapsed";
}

interface UiState {
  theme: Theme;
  setTheme: (theme: Theme) => void;

  sidebarMode: SidebarMode;
  setSidebarMode: (mode: SidebarMode) => void;
  toggleSidebarPin: () => void;
  toggleSidebarHidden: () => void;

  rightPanelCollapsed: boolean;
  toggleRightPanel: () => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;

  /** New-project wizard modal — single instance mounted at the app shell. */
  newProjectModalOpen: boolean;
  openNewProjectModal: () => void;
  closeNewProjectModal: () => void;

  /** Existing-project ("Open existing") modal — same shell-mounted pattern. */
  openExistingModalOpen: boolean;
  openOpenExistingModal: () => void;
  closeOpenExistingModal: () => void;

  /** Repo file-search modal — non-null target means open + scoped to that repo. */
  fileSearchTarget: { repositoryId: string; path: string } | null;
  openFileSearch: (repositoryId: string, path: string) => void;
  closeFileSearch: () => void;

  /**
   * Drives the NewWorkspaceModal mounted in the app shell. Set by:
   * - sidebar `+` icon per repo row
   * - sidebar repo row click when the repo has no workspaces yet
   * - ⌘N hotkey (resolves to the active workspace's repo)
   * - context menus, command palette, post-add-repo flows
   * Cleared when the modal closes / a workspace is created.
   */
  pendingNewWorkspaceRepoId: string | null;
  requestNewWorkspace: (repoId: string) => void;
  clearPendingNewWorkspace: () => void;

  /** Drives RenameWorkspaceModal — sidebar right-click → Rename… sets this. */
  pendingRenameWorkspaceId: string | null;
  requestRenameWorkspace: (workspaceId: string) => void;
  clearPendingRenameWorkspace: () => void;

  /** Add-repository picker modal — single-button footer fans out to two choices. */
  addRepositoryPickerOpen: boolean;
  openAddRepositoryPicker: () => void;
  closeAddRepositoryPicker: () => void;

  // ---------- Active workspace context ----------
  activeWorkspaceContext: ActiveWorkspaceContext | null;
  setActiveWorkspaceContext: (ctx: ActiveWorkspaceContext | null) => void;

  // ---------- Per-workspace inner tabs ----------
  innerTabs: Record<string, InnerTabState>;
  ensureInnerTabs: (workspaceId: string, mainTitle: string) => void;
  /** Focus existing "main" tab or create one (used by "+ Open agent" + empty state). */
  openInnerAgentTab: (workspaceId: string, title: string) => InnerTab;
  openInnerTerminalTab: (workspaceId: string) => InnerTab;
  openInnerPreviewTab: (workspaceId: string, filePath: string) => InnerTab;
  /** Refuses to close the non-closable "main" tab. */
  closeInnerTab: (workspaceId: string, tabId: string) => InnerTab | null;
  setActiveInnerTab: (workspaceId: string, tabId: string) => void;
  setInnerTabPtySession: (workspaceId: string, tabId: string, ptySessionId: string) => void;

  runPanel: RunPanelState;
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    writeStoredTheme(theme);
    applyTheme(theme);
    set({ theme });
  },

  sidebarMode: readSidebar(),
  setSidebarMode: (mode) => {
    if (typeof window !== "undefined") window.localStorage.setItem(SIDEBAR_KEY, mode);
    set({ sidebarMode: mode });
  },
  toggleSidebarPin: () => {
    const next: SidebarMode = get().sidebarMode === "pinned" ? "collapsed" : "pinned";
    if (typeof window !== "undefined") window.localStorage.setItem(SIDEBAR_KEY, next);
    set({ sidebarMode: next });
  },
  toggleSidebarHidden: () => {
    const next: SidebarMode = get().sidebarMode === "hidden" ? "collapsed" : "hidden";
    if (typeof window !== "undefined") window.localStorage.setItem(SIDEBAR_KEY, next);
    set({ sidebarMode: next });
  },

  rightPanelCollapsed: readRightPanel(),
  toggleRightPanel: () => {
    const next = !get().rightPanelCollapsed;
    if (typeof window !== "undefined")
      window.localStorage.setItem(RIGHT_PANEL_KEY, next ? "collapsed" : "expanded");
    set({ rightPanelCollapsed: next });
  },
  setRightPanelCollapsed: (collapsed) => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(RIGHT_PANEL_KEY, collapsed ? "collapsed" : "expanded");
    set({ rightPanelCollapsed: collapsed });
  },

  newProjectModalOpen: false,
  openNewProjectModal: () => set({ newProjectModalOpen: true }),
  closeNewProjectModal: () => set({ newProjectModalOpen: false }),

  openExistingModalOpen: false,
  openOpenExistingModal: () => set({ openExistingModalOpen: true }),
  closeOpenExistingModal: () => set({ openExistingModalOpen: false }),

  fileSearchTarget: null,
  openFileSearch: (repositoryId, path) => set({ fileSearchTarget: { repositoryId, path } }),
  closeFileSearch: () => set({ fileSearchTarget: null }),

  pendingNewWorkspaceRepoId: null,
  requestNewWorkspace: (repoId) => set({ pendingNewWorkspaceRepoId: repoId }),
  clearPendingNewWorkspace: () => set({ pendingNewWorkspaceRepoId: null }),

  pendingRenameWorkspaceId: null,
  requestRenameWorkspace: (workspaceId) => set({ pendingRenameWorkspaceId: workspaceId }),
  clearPendingRenameWorkspace: () => set({ pendingRenameWorkspaceId: null }),

  addRepositoryPickerOpen: false,
  openAddRepositoryPicker: () => set({ addRepositoryPickerOpen: true }),
  closeAddRepositoryPicker: () => set({ addRepositoryPickerOpen: false }),

  activeWorkspaceContext: null,
  setActiveWorkspaceContext: (ctx) => set({ activeWorkspaceContext: ctx }),

  innerTabs: {},
  ensureInnerTabs: (workspaceId, mainTitle) => {
    const state = get().innerTabs[workspaceId];
    if (state) return;
    const mainTab: InnerTab = {
      id: uuidv4(),
      kind: "main",
      title: mainTitle,
      closable: true,
    };
    set({
      innerTabs: {
        ...get().innerTabs,
        [workspaceId]: { tabs: [mainTab], activeTabId: mainTab.id },
      },
    });
  },
  openInnerAgentTab: (workspaceId, title) => {
    const state = get().innerTabs[workspaceId];
    const existing = state?.tabs.find((t) => t.kind === "main");
    if (existing && state) {
      set({
        innerTabs: {
          ...get().innerTabs,
          [workspaceId]: { ...state, activeTabId: existing.id },
        },
      });
      return existing;
    }
    const tab: InnerTab = {
      id: uuidv4(),
      kind: "main",
      title,
      closable: true,
    };
    // Insert main at the front so it always reads as the first pill.
    const next: InnerTabState = state
      ? { tabs: [tab, ...state.tabs], activeTabId: tab.id }
      : { tabs: [tab], activeTabId: tab.id };
    set({ innerTabs: { ...get().innerTabs, [workspaceId]: next } });
    return tab;
  },
  openInnerTerminalTab: (workspaceId) => {
    const state = get().innerTabs[workspaceId];
    const existingTerminals = (state?.tabs ?? []).filter((t) => t.kind === "terminal").length;
    const tab: InnerTab = {
      id: uuidv4(),
      kind: "terminal",
      title: existingTerminals > 0 ? `Terminal ${existingTerminals + 1}` : "Terminal",
      closable: true,
    };
    const next: InnerTabState = state
      ? { tabs: [...state.tabs, tab], activeTabId: tab.id }
      : { tabs: [tab], activeTabId: tab.id };
    set({ innerTabs: { ...get().innerTabs, [workspaceId]: next } });
    return tab;
  },
  openInnerPreviewTab: (workspaceId, filePath) => {
    const state = get().innerTabs[workspaceId];
    const existing = state?.tabs.find((t) => t.kind === "preview" && t.filePath === filePath);
    if (existing && state) {
      set({
        innerTabs: { ...get().innerTabs, [workspaceId]: { ...state, activeTabId: existing.id } },
      });
      return existing;
    }
    const filename = filePath.split(/[/\\]/).pop() ?? filePath;
    const tab: InnerTab = {
      id: uuidv4(),
      kind: "preview",
      title: filename,
      closable: true,
      filePath,
    };
    const next: InnerTabState = state
      ? { tabs: [...state.tabs, tab], activeTabId: tab.id }
      : { tabs: [tab], activeTabId: tab.id };
    set({ innerTabs: { ...get().innerTabs, [workspaceId]: next } });
    return tab;
  },
  closeInnerTab: (workspaceId, tabId) => {
    const state = get().innerTabs[workspaceId];
    if (!state) return null;
    const closed = state.tabs.find((t) => t.id === tabId) ?? null;
    if (!closed || !closed.closable) return null;
    const remaining = state.tabs.filter((t) => t.id !== tabId);
    const newActive =
      state.activeTabId === tabId
        ? (remaining[remaining.length - 1]?.id ?? remaining[0]?.id ?? "")
        : state.activeTabId;
    set({
      innerTabs: {
        ...get().innerTabs,
        [workspaceId]: { tabs: remaining, activeTabId: newActive },
      },
    });
    return closed;
  },
  setActiveInnerTab: (workspaceId, tabId) => {
    const state = get().innerTabs[workspaceId];
    if (!state) return;
    set({
      innerTabs: { ...get().innerTabs, [workspaceId]: { ...state, activeTabId: tabId } },
    });
  },
  setInnerTabPtySession: (workspaceId, tabId, ptySessionId) => {
    const state = get().innerTabs[workspaceId];
    if (!state) return;
    set({
      innerTabs: {
        ...get().innerTabs,
        [workspaceId]: {
          ...state,
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ptySessionId } : t)),
        },
      },
    });
  },

  runPanel: {
    openTabs: [],
    activeTab: null,
    openTab: (id) => {
      const { runPanel } = get();
      const existing = runPanel.openTabs.includes(id)
        ? runPanel.openTabs
        : [...runPanel.openTabs, id];
      set({
        runPanel: { ...runPanel, openTabs: existing, activeTab: id },
      });
    },
    closeTab: (id) => {
      const { runPanel } = get();
      const remaining = runPanel.openTabs.filter((tab) => tab !== id);
      set({
        runPanel: {
          ...runPanel,
          openTabs: remaining,
          activeTab:
            runPanel.activeTab === id
              ? (remaining[remaining.length - 1] ?? null)
              : runPanel.activeTab,
        },
      });
    },
    setActiveTab: (id) => {
      const { runPanel } = get();
      set({ runPanel: { ...runPanel, activeTab: id } });
    },
    hidePanel: () => {
      const { runPanel } = get();
      set({ runPanel: { ...runPanel, activeTab: null } });
    },
    showPanel: () => {
      const { runPanel } = get();
      if (runPanel.activeTab) return;
      const first = runPanel.openTabs[0];
      if (first) set({ runPanel: { ...runPanel, activeTab: first } });
    },
  },
}));
