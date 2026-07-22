import { beforeEach, describe, expect, it } from "vitest";
import { BRIEF_TAB_ID, COMMENTS_TAB_ID, useUiStore } from "./store";

/**
 * The subtask inner-tab seed (bug #3): a subtask whose agent has already been
 * spawned (it owns a worktree → real terminal output exists) must land on the
 * live "main" Terminal, NOT the Brief — so opening a running subtask shows what
 * the agent is doing. A not-yet-started subtask still lands on the Brief.
 */
describe("ensureInnerTabs — subtask default tab", () => {
  beforeEach(() => {
    useUiStore.setState({ innerTabs: {} });
  });

  it("seeds a non-subtask workspace with a single closable main tab (unchanged)", () => {
    useUiStore.getState().ensureInnerTabs("ws-agent", "claude", false);
    const state = useUiStore.getState().innerTabs["ws-agent"];
    expect(state?.tabs.map((t) => t.kind)).toEqual(["main"]);
    expect(state?.activeTabId).toBe(state?.tabs[0]?.id);
  });

  it("seeds a subtask with [brief, main, comments]", () => {
    useUiStore.getState().ensureInnerTabs("ws-sub", "Terminal", true, "brief");
    const state = useUiStore.getState().innerTabs["ws-sub"];
    expect(state?.tabs.map((t) => t.kind)).toEqual([
      "brief",
      "main",
      "comments",
    ]);
    expect(state?.tabs.map((t) => t.id)).toContain(BRIEF_TAB_ID);
    expect(state?.tabs.map((t) => t.id)).toContain(COMMENTS_TAB_ID);
  });

  it("a not-yet-started subtask (seedActive 'brief') lands on the Brief tab", () => {
    useUiStore.getState().ensureInnerTabs("ws-sub", "Terminal", true, "brief");
    expect(useUiStore.getState().innerTabs["ws-sub"]?.activeTabId).toBe(
      BRIEF_TAB_ID,
    );
  });

  it("a live/started subtask (seedActive 'main') lands on the Terminal (main) tab", () => {
    useUiStore.getState().ensureInnerTabs("ws-sub", "Terminal", true, "main");
    const state = useUiStore.getState().innerTabs["ws-sub"];
    const mainTab = state?.tabs.find((t) => t.kind === "main");
    expect(state?.activeTabId).toBe(mainTab?.id);
    expect(state?.activeTabId).not.toBe(BRIEF_TAB_ID);
  });

  it("defaults to the Brief tab when seedActive is omitted (back-compat)", () => {
    useUiStore.getState().ensureInnerTabs("ws-sub", "Terminal", true);
    expect(useUiStore.getState().innerTabs["ws-sub"]?.activeTabId).toBe(
      BRIEF_TAB_ID,
    );
  });

  it("is a no-op once tabs already exist — never re-seeds the active tab", () => {
    useUiStore.getState().ensureInnerTabs("ws-sub", "Terminal", true, "main");
    const first = useUiStore.getState().innerTabs["ws-sub"];
    // A later re-seed (e.g. an effect re-run) must not flip the user off "main".
    useUiStore.getState().ensureInnerTabs("ws-sub", "Terminal", true, "brief");
    const second = useUiStore.getState().innerTabs["ws-sub"];
    expect(second).toBe(first);
    expect(second?.activeTabId).toBe(first?.activeTabId);
  });
});
