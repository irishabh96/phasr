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

// ---------- Per-repository inner tab strip ----------
//
// Mirrors the per-workspace `innerTabs` system above. Lives on the
// repository view (the empty-repo screen today; potentially every
// repo-scoped surface later). Home is pinned + not closable; preview
// tabs host `<FilePreviewTab>` and are added by the file-search modal
// when the user opens a file outside of a workspace context.

export type RepoInnerTabKind = "home" | "preview" | "terminal";

export interface RepoInnerTab {
  id: string;
  kind: RepoInnerTabKind;
  title: string;
  closable: boolean;
  /** Preview — repo-relative file path. */
  filePath?: string;
  /** Terminal — backend session uuid. Set after `start_session_terminal` returns. */
  ptySessionId?: string;
}

export interface RepoInnerTabState {
  tabs: RepoInnerTab[];
  activeTabId: string;
}

export const REPO_HOME_TAB_ID = "home";

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

  /**
   * Active tab inside the workspace right sidebar, keyed by workspace
   * id. Defaults to "changes" when unset. Persists across ⌘J toggles
   * but not across reloads — survives sessions via the same per-tab
   * pattern as `innerTabs` (in-memory; we don't snapshot to disk).
   */
  rightPanelTab: Record<string, "changes" | "history">;
  setRightPanelTab: (workspaceId: string, tab: "changes" | "history") => void;


  /**
   * Drives `<GitInitConfirmModal>`. Set to a repo id when an Open-existing
   * or New-project Empty flow lands on a non-git folder; cleared when the
   * user clicks Initialize Git, Cancel, or Esc.
   */
  pendingGitInitRepoId: string | null;
  requestGitInit: (repoId: string) => void;
  clearPendingGitInit: () => void;

  /** Repo file-search modal — non-null target means open + scoped to that repo. */
  fileSearchTarget: { repositoryId: string; path: string } | null;
  openFileSearch: (repositoryId: string, path: string) => void;
  closeFileSearch: () => void;

  /**
   * Per-repository inner tab strip. Home is the pinned default tab; file
   * previews dock here when opened from the file-search modal outside of
   * a workspace context.
   */
  repoInnerTabs: Record<string, RepoInnerTabState>;
  ensureRepoInnerTabs: (repositoryId: string) => void;
  openRepoInnerPreviewTab: (repositoryId: string, filePath: string) => RepoInnerTab;
  openRepoInnerTerminalTab: (repositoryId: string) => RepoInnerTab;
  setRepoInnerTabPtySession: (
    repositoryId: string,
    tabId: string,
    ptySessionId: string,
  ) => void;
  closeRepoInnerTab: (repositoryId: string, tabId: string) => RepoInnerTab | null;
  setActiveRepoInnerTab: (repositoryId: string, tabId: string) => void;

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

  /** Global ⌘K command palette. Opened by both the TitleBar search
   *  button and the ⌘K hotkey inside the palette component. */
  commandPaletteOpen: boolean;
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleCommandPalette: () => void;

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

  rightPanelTab: {},
  setRightPanelTab: (workspaceId, tab) => {
    set({ rightPanelTab: { ...get().rightPanelTab, [workspaceId]: tab } });
  },

  pendingGitInitRepoId: null,
  requestGitInit: (repoId) => set({ pendingGitInitRepoId: repoId }),
  clearPendingGitInit: () => set({ pendingGitInitRepoId: null }),

  fileSearchTarget: null,
  openFileSearch: (repositoryId, path) => set({ fileSearchTarget: { repositoryId, path } }),
  closeFileSearch: () => set({ fileSearchTarget: null }),

  repoInnerTabs: {},
  ensureRepoInnerTabs: (repositoryId) => {
    if (get().repoInnerTabs[repositoryId]) return;
    const home: RepoInnerTab = {
      id: REPO_HOME_TAB_ID,
      kind: "home",
      title: "Home",
      closable: false,
    };
    set({
      repoInnerTabs: {
        ...get().repoInnerTabs,
        [repositoryId]: { tabs: [home], activeTabId: home.id },
      },
    });
  },
  openRepoInnerPreviewTab: (repositoryId, filePath) => {
    let state = get().repoInnerTabs[repositoryId];
    if (!state) {
      const home: RepoInnerTab = {
        id: REPO_HOME_TAB_ID,
        kind: "home",
        title: "Home",
        closable: false,
      };
      state = { tabs: [home], activeTabId: home.id };
    }
    const existing = state.tabs.find(
      (t) => t.kind === "preview" && t.filePath === filePath,
    );
    if (existing) {
      set({
        repoInnerTabs: {
          ...get().repoInnerTabs,
          [repositoryId]: { ...state, activeTabId: existing.id },
        },
      });
      return existing;
    }
    const filename = filePath.split(/[/\\]/).pop() ?? filePath;
    const tab: RepoInnerTab = {
      id: uuidv4(),
      kind: "preview",
      title: filename,
      closable: true,
      filePath,
    };
    set({
      repoInnerTabs: {
        ...get().repoInnerTabs,
        [repositoryId]: { tabs: [...state.tabs, tab], activeTabId: tab.id },
      },
    });
    return tab;
  },
  openRepoInnerTerminalTab: (repositoryId) => {
    let state = get().repoInnerTabs[repositoryId];
    if (!state) {
      const home: RepoInnerTab = {
        id: REPO_HOME_TAB_ID,
        kind: "home",
        title: "Home",
        closable: false,
      };
      state = { tabs: [home], activeTabId: home.id };
    }
    const existingTerminals = state.tabs.filter((t) => t.kind === "terminal").length;
    const tab: RepoInnerTab = {
      id: uuidv4(),
      kind: "terminal",
      title: existingTerminals > 0 ? `Terminal ${existingTerminals + 1}` : "Terminal",
      closable: true,
    };
    set({
      repoInnerTabs: {
        ...get().repoInnerTabs,
        [repositoryId]: { tabs: [...state.tabs, tab], activeTabId: tab.id },
      },
    });
    return tab;
  },
  setRepoInnerTabPtySession: (repositoryId, tabId, ptySessionId) => {
    const state = get().repoInnerTabs[repositoryId];
    if (!state) return;
    set({
      repoInnerTabs: {
        ...get().repoInnerTabs,
        [repositoryId]: {
          ...state,
          tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, ptySessionId } : t)),
        },
      },
    });
  },
  closeRepoInnerTab: (repositoryId, tabId) => {
    const state = get().repoInnerTabs[repositoryId];
    if (!state) return null;
    const closed = state.tabs.find((t) => t.id === tabId) ?? null;
    if (!closed || !closed.closable) return null;
    const remaining = state.tabs.filter((t) => t.id !== tabId);
    const newActive =
      state.activeTabId === tabId
        ? (remaining[remaining.length - 1]?.id ?? REPO_HOME_TAB_ID)
        : state.activeTabId;
    set({
      repoInnerTabs: {
        ...get().repoInnerTabs,
        [repositoryId]: { tabs: remaining, activeTabId: newActive },
      },
    });
    return closed;
  },
  setActiveRepoInnerTab: (repositoryId, tabId) => {
    const state = get().repoInnerTabs[repositoryId];
    if (!state) return;
    if (!state.tabs.some((t) => t.id === tabId)) return;
    set({
      repoInnerTabs: {
        ...get().repoInnerTabs,
        [repositoryId]: { ...state, activeTabId: tabId },
      },
    });
  },

  pendingNewWorkspaceRepoId: null,
  requestNewWorkspace: (repoId) => set({ pendingNewWorkspaceRepoId: repoId }),
  clearPendingNewWorkspace: () => set({ pendingNewWorkspaceRepoId: null }),

  pendingRenameWorkspaceId: null,
  requestRenameWorkspace: (workspaceId) => set({ pendingRenameWorkspaceId: workspaceId }),
  clearPendingRenameWorkspace: () => set({ pendingRenameWorkspaceId: null }),

  addRepositoryPickerOpen: false,
  openAddRepositoryPicker: () => set({ addRepositoryPickerOpen: true }),
  closeAddRepositoryPicker: () => set({ addRepositoryPickerOpen: false }),

  commandPaletteOpen: false,
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),

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
    if (remaining.length === 0) {
      const { [workspaceId]: _removed, ...nextInnerTabs } = get().innerTabs;
      set({ innerTabs: nextInnerTabs });
      return closed;
    }
    const newActive =
      state.activeTabId === tabId
        ? (remaining[remaining.length - 1]?.id ?? remaining[0]!.id)
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
