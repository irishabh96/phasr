import { create } from "zustand";
import { applyTheme, readStoredTheme, writeStoredTheme, type Theme } from "./theme";

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

interface UiState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  runPanel: RunPanelState;
}

export const useUiStore = create<UiState>((set, get) => ({
  theme: readStoredTheme(),
  setTheme: (theme) => {
    writeStoredTheme(theme);
    applyTheme(theme);
    set({ theme });
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
