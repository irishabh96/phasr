import { beforeEach, describe, expect, it } from "vitest";
import { useSubagentStore } from "./subagentStore";

const store = () => useSubagentStore.getState();

describe("subagent selection and chip pins (per task)", () => {
  beforeEach(() => {
    useSubagentStore.setState({ selectedSubagent: {}, pinned: {}, dismissed: {}, openSeq: 0 });
  });

  it("selects, switches and goes back", () => {
    store().selectSubagent("t1", "agent-1");
    expect(store().selectedSubagent).toEqual({ t1: "agent-1" });
    store().selectSubagent("t1", "agent-2");
    expect(store().selectedSubagent.t1).toBe("agent-2");
    store().clearSubagent("t1");
    expect(store().selectedSubagent).toEqual({});
    // Back with nothing selected: no change.
    const before = store();
    store().clearSubagent("t1");
    expect(store()).toBe(before);
  });

  it("every open counts, even a repeat (it expands a collapsed inspector)", () => {
    store().selectSubagent("t1", "agent-1");
    store().selectSubagent("t1", "agent-1");
    expect(store().openSeq).toBe(2);
  });

  it("keeps one selection per task: switching tasks and back finds it again", () => {
    store().selectSubagent("t1", "agent-1");
    store().selectSubagent("t2", "agent-9");
    expect(store().selectedSubagent).toEqual({ t1: "agent-1", t2: "agent-9" });
    store().clearSubagent("t2");
    expect(store().selectedSubagent).toEqual({ t1: "agent-1" });
  });

  it("clears a selection whose item is gone only if it's still the one shown", () => {
    store().selectSubagent("t1", "agent-2");
    // A late "agent-1 is gone" doesn't close agent-2.
    store().clearSubagent("t1", "agent-1");
    expect(store().selectedSubagent.t1).toBe("agent-2");
    store().clearSubagent("t1", "agent-2");
    expect(store().selectedSubagent.t1).toBeUndefined();
  });

  it("pins and unpins per task; dismissing unpins and keeps it gone", () => {
    store().togglePin("t1", "a");
    store().togglePin("t1", "b");
    store().togglePin("t2", "a");
    expect(store().pinned).toEqual({ t1: ["a", "b"], t2: ["a"] });
    store().togglePin("t1", "a");
    expect(store().pinned.t1).toEqual(["b"]);
    store().dismissChip("t1", "b");
    expect(store().pinned.t1).toEqual([]);
    expect(store().dismissed.t1).toEqual(["b"]);
    store().dismissChip("t1", "b");
    expect(store().dismissed.t1).toEqual(["b"]);
  });

  it("forgets a task that's gone", () => {
    store().selectSubagent("t1", "agent-1");
    store().togglePin("t1", "a");
    store().dismissChip("t1", "b");
    store().selectSubagent("t2", "agent-2");
    store().forgetTask("t1");
    expect(store().selectedSubagent).toEqual({ t2: "agent-2" });
    expect(store().pinned.t1).toBeUndefined();
    expect(store().dismissed.t1).toBeUndefined();
  });
});
