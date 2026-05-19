import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { applyTheme, readStoredTheme, writeStoredTheme, type Theme } from "./theme";

export type RepoTabKind = "workspaces" | "terminal" | "preview";

export interface RepoTab {
  id: string;
  kind: RepoTabKind;
  title: string;
  closable: boolean;
  /** Terminal — backend session uuid. Set after `start_session_terminal` returns. */
  ptySessionId?: string;
  /** Preview — repo-relative file path. */
  filePath?: string;
}

export interface RepoTabState {
  tabs: RepoTab[];
  activeTabId: string;
}

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
   * One-shot trigger so the right-click "New workspace" menu item can ask
   * the repo detail page to pop the form. Set when the menu is invoked,
   * cleared once the page consumes it.
   */
  pendingNewWorkspaceRepoId: string | null;
  requestNewWorkspace: (repoId: string) => void;
  clearPendingNewWorkspace: () => void;

  /** Per-repo in-app tab strip. See plan: tab system. */
  repoTabs: Record<string, RepoTabState>;
  ensureTabs: (repoId: string) => void;
  openTerminalTab: (repoId: string) => RepoTab;
  openPreviewTab: (repoId: string, filePath: string) => RepoTab;
  closeRepoTab: (repoId: string, tabId: string) => RepoTab | null;
  setActiveRepoTab: (repoId: string, tabId: string) => void;
  setTabPtySession: (repoId: string, tabId: string, sessionId: string) => void;

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
  openFileSearch: (repositoryId, path) =>
    set({ fileSearchTarget: { repositoryId, path } }),
  closeFileSearch: () => set({ fileSearchTarget: null }),

  pendingNewWorkspaceRepoId: null,
  requestNewWorkspace: (repoId) => set({ pendingNewWorkspaceRepoId: repoId }),
  clearPendingNewWorkspace: () => set({ pendingNewWorkspaceRepoId: null }),

  repoTabs: {},
  ensureTabs: (repoId) => {
    const { repoTabs } = get();
    if (repoTabs[repoId]) return;
    const defaultTab: RepoTab = {
      id: uuidv4(),
      kind: "workspaces",
      title: "Workspaces",
      closable: false,
    };
    set({
      repoTabs: {
        ...repoTabs,
        [repoId]: { tabs: [defaultTab], activeTabId: defaultTab.id },
      },
    });
  },
  openTerminalTab: (repoId) => {
    const state = get().repoTabs[repoId];
    const existingTerminals = (state?.tabs ?? []).filter((t) => t.kind === "terminal").length;
    const tab: RepoTab = {
      id: uuidv4(),
      kind: "terminal",
      title: existingTerminals > 0 ? `Terminal ${existingTerminals + 1}` : "Terminal",
      closable: true,
    };
    const next: RepoTabState = state
      ? { tabs: [...state.tabs, tab], activeTabId: tab.id }
      : { tabs: [tab], activeTabId: tab.id };
    set({ repoTabs: { ...get().repoTabs, [repoId]: next } });
    return tab;
  },
  openPreviewTab: (repoId, filePath) => {
    const state = get().repoTabs[repoId];
    // If a preview tab for the same file already exists, reuse it.
    const existing = state?.tabs.find((t) => t.kind === "preview" && t.filePath === filePath);
    if (existing && state) {
      set({
        repoTabs: { ...get().repoTabs, [repoId]: { ...state, activeTabId: existing.id } },
      });
      return existing;
    }
    const filename = filePath.split(/[/\\]/).pop() ?? filePath;
    const tab: RepoTab = {
      id: uuidv4(),
      kind: "preview",
      title: filename,
      closable: true,
      filePath,
    };
    const next: RepoTabState = state
      ? { tabs: [...state.tabs, tab], activeTabId: tab.id }
      : { tabs: [tab], activeTabId: tab.id };
    set({ repoTabs: { ...get().repoTabs, [repoId]: next } });
    return tab;
  },
  closeRepoTab: (repoId, tabId) => {
    const state = get().repoTabs[repoId];
    if (!state) return null;
    const closed = state.tabs.find((t) => t.id === tabId) ?? null;
    if (!closed || !closed.closable) return null;
    const remaining = state.tabs.filter((t) => t.id !== tabId);
    const newActive =
      state.activeTabId === tabId
        ? (remaining[remaining.length - 1]?.id ?? remaining[0]?.id ?? "")
        : state.activeTabId;
    set({
      repoTabs: {
        ...get().repoTabs,
        [repoId]: { tabs: remaining, activeTabId: newActive },
      },
    });
    return closed;
  },
  setActiveRepoTab: (repoId, tabId) => {
    const state = get().repoTabs[repoId];
    if (!state) return;
    set({
      repoTabs: { ...get().repoTabs, [repoId]: { ...state, activeTabId: tabId } },
    });
  },
  setTabPtySession: (repoId, tabId, sessionId) => {
    const state = get().repoTabs[repoId];
    if (!state) return;
    set({
      repoTabs: {
        ...get().repoTabs,
        [repoId]: {
          ...state,
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ptySessionId: sessionId } : t)),
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
              ? remaining[remaining.length - 1] ?? null
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
