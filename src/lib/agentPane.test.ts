import { beforeEach, describe, expect, it } from "vitest";
import { isAgentPaneActive } from "@/lib/agentPane";
import { useUiStore } from "@/lib/store";

const s = () => useUiStore.getState();
const onAgent = (taskId = "t1") => isAgentPaneActive(s(), taskId);

beforeEach(() => {
  s().resetForAccountSwitch();
});

describe("where the approval card may show", () => {
  it("is the agent tab, in front — including before the tabs are seeded", () => {
    expect(onAgent()).toBe(true);
    s().ensureInnerTabs("t1", "claude");
    expect(onAgent()).toBe(true);
  });

  it("is not a shell tab; switching back to the agent tab brings it back", () => {
    s().ensureInnerTabs("t1", "claude");
    const main = s().innerTabs.t1!.tabs[0]!;
    s().openInnerTerminalTab("t1");
    s().openInnerTerminalTab("t1");
    expect(s().innerTabs.t1!.tabs.at(-1)!.title).toBe("Terminal 2");
    expect(onAgent()).toBe(false);
    s().setActiveInnerTab("t1", main.id);
    expect(onAgent()).toBe(true);
  });

  it("is not Changes, Files, Notes or a run tab, even with the agent tab selected underneath", () => {
    s().ensureInnerTabs("t1", "claude");
    for (const pane of ["changes", "files", "notes", "run"] as const) {
      s().setSessionPane("t1", pane);
      expect(onAgent()).toBe(false);
    }
    s().setSessionPane("t1", "tabs");
    expect(onAgent()).toBe(true);
  });

  it("is not a file preview, and is per task", () => {
    s().ensureInnerTabs("t1", "claude");
    s().ensureInnerTabs("t2", "codex");
    s().openInnerPreviewTab("t1", "src/main.ts");
    expect(onAgent("t1")).toBe(false);
    expect(onAgent("t2")).toBe(true);
  });

  it("is nowhere once the agent tab is closed, until it is opened again", () => {
    s().ensureInnerTabs("t1", "claude");
    const main = s().innerTabs.t1!.tabs[0]!;
    s().openInnerTerminalTab("t1");
    s().closeInnerTab("t1", main.id);
    expect(onAgent()).toBe(false);
    s().openInnerAgentTab("t1", "claude");
    expect(onAgent()).toBe(true);
  });
});
