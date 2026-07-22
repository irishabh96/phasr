import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import {
  applyTheme,
  readStoredTheme,
  writeStoredTheme,
  type Theme,
} from "./theme";

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

export type InnerTabKind = "main" | "terminal" | "preview" | "brief" | "comments";

/** Fixed tab ids for the non-closable subtask tabs (Phase 2 — Brief tab). */
export const BRIEF_TAB_ID = "brief";
export const COMMENTS_TAB_ID = "comments";

export interface InnerTab {
  id: string;
  kind: InnerTabKind;
  title: string;
  closable: boolean;
  /** Terminal — backend session uuid. Set after `start_session_terminal` returns. */
  ptySessionId?: string;
  /** Terminal — optional command typed into the shell after it opens. */
  initialCommand?: string;
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
  /** Terminal — optional command typed into the shell after it opens. */
  initialCommand?: string;
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
const SIDEBAR_WIDTH_KEY = "phasr.sidebarWidth";
const RIGHT_PANEL_WIDTH_KEY = "phasr.rightPanelWidth";
const LAST_WORKSPACE_KEY = "phasr.lastWorkspace";

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 260;
export const RIGHT_PANEL_WIDTH_MIN = 300;
export const RIGHT_PANEL_WIDTH_MAX = 640;
export const RIGHT_PANEL_WIDTH_DEFAULT = 360;

function clampWidth(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function readWidth(key: string, min: number, max: number, fallback: number) {
  if (typeof window === "undefined") return fallback;
  const parsed = parseInt(window.localStorage.getItem(key) ?? "", 10);
  return clampWidth(parsed, min, max, fallback);
}

function readSidebar(): SidebarMode {
  if (typeof window === "undefined") return "pinned";
  const v = window.localStorage.getItem(SIDEBAR_KEY);
  return v === "collapsed" || v === "hidden" ? v : "pinned";
}

function readRightPanel(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(RIGHT_PANEL_KEY) === "collapsed";
}

/**
 * Rehydrate the last-open workspace from localStorage. Returns null for a
 * missing/corrupt/malformed value so a bad blob can never dead-end the
 * re-entry restore — the caller (Home route) additionally validates the
 * ids against the live repo/workspace lists before navigating.
 */
function readStoredLastWorkspace(): ActiveWorkspaceContext | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(LAST_WORKSPACE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveWorkspaceContext> | null;
    if (
      parsed &&
      typeof parsed.repositoryId === "string" &&
      typeof parsed.workspaceId === "string"
    ) {
      return {
        repositoryId: parsed.repositoryId,
        workspaceId: parsed.workspaceId,
      };
    }
  } catch {
    // Corrupt JSON — treat as "no stored workspace" and fall back cleanly.
  }
  return null;
}

interface UiState {
  theme: Theme;
  setTheme: (theme: Theme) => void;

  sidebarMode: SidebarMode;
  setSidebarMode: (mode: SidebarMode) => void;
  toggleSidebarPin: () => void;
  toggleSidebarHidden: () => void;
  /** Pinned left-sidebar width in px. Persisted; drag-resizable. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  repoWorkspaceExpanded: Record<string, boolean>;
  toggleRepoWorkspaceExpanded: (repositoryId: string) => void;

  /**
   * Per-epic (board `parent`) sidebar expand state, keyed by parent id. Mirrors
   * `repoWorkspaceExpanded`. When a parent has no explicit entry the caller
   * falls back to "expanded iff it's the active epic" (computed at the call
   * site), so drilling into a subtask auto-reveals its siblings with no effect;
   * an explicit value (the user toggled the chevron) always wins.
   */
  epicExpanded: Record<string, boolean>;
  setEpicExpanded: (parentId: string, expanded: boolean) => void;

  rightPanelCollapsed: boolean;
  toggleRightPanel: () => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  /** Workspace right-panel width in px. Persisted; drag-resizable. */
  rightPanelWidth: number;
  setRightPanelWidth: (width: number) => void;

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
  openRepoInnerPreviewTab: (
    repositoryId: string,
    filePath: string,
  ) => RepoInnerTab;
  openRepoInnerTerminalTab: (repositoryId: string) => RepoInnerTab;
  setRepoInnerTabPtySession: (
    repositoryId: string,
    tabId: string,
    ptySessionId: string,
  ) => void;
  closeRepoInnerTab: (
    repositoryId: string,
    tabId: string,
  ) => RepoInnerTab | null;
  setActiveRepoInnerTab: (repositoryId: string, tabId: string) => void;

  /**
   * Drives the NewTaskModal mounted in the app shell. Set by:
   * - sidebar `+` icon per repo row
   * - sidebar repo row click when the repo has no workspaces yet
   * - ⌘N hotkey (resolves to the active workspace's repo)
   * - context menus, command palette, post-add-repo flows
   * Cleared when the modal closes / a workspace is created.
   */
  pendingNewWorkspaceRepoId: string | null;
  requestNewWorkspace: (repoId: string) => void;
  clearPendingNewWorkspace: () => void;

  /**
   * Repo id whose "New epic" decomposition dialog is open, or null. Set by the
   * "New epic" affordances (repo-home pane + sidebar context menu); the
   * shell-mounted DecomposeModal picks it up and opens. Cleared when the dialog
   * closes or a decomposition is started. Progressive disclosure: this is a
   * SEPARATE slice from `pendingNewWorkspaceRepoId` so the single-agent "New
   * task" flow is untouched.
   */
  pendingDecomposeRepoId: string | null;
  requestDecompose: (repoId: string) => void;
  clearPendingDecompose: () => void;

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

  /**
   * The last workspace the user had open, persisted to `phasr.lastWorkspace`
   * in localStorage so a relaunch can restore it. Written on every workspace
   * mount and — unlike `activeWorkspaceContext` — never cleared on unmount,
   * so it survives across sessions. The Home route validates it against the
   * live repo/workspace lists and falls back gracefully if it's stale.
   */
  lastWorkspace: ActiveWorkspaceContext | null;
  setLastWorkspace: (ctx: ActiveWorkspaceContext) => void;

  // ---------- Per-workspace inner tabs ----------
  innerTabs: Record<string, InnerTabState>;
  /**
   * Seed the workspace's inner tabs on first mount. For a `subtask` (pass
   * `seedBrief: true`) the seed is `[brief, main(Terminal), comments]` with
   * brief/comments non-closable (mockup Page 04, spec A2/F3). For every other
   * kind it's the byte-identical single `main` tab — the standalone agent/local
   * flow is untouched. No-op if already set.
   *
   * `seedActive` picks the initially-focused subtask tab: `"main"` (the live
   * agent Terminal) when the agent has already been spawned — its real output
   * exists, so the user should land on it, not the spec — and `"brief"` for a
   * not-yet-started subtask. Ignored unless `seedBrief` is true.
   */
  ensureInnerTabs: (
    workspaceId: string,
    mainTitle: string,
    seedBrief?: boolean,
    seedActive?: "brief" | "main",
  ) => void;
  /** Focus existing "main" tab or create one (used by "+ Open agent" + empty state). */
  openInnerAgentTab: (workspaceId: string, title: string) => InnerTab;
  openInnerTerminalTab: (
    workspaceId: string,
    options?: { title?: string; initialCommand?: string },
  ) => InnerTab;
  openInnerPreviewTab: (workspaceId: string, filePath: string) => InnerTab;
  /** Refuses to close the non-closable "main" tab. */
  closeInnerTab: (workspaceId: string, tabId: string) => InnerTab | null;
  /**
   * Drop all tab state for a deleted repository: its workspaces' inner
   * tabs, the repo's own inner tabs, and the active workspace context if
   * it points at this repo. Callers dispose the xterm instances first.
   */
  forgetRepository: (repositoryId: string, workspaceIds: string[]) => void;
  /**
   * Wipe all per-account tab/workspace state. Called when the signed-in
   * account changes (or on sign-out) so one user's tabs never bleed into
   * another's session.
   */
  resetForAccountSwitch: () => void;
  setActiveInnerTab: (workspaceId: string, tabId: string) => void;
  setInnerTabPtySession: (
    workspaceId: string,
    tabId: string,
    ptySessionId: string,
  ) => void;

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
    if (typeof window !== "undefined")
      window.localStorage.setItem(SIDEBAR_KEY, mode);
    set({ sidebarMode: mode });
  },
  toggleSidebarPin: () => {
    const next: SidebarMode =
      get().sidebarMode === "pinned" ? "collapsed" : "pinned";
    if (typeof window !== "undefined")
      window.localStorage.setItem(SIDEBAR_KEY, next);
    set({ sidebarMode: next });
  },
  toggleSidebarHidden: () => {
    const next: SidebarMode =
      get().sidebarMode === "hidden" ? "collapsed" : "hidden";
    if (typeof window !== "undefined")
      window.localStorage.setItem(SIDEBAR_KEY, next);
    set({ sidebarMode: next });
  },
  sidebarWidth: readWidth(
    SIDEBAR_WIDTH_KEY,
    SIDEBAR_WIDTH_MIN,
    SIDEBAR_WIDTH_MAX,
    SIDEBAR_WIDTH_DEFAULT,
  ),
  setSidebarWidth: (width) => {
    const next = clampWidth(
      Math.round(width),
      SIDEBAR_WIDTH_MIN,
      SIDEBAR_WIDTH_MAX,
      SIDEBAR_WIDTH_DEFAULT,
    );
    if (typeof window !== "undefined")
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next));
    set({ sidebarWidth: next });
  },
  repoWorkspaceExpanded: {},
  toggleRepoWorkspaceExpanded: (repositoryId) => {
    const current = get().repoWorkspaceExpanded[repositoryId] ?? true;
    set({
      repoWorkspaceExpanded: {
        ...get().repoWorkspaceExpanded,
        [repositoryId]: !current,
      },
    });
  },

  epicExpanded: {},
  setEpicExpanded: (parentId, expanded) => {
    set({
      epicExpanded: { ...get().epicExpanded, [parentId]: expanded },
    });
  },

  rightPanelCollapsed: readRightPanel(),
  toggleRightPanel: () => {
    const next = !get().rightPanelCollapsed;
    if (typeof window !== "undefined")
      window.localStorage.setItem(
        RIGHT_PANEL_KEY,
        next ? "collapsed" : "expanded",
      );
    set({ rightPanelCollapsed: next });
  },
  setRightPanelCollapsed: (collapsed) => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(
        RIGHT_PANEL_KEY,
        collapsed ? "collapsed" : "expanded",
      );
    set({ rightPanelCollapsed: collapsed });
  },
  rightPanelWidth: readWidth(
    RIGHT_PANEL_WIDTH_KEY,
    RIGHT_PANEL_WIDTH_MIN,
    RIGHT_PANEL_WIDTH_MAX,
    RIGHT_PANEL_WIDTH_DEFAULT,
  ),
  setRightPanelWidth: (width) => {
    const next = clampWidth(
      Math.round(width),
      RIGHT_PANEL_WIDTH_MIN,
      RIGHT_PANEL_WIDTH_MAX,
      RIGHT_PANEL_WIDTH_DEFAULT,
    );
    if (typeof window !== "undefined")
      window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(next));
    set({ rightPanelWidth: next });
  },

  rightPanelTab: {},
  setRightPanelTab: (workspaceId, tab) => {
    set({ rightPanelTab: { ...get().rightPanelTab, [workspaceId]: tab } });
  },

  pendingGitInitRepoId: null,
  requestGitInit: (repoId) => set({ pendingGitInitRepoId: repoId }),
  clearPendingGitInit: () => set({ pendingGitInitRepoId: null }),

  fileSearchTarget: null,
  openFileSearch: (repositoryId, path) =>
    set({ fileSearchTarget: { repositoryId, path } }),
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
    const existingTerminals = state.tabs.filter(
      (t) => t.kind === "terminal",
    ).length;
    const tab: RepoInnerTab = {
      id: uuidv4(),
      kind: "terminal",
      title:
        existingTerminals > 0
          ? `Terminal ${existingTerminals + 1}`
          : "Terminal",
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
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, ptySessionId } : t,
          ),
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

  pendingDecomposeRepoId: null,
  requestDecompose: (repoId) => set({ pendingDecomposeRepoId: repoId }),
  clearPendingDecompose: () => set({ pendingDecomposeRepoId: null }),

  pendingRenameWorkspaceId: null,
  requestRenameWorkspace: (workspaceId) =>
    set({ pendingRenameWorkspaceId: workspaceId }),
  clearPendingRenameWorkspace: () => set({ pendingRenameWorkspaceId: null }),

  addRepositoryPickerOpen: false,
  openAddRepositoryPicker: () => set({ addRepositoryPickerOpen: true }),
  closeAddRepositoryPicker: () => set({ addRepositoryPickerOpen: false }),

  commandPaletteOpen: false,
  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),
  toggleCommandPalette: () =>
    set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),

  activeWorkspaceContext: null,
  setActiveWorkspaceContext: (ctx) => set({ activeWorkspaceContext: ctx }),

  lastWorkspace: readStoredLastWorkspace(),
  setLastWorkspace: (ctx) => {
    if (typeof window !== "undefined")
      window.localStorage.setItem(LAST_WORKSPACE_KEY, JSON.stringify(ctx));
    set({ lastWorkspace: ctx });
  },

  innerTabs: {},
  ensureInnerTabs: (
    workspaceId,
    mainTitle,
    seedBrief = false,
    seedActive = "brief",
  ) => {
    const state = get().innerTabs[workspaceId];
    if (state) return;
    const mainTab: InnerTab = {
      id: uuidv4(),
      kind: "main",
      // A subtask's primary process reads as "Terminal" (mockup Page 04);
      // standalone agent/local tabs keep their command/name title.
      title: seedBrief ? "Terminal" : mainTitle,
      closable: true,
    };
    if (seedBrief) {
      const briefTab: InnerTab = {
        id: BRIEF_TAB_ID,
        kind: "brief",
        title: "Brief",
        closable: false,
      };
      const commentsTab: InnerTab = {
        id: COMMENTS_TAB_ID,
        kind: "comments",
        title: "Comments",
        closable: false,
      };
      set({
        innerTabs: {
          ...get().innerTabs,
          [workspaceId]: {
            tabs: [briefTab, mainTab, commentsTab],
            // A live/started subtask lands on its Terminal (the agent output);
            // a not-yet-started one lands on the Brief. Falls back to brief.
            activeTabId: seedActive === "main" ? mainTab.id : briefTab.id,
          },
        },
      });
      return;
    }
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
  openInnerTerminalTab: (workspaceId, options) => {
    const state = get().innerTabs[workspaceId];
    const existingTerminals = (state?.tabs ?? []).filter(
      (t) => t.kind === "terminal",
    ).length;
    const tab: InnerTab = {
      id: uuidv4(),
      kind: "terminal",
      title:
        options?.title ??
        (existingTerminals > 0
          ? `Terminal ${existingTerminals + 1}`
          : "Terminal"),
      closable: true,
      ...(options?.initialCommand
        ? { initialCommand: options.initialCommand }
        : {}),
    };
    const next: InnerTabState = state
      ? { tabs: [...state.tabs, tab], activeTabId: tab.id }
      : { tabs: [tab], activeTabId: tab.id };
    set({ innerTabs: { ...get().innerTabs, [workspaceId]: next } });
    return tab;
  },
  openInnerPreviewTab: (workspaceId, filePath) => {
    const state = get().innerTabs[workspaceId];
    const existing = state?.tabs.find(
      (t) => t.kind === "preview" && t.filePath === filePath,
    );
    if (existing && state) {
      set({
        innerTabs: {
          ...get().innerTabs,
          [workspaceId]: { ...state, activeTabId: existing.id },
        },
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

  forgetRepository: (repositoryId, workspaceIds) => {
    const innerTabs = { ...get().innerTabs };
    for (const wsId of workspaceIds) delete innerTabs[wsId];
    const { [repositoryId]: _removedRepo, ...repoInnerTabs } =
      get().repoInnerTabs;
    const ctx = get().activeWorkspaceContext;
    set({
      innerTabs,
      repoInnerTabs,
      activeWorkspaceContext: ctx?.repositoryId === repositoryId ? null : ctx,
    });
  },

  resetForAccountSwitch: () => {
    set({ innerTabs: {}, repoInnerTabs: {}, activeWorkspaceContext: null });
  },
  setActiveInnerTab: (workspaceId, tabId) => {
    const state = get().innerTabs[workspaceId];
    if (!state) return;
    set({
      innerTabs: {
        ...get().innerTabs,
        [workspaceId]: { ...state, activeTabId: tabId },
      },
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
          tabs: state.tabs.map((t) =>
            t.id === tabId ? { ...t, ptySessionId } : t,
          ),
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
