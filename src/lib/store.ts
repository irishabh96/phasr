import { create } from "zustand";
import { v4 as uuidv4 } from "uuid";
import { runKey } from "./runScope";
import {
  applyAccent,
  applyDensity,
  applyTheme,
  readStoredAccent,
  readStoredDensity,
  readStoredTheme,
  writeStoredAccent,
  writeStoredDensity,
  writeStoredTheme,
  type Accent,
  type Density,
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

export type InnerTabKind = "main" | "terminal" | "preview";

export type RightPanelTab = "changes" | "history" | "notes";

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
  /**
   * Open the run-command tab in a task (and focus it) — an explicit "run it
   * here". `taskId` defaults to the task on screen; with no task (the
   * board) there is nowhere to show it, so nothing is recorded.
   */
  openTab(id: string, taskId?: string | null): void;
  /** Close one task's tab (also moves focus or hides the pane). `taskId` as in `openTab`. */
  closeTab(id: string, taskId?: string | null): void;
  /** focus an already-open tab */
  setActiveTab(id: string): void;
  /** hide the panel without losing tabs */
  hidePanel(): void;
  /** show the panel and focus the first tab if none is active */
  showPanel(): void;
  /**
   * `runKey(runCommandId, taskId)` keys — the TASK the tab was opened in,
   * never the backend run target (see `lib/runScope.ts`). `intents`: the
   * user asked to RUN it there (consumed by the terminal's first start).
   * `shown`: the tab belongs to that task's pane bar. Mounting a run tab
   * only ever ATTACHES; it spawns only with an intent, so visiting another
   * task never starts a command there.
   */
  intents: Record<string, true>;
  shown: Record<string, true>;
  consumeIntent(key: string): boolean;
}

// ---------- Files pane editor buffers ----------

/**
 * One open file's editor state, kept outside the editor component so it
 * survives Edit ↔ Diff, closing the pane and switching tasks. Cleared only
 * by a save (buffer → null), "Reload theirs", or a confirmed discard
 * (closing the tab).
 */
export interface FileBuffer {
  /** The disk version the edit is based on (save's `expectedHash`). */
  base: { hash: string; contents: string };
  /** The editor's text; null = the same as `base`. */
  buffer: string | null;
  /** Derived: `buffer` differs from `base.contents`. */
  dirty: boolean;
  /** The file moved on disk under unsaved edits (agent write). */
  diskChanged: boolean;
  /** Contents of the write in flight; null when idle (single-flight). */
  saving: string | null;
  /** ⌘S pressed during a save with newer edits: one follow-up save. */
  saveQueued: { overwrite: boolean } | null;
  /** Bumped when the editor must replace its document (a reload). */
  rev: number;
}

export function fileBufferKey(workspaceId: string, path: string): string {
  return `${workspaceId}:${path}`;
}

export type SidebarMode = "collapsed" | "pinned" | "hidden";
export type SessionPane = "tabs" | "changes" | "files" | "notes" | "run";

const SIDEBAR_KEY = "phasr.sidebar";
const RIGHT_PANEL_KEY = "phasr.rightPanel";
const SIDEBAR_WIDTH_KEY = "phasr.sidebarWidth";
const RIGHT_PANEL_WIDTH_KEY = "phasr.rightPanelWidth";
const LAST_WORKSPACE_KEY = "phasr.lastWorkspace";

export const SIDEBAR_WIDTH_MIN = 220;
export const SIDEBAR_WIDTH_MAX = 420;
export const SIDEBAR_WIDTH_DEFAULT = 264;
export const RIGHT_PANEL_WIDTH_MIN = 260;
export const RIGHT_PANEL_WIDTH_MAX = 480;
export const RIGHT_PANEL_WIDTH_DEFAULT = 280; // --layout-inspector-width

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
  /** Accent mirror of UserSettings.accentColor; localStorage copy boots FOUC-free. */
  accent: Accent;
  setAccent: (accent: Accent) => void;
  /**
   * Which pane fills a task session's content area (A-Workspace pane tabs).
   * "tabs" = the agent/terminal/preview tab stack (always mounted, so PTYs
   * survive); the others overlay it. Per workspace, in memory.
   */
  sessionPane: Record<string, SessionPane>;
  setSessionPane: (workspaceId: string, pane: SessionPane) => void;
  /** Selected file in a task's Files pane (palette `@file` deep-links it). */
  sessionFile: Record<string, string>;
  /** Open file tabs per task, in tab order. Opening selects and adds. */
  openFiles: Record<string, string[]>;
  openSessionFile: (workspaceId: string, path: string) => void;
  /**
   * Close a file tab and drop its buffer (the caller has confirmed any
   * discard). Selects the neighbouring tab when it was the selected one.
   */
  closeSessionFile: (workspaceId: string, path: string) => void;
  /** Editor buffers keyed by {@link fileBufferKey}. */
  fileBuffers: Record<string, FileBuffer>;
  /** Replace one buffer; `undefined` from `fn` removes it. `dirty` is derived. */
  updateFileBuffer: (key: string, fn: (prev: FileBuffer | undefined) => FileBuffer | undefined) => void;
  /** Title-bar repository switcher: null = all repositories. */
  repoFilter: string | null;
  setRepoFilter: (repositoryId: string | null) => void;
  /** Cloud sync worker health, fed by useCloudSync (status bar). */
  cloudSync: { state: "unknown" | "ok" | "error"; at: number | null };
  setCloudSync: (state: "ok" | "error") => void;
  density: Density;
  setDensity: (density: Density) => void;

  sidebarMode: SidebarMode;
  setSidebarMode: (mode: SidebarMode) => void;
  toggleSidebarPin: () => void;
  toggleSidebarHidden: () => void;
  /** Pinned left-sidebar width in px. Persisted; drag-resizable. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  repoWorkspaceExpanded: Record<string, boolean>;
  toggleRepoWorkspaceExpanded: (repositoryId: string) => void;

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
  rightPanelTab: Record<string, RightPanelTab>;
  setRightPanelTab: (workspaceId: string, tab: RightPanelTab) => void;

  /** Repo-home right rail (Notes only). Collapsed by default. */
  repoRailCollapsed: boolean;
  setRepoRailCollapsed: (collapsed: boolean) => void;

  /**
   * Unsaved note-composer drafts, keyed `${repositoryId}:${noteId|"new"}`.
   * Survives rail collapse / tab switches so a draft is never lost;
   * in-memory only (a draft should not outlive the app).
   */
  noteDrafts: Record<string, string>;
  setNoteDraft: (key: string, body: string) => void;
  clearNoteDraft: (key: string) => void;

  /**
   * The note composer is SUMMONED, not pinned: the panel's resting state
   * is a reading surface. ⌘⇧N / the header + / clicking the canvas open
   * it; Esc closes it (the draft survives in `noteDrafts`).
   * `notesComposerRequest` is bumped on every open so the mounted
   * composer re-focuses even if it was already open.
   */
  notesComposerOpen: boolean;
  notesComposerRequest: number;
  openNotesComposer: () => void;
  closeNotesComposer: () => void;

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
  ensureInnerTabs: (workspaceId: string, mainTitle: string) => void;
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
   * it points at this repo. Callers dispose the terminal surfaces first.
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
  accent: readStoredAccent(),
  setAccent: (accent) => {
    writeStoredAccent(accent);
    applyAccent(accent);
    set({ accent });
  },
  sessionPane: {},
  setSessionPane: (workspaceId, pane) =>
    set((st) => ({ sessionPane: { ...st.sessionPane, [workspaceId]: pane } })),
  sessionFile: {},
  openFiles: {},
  openSessionFile: (workspaceId, path) =>
    set((st) => {
      const tabs = st.openFiles[workspaceId] ?? [];
      return {
        sessionFile: { ...st.sessionFile, [workspaceId]: path },
        sessionPane: { ...st.sessionPane, [workspaceId]: "files" },
        openFiles: tabs.includes(path) ? st.openFiles : { ...st.openFiles, [workspaceId]: [...tabs, path] },
      };
    }),
  closeSessionFile: (workspaceId, path) =>
    set((st) => {
      const tabs = st.openFiles[workspaceId] ?? [];
      const at = tabs.indexOf(path);
      const rest = tabs.filter((p) => p !== path);
      const sessionFile = { ...st.sessionFile };
      if (sessionFile[workspaceId] === path) {
        const next = rest[Math.min(Math.max(at, 0), rest.length - 1)];
        if (next) sessionFile[workspaceId] = next;
        else delete sessionFile[workspaceId];
      }
      const fileBuffers = { ...st.fileBuffers };
      delete fileBuffers[fileBufferKey(workspaceId, path)];
      return { openFiles: { ...st.openFiles, [workspaceId]: rest }, sessionFile, fileBuffers };
    }),
  fileBuffers: {},
  updateFileBuffer: (key, fn) =>
    set((st) => {
      const prev = st.fileBuffers[key];
      const next = fn(prev);
      if (next === prev) return {};
      const fileBuffers = { ...st.fileBuffers };
      if (next) {
        fileBuffers[key] = { ...next, dirty: next.buffer !== null && next.buffer !== next.base.contents };
      } else {
        delete fileBuffers[key];
      }
      return { fileBuffers };
    }),
  repoFilter: null,
  setRepoFilter: (repoFilter) => set({ repoFilter }),
  cloudSync: { state: "unknown", at: null },
  setCloudSync: (state) => set({ cloudSync: { state, at: Date.now() } }),
  density: readStoredDensity(),
  setDensity: (density) => {
    writeStoredDensity(density);
    applyDensity(density);
    set({ density });
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

  repoRailCollapsed: true,
  setRepoRailCollapsed: (collapsed) => set({ repoRailCollapsed: collapsed }),

  noteDrafts: {},
  setNoteDraft: (key, body) => {
    set({ noteDrafts: { ...get().noteDrafts, [key]: body } });
  },
  clearNoteDraft: (key) => {
    const { [key]: _, ...rest } = get().noteDrafts;
    set({ noteDrafts: rest });
  },

  notesComposerOpen: false,
  notesComposerRequest: 0,
  openNotesComposer: () =>
    set({
      notesComposerOpen: true,
      notesComposerRequest: get().notesComposerRequest + 1,
    }),
  closeNotesComposer: () => set({ notesComposerOpen: false }),

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
    // Any tab activation brings the tab stack back in front of an overlay
    // pane (Changes/Files/Notes/run).
    if (get().sessionPane[workspaceId] !== "tabs") {
      set((st) => ({ sessionPane: { ...st.sessionPane, [workspaceId]: "tabs" } }));
    }
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
    // Any tab activation brings the tab stack back in front of an overlay
    // pane (Changes/Files/Notes/run).
    if (get().sessionPane[workspaceId] !== "tabs") {
      set((st) => ({ sessionPane: { ...st.sessionPane, [workspaceId]: "tabs" } }));
    }
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
    // Any tab activation brings the tab stack back in front of an overlay
    // pane (Changes/Files/Notes/run).
    if (get().sessionPane[workspaceId] !== "tabs") {
      set((st) => ({ sessionPane: { ...st.sessionPane, [workspaceId]: "tabs" } }));
    }
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
    const { runPanel } = get();
    set({
      innerTabs: {},
      repoInnerTabs: {},
      activeWorkspaceContext: null,
      // Per-task view state is keyed by the previous account's task ids;
      // a pending run intent must never fire for the next account.
      sessionPane: {},
      sessionFile: {},
      runPanel: { ...runPanel, openTabs: [], activeTab: null, intents: {}, shown: {} },
      // Ids of the previous account's repositories / tasks: a stale repo
      // filter empties the board, a pending modal would act on a row the
      // new account can't see.
      repoFilter: null,
      fileSearchTarget: null,
      pendingGitInitRepoId: null,
      pendingNewWorkspaceRepoId: null,
      pendingRenameWorkspaceId: null,
      // Unsaved editor buffers belong to the previous account's worktrees.
      openFiles: {},
      fileBuffers: {},
    });
  },
  setActiveInnerTab: (workspaceId, tabId) => {
    // Any tab activation brings the tab stack back in front of an overlay
    // pane (Changes/Files/Notes/run).
    if (get().sessionPane[workspaceId] !== "tabs") {
      set((st) => ({ sessionPane: { ...st.sessionPane, [workspaceId]: "tabs" } }));
    }
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
    openTab: (id, taskId) => {
      const { runPanel, activeWorkspaceContext } = get();
      const task = taskId === undefined ? (activeWorkspaceContext?.workspaceId ?? null) : taskId;
      // No task on screen (the board): there is no pane bar to show the tab
      // in, and an intent recorded here must never be picked up by whatever
      // task (e.g. a worktree-less draft) mounts next.
      if (!task) return;
      const existing = runPanel.openTabs.includes(id)
        ? runPanel.openTabs
        : [...runPanel.openTabs, id];
      // Opening a run tab is an explicit "run it here", and brings that
      // task's run pane forward.
      const key = runKey(id, task);
      set((st) => ({
        sessionPane: { ...st.sessionPane, [task]: "run" },
        runPanel: {
          ...runPanel,
          openTabs: existing,
          activeTab: id,
          intents: { ...runPanel.intents, [key]: true },
          shown: { ...runPanel.shown, [key]: true },
        },
      }));
    },
    intents: {},
    shown: {},
    consumeIntent: (key) => {
      const { runPanel } = get();
      if (!runPanel.intents[key]) return false;
      const { [key]: _used, ...rest } = runPanel.intents;
      set({ runPanel: { ...runPanel, intents: rest } });
      return true;
    },
    closeTab: (id, taskId) => {
      const { runPanel, activeWorkspaceContext } = get();
      const task = taskId === undefined ? (activeWorkspaceContext?.workspaceId ?? null) : taskId;
      const key = runKey(id, task);
      const { [key]: _gone, ...shown } = runPanel.shown;
      const { [key]: _unused, ...intents } = runPanel.intents;
      // The tab stays open in any other task that still shows it.
      const prefix = `${id}@`;
      const elsewhere = Object.keys(shown).some((k) => k.startsWith(prefix));
      const openTabs = elsewhere ? runPanel.openTabs : runPanel.openTabs.filter((tab) => tab !== id);
      // Focus moves to another of THIS task's tabs, never to one that only
      // exists in a different task.
      const sameTask = openTabs.filter((tab) => tab !== id && shown[runKey(tab, task)]);
      set({
        runPanel: {
          ...runPanel,
          shown,
          intents,
          openTabs,
          activeTab:
            runPanel.activeTab === id
              ? (sameTask[sameTask.length - 1] ?? null)
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
