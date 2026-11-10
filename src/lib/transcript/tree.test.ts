import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./contract";
import { ancestorsOf, descendantsOf, formatElapsed, groupTranscript, isSubagentRunning, subagentSteps, subagentTree } from "./tree";

const ts = "2026-11-11T10:00:00.000Z";
const user = (id: string, parentId?: string): TranscriptItem => ({ kind: "user", id, ts, text: id, ...(parentId ? { parentId } : {}) });
const tool = (id: string, extra: Partial<Extract<TranscriptItem, { kind: "tool" }>> = {}): TranscriptItem => ({
  kind: "tool",
  id,
  ts,
  tool: "Read",
  input: {},
  title: `Reading ${id}`,
  status: "done",
  ...extra,
});

describe("groupTranscript", () => {
  it("leaves a transcript without subagents as it is", () => {
    const items = [user("u1"), tool("t1")];
    const tree = groupTranscript(items);
    expect(tree.top).toBe(items);
    expect(tree.children.size).toBe(0);
  });

  it("nests each subagent's items under its call, in order, and parallel calls stay siblings", () => {
    const items = [
      user("u1"),
      tool("agentA", { tool: "Agent", subagent: { type: "general-purpose", description: "a", steps: 2 } }),
      tool("agentB", { tool: "Agent", subagent: { type: "general-purpose", description: "b", steps: 1 } }),
      tool("a1", { parentId: "agentA" }),
      tool("b1", { parentId: "agentB" }),
      tool("a2", { parentId: "agentA" }),
      tool("t2"),
    ];
    const tree = groupTranscript(items);
    expect(tree.top.map((i) => i.id)).toEqual(["u1", "agentA", "agentB", "t2"]);
    expect(tree.children.get("agentA")?.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(tree.children.get("agentB")?.map((i) => i.id)).toEqual(["b1"]);
  });

  it("nests subagents of subagents, and keeps an orphan in the main conversation", () => {
    const items = [
      tool("outer", { tool: "Agent" }),
      tool("inner", { tool: "Agent", parentId: "outer" }),
      tool("deep", { parentId: "inner" }),
      // Its call fell outside the newest-5000 window.
      tool("orphan", { parentId: "gone" }),
      // A self-reference can't hide an item.
      tool("self", { parentId: "self" }),
    ];
    const tree = groupTranscript(items);
    expect(tree.top.map((i) => i.id)).toEqual(["outer", "orphan", "self"]);
    expect(tree.children.get("outer")?.map((i) => i.id)).toEqual(["inner"]);
    expect(tree.children.get("inner")?.map((i) => i.id)).toEqual(["deep"]);
    expect(ancestorsOf(items, "deep")).toEqual(["outer", "inner"]);
    expect(ancestorsOf(items, "outer")).toEqual([]);
    expect(ancestorsOf(items, "orphan")).toEqual([]);
  });
});

describe("a subagent's own items (its panel)", () => {
  const sub = (id: string, extra: Partial<Extract<TranscriptItem, { kind: "tool" }>> = {}) =>
    tool(id, { tool: "Agent", status: "running", subagent: { type: "general-purpose", description: id, steps: 0 }, ...extra });
  const items = [
    user("u1"),
    sub("outer"),
    tool("o1", { parentId: "outer" }),
    sub("other"),
    tool("x1", { parentId: "other" }),
    sub("inner", { parentId: "outer" }),
    tool("i1", { parentId: "inner" }),
    sub("deeper", { parentId: "inner" }),
    tool("d1", { parentId: "deeper" }),
    tool("o2", { parentId: "outer" }),
    tool("t2"),
  ];

  it("lists a call's direct items in order, nested subagents' items under their own calls", () => {
    const tree = subagentTree(items, "outer");
    expect(tree.top.map((i) => i.id)).toEqual(["o1", "inner", "o2"]);
    expect(tree.children.get("inner")?.map((i) => i.id)).toEqual(["i1", "deeper"]);
    expect(tree.children.get("deeper")?.map((i) => i.id)).toEqual(["d1"]);
    // A nested subagent is a panel of its own too.
    expect(subagentTree(items, "inner").top.map((i) => i.id)).toEqual(["i1", "deeper"]);
    // A sibling's items aren't its own; an unknown call has none.
    expect(subagentTree(items, "other").top.map((i) => i.id)).toEqual(["x1"]);
    expect(subagentTree(items, "nope").top).toEqual([]);
  });

  it("collects everything under a call, recursively, in transcript order", () => {
    expect(descendantsOf(items, "outer").map((i) => i.id)).toEqual(["o1", "inner", "i1", "deeper", "d1", "o2"]);
    expect(descendantsOf(items, "deeper").map((i) => i.id)).toEqual(["d1"]);
    expect(descendantsOf(items, "t2")).toEqual([]);
    // A cycle can't loop it.
    const cyclic = [tool("a", { parentId: "b" }), tool("b", { parentId: "a" })];
    expect(descendantsOf(cyclic, "a").map((i) => i.id)).toEqual(["b"]);
  });

  it("counts its steps (the CLI's count or the calls under it, the larger) and whether it's at work", () => {
    const call = sub("s", { subagent: { type: "Explore", description: "s", steps: 1 } }) as Extract<TranscriptItem, { kind: "tool" }>;
    expect(subagentSteps(call, [tool("a"), tool("b"), user("c")])).toBe(2);
    expect(subagentSteps(call, undefined)).toBe(1);
    expect(isSubagentRunning(call)).toBe(true);
    expect(isSubagentRunning({ ...call, status: "done" })).toBe(false);
    // Backgrounded: its call returned, it works on.
    expect(isSubagentRunning({ ...call, status: "done", backgroundStatus: "running" })).toBe(true);
  });
});

describe("formatElapsed", () => {
  it("formats how long a command has run", () => {
    const start = Date.parse(ts);
    expect(formatElapsed(ts, start + 12_400)).toBe("12s");
    expect(formatElapsed(ts, start + 4 * 60_000 + 3_000)).toBe("4m 3s");
    expect(formatElapsed(ts, start + 62 * 60_000)).toBe("1h 2m");
    expect(formatElapsed(ts, start - 5_000)).toBe("0s");
    expect(formatElapsed("not a date", start)).toBe("");
  });
});
