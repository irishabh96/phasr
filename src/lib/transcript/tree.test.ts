import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./contract";
import { ancestorsOf, formatElapsed, groupTranscript, runningBackgroundShells } from "./tree";

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

describe("runningBackgroundShells", () => {
  it("lists only background commands still running, with their command", () => {
    const items = [
      tool("bg1", { tool: "Bash", input: { command: "pnpm dev\n# server", run_in_background: true }, background: true, backgroundStatus: "running" }),
      tool("bg2", { tool: "Bash", input: { command: "sleep 3" }, background: true, backgroundStatus: "done" }),
      tool("bg3", { tool: "Bash", input: { command: "sleep 60" }, background: true, backgroundStatus: "killed" }),
      tool("fg", { tool: "Bash", input: { command: "ls" } }),
      tool("nested", { tool: "Bash", input: {}, title: "Running make watch", parentId: "agent", background: true, backgroundStatus: "running" }),
    ];
    expect(runningBackgroundShells(items)).toEqual([
      { id: "bg1", command: "pnpm dev", startedAt: ts, status: "running" },
      { id: "nested", command: "make watch", startedAt: ts, status: "running" },
    ]);
    expect(runningBackgroundShells([])).toEqual([]);
  });

  it("formats how long a command has run", () => {
    const start = Date.parse(ts);
    expect(formatElapsed(ts, start + 12_400)).toBe("12s");
    expect(formatElapsed(ts, start + 4 * 60_000 + 3_000)).toBe("4m 3s");
    expect(formatElapsed(ts, start + 62 * 60_000)).toBe("1h 2m");
    expect(formatElapsed(ts, start - 5_000)).toBe("0s");
    expect(formatElapsed("not a date", start)).toBe("");
  });
});
