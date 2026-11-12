import { beforeEach, describe, expect, it } from "vitest";
import { runKey } from "@/lib/runScope";
import { useUiStore } from "@/lib/store";

const s = () => useUiStore.getState();
const rp = () => useUiStore.getState().runPanel;

beforeEach(() => {
  s().resetForAccountSwitch();
});

describe("runPanel scope", () => {
  it("opens a tab in the task on screen and brings its run pane forward", () => {
    s().setActiveWorkspaceContext({ workspaceId: "t1", repositoryId: "r" });
    rp().openTab("dev");
    expect(rp().shown[runKey("dev", "t1")]).toBe(true);
    expect(rp().intents[runKey("dev", "t1")]).toBe(true);
    expect(s().sessionPane.t1).toBe("run");
    expect(rp().shown[runKey("dev", "t2")]).toBeUndefined();
  });

  it("an explicit task wins over the context", () => {
    s().setActiveWorkspaceContext({ workspaceId: "t1", repositoryId: "r" });
    rp().openTab("dev", "t2");
    expect(rp().shown[runKey("dev", "t2")]).toBe(true);
    expect(rp().shown[runKey("dev", "t1")]).toBeUndefined();
  });

  it("an intent is consumed only by the task it was created in", () => {
    rp().openTab("dev", "draft-a");
    expect(rp().consumeIntent(runKey("dev", "draft-b"))).toBe(false);
    expect(rp().consumeIntent(runKey("dev", "draft-a"))).toBe(true);
    expect(rp().consumeIntent(runKey("dev", "draft-a"))).toBe(false);
  });

  it("opening on the board records nothing a later draft could consume", () => {
    s().setActiveWorkspaceContext(null);
    rp().openTab("dev");
    expect(rp().openTabs).toEqual([]);
    expect(rp().intents).toEqual({});
    // The next worktree-less draft mounts its tab under its own id.
    expect(rp().consumeIntent(runKey("dev", "draft"))).toBe(false);
    expect(rp().consumeIntent(runKey("dev", null))).toBe(false);
  });

  it("closing in one task leaves the tab open in another", () => {
    rp().openTab("dev", "t1");
    rp().openTab("dev", "t2");
    rp().closeTab("dev", "t2");
    expect(rp().shown[runKey("dev", "t2")]).toBeUndefined();
    expect(rp().shown[runKey("dev", "t1")]).toBe(true);
    expect(rp().openTabs).toEqual(["dev"]);
    rp().closeTab("dev", "t1");
    expect(rp().openTabs).toEqual([]);
  });

  it("closing drops that task's pending intent", () => {
    rp().openTab("dev", "t1");
    rp().closeTab("dev", "t1");
    expect(rp().intents[runKey("dev", "t1")]).toBeUndefined();
  });

  it("focus moves to another tab of the same task, never one from another task", () => {
    rp().openTab("test", "t2");
    rp().openTab("lint", "t1");
    rp().openTab("dev", "t1");
    rp().closeTab("dev", "t1");
    expect(rp().activeTab).toBe("lint");
    rp().closeTab("lint", "t1");
    expect(rp().activeTab).toBeNull();
  });
});

describe("resetForAccountSwitch", () => {
  it("forgets per-task view state and run tabs, intents included", () => {
    s().setActiveWorkspaceContext({ workspaceId: "t1", repositoryId: "r" });
    s().setSessionPane("t1", "changes");
    s().openSessionFile("t1", "src/a.ts");
    s().setRepoFilter("r");
    rp().openTab("dev", "t1");

    s().resetForAccountSwitch();

    expect(s().sessionPane).toEqual({});
    expect(s().sessionFile).toEqual({});
    expect(s().repoFilter).toBeNull();
    expect(s().activeWorkspaceContext).toBeNull();
    expect(rp().openTabs).toEqual([]);
    expect(rp().activeTab).toBeNull();
    expect(rp().intents).toEqual({});
    expect(rp().shown).toEqual({});
    // The panel's actions survive the reset.
    rp().openTab("dev", "t9");
    expect(rp().shown[runKey("dev", "t9")]).toBe(true);
  });
});
