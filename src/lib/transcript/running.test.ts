import { describe, expect, it } from "vitest";
import type { ToolItem, TranscriptItem } from "./contract";
import { chipSources, deriveRunningChips, fitCount, LINGER_MS, NO_ENDS, noteEnds, type ChipSource } from "./running";

const ts = "2026-11-11T10:00:00.000Z";
const tool = (id: string, extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id,
  ts,
  tool: "Read",
  input: {},
  title: `Reading ${id}`,
  status: "done",
  ...extra,
});
const agent = (id: string, extra: Partial<ToolItem> = {}): ToolItem =>
  tool(id, {
    tool: "Agent",
    title: `Running a subagent: ${id}`,
    status: "running",
    subagent: { type: "general-purpose", description: `Do ${id}`, steps: 0 },
    ...extra,
  });
const shell = (id: string, command: string, backgroundStatus: NonNullable<ToolItem["backgroundStatus"]>, extra: Partial<ToolItem> = {}): ToolItem =>
  tool(id, { tool: "Bash", input: { command, run_in_background: true }, title: `Running ${command}`, background: true, backgroundStatus, ...extra });

const none = new Set<string>();
const derive = (sources: ChipSource[], o: { now?: number; ended?: Map<string, number>; pinned?: Set<string>; dismissed?: Set<string> } = {}) =>
  deriveRunningChips(sources, { now: o.now ?? 0, ended: o.ended ?? new Map(), pinned: o.pinned ?? none, dismissed: o.dismissed ?? none });

describe("chipSources", () => {
  it("lists every subagent (nested too) and background command, in order, with its live status and steps", () => {
    const items: TranscriptItem[] = [
      { kind: "user", id: "u", ts, text: "go" },
      agent("a1", { subagent: { type: "Explore", description: "Map the auth module", steps: 1 } }),
      tool("a1-s1", { parentId: "a1" }),
      tool("a1-s2", { parentId: "a1" }),
      shell("bg1", "pnpm dev\n# server", "running"),
      agent("a2", { status: "done", parentId: "a1" }),
      agent("a3", { status: "error" }),
      agent("a4", { status: "done", backgroundStatus: "running" }),
      shell("bg2", "sleep 3", "done"),
      shell("bg3", "sleep 60", "killed"),
      shell("bg4", "make", "failed"),
      tool("fg", { tool: "Bash", input: { command: "ls" } }),
    ];
    const sources = chipSources(items);
    expect(sources.map((s) => [s.kind, s.id, s.status])).toEqual([
      ["subagent", "a1", "running"],
      ["shell", "bg1", "running"],
      ["subagent", "a2", "done"],
      ["subagent", "a3", "failed"],
      // A backgrounded subagent: its call returned, it works on.
      ["subagent", "a4", "running"],
      ["shell", "bg2", "done"],
      ["shell", "bg3", "stopped"],
      ["shell", "bg4", "failed"],
    ]);
    // Steps: the larger of the CLI's count and the calls nested under it.
    // (Its nested subagent is one of its calls.)
    expect(sources[0]).toMatchObject({ label: "Map the auth module", steps: 3, agentType: "Explore", startedAt: ts });
    // A command's first line.
    expect(sources[1]).toMatchObject({ label: "pnpm dev", steps: 0 });
    expect(chipSources([])).toEqual([]);
  });
});

describe("the linger after a chip finishes", () => {
  const running: ChipSource = { kind: "subagent", id: "a", label: "a", startedAt: ts, status: "running", steps: 1 };
  const done: ChipSource = { ...running, status: "done" };

  it("notes when a chip seen running finishes, once; one already over when first seen never lingers", () => {
    const t1 = noteEnds(NO_ENDS, [running], 1000);
    expect(t1.running.has("a")).toBe(true);
    expect(t1.ended.size).toBe(0);
    // Unchanged: the same tracker.
    expect(noteEnds(t1, [running], 1500)).toBe(t1);
    const t2 = noteEnds(t1, [done], 2000);
    expect(t2.ended.get("a")).toBe(2000);
    expect(noteEnds(t2, [done], 9000)).toBe(t2);
    // Over before it was ever seen running (a reload): nothing to linger.
    expect(noteEnds(NO_ENDS, [done], 3000).ended.size).toBe(0);
  });

  it("shows a finished chip for LINGER_MS after it ended, then drops it", () => {
    const ended = new Map([["a", 10_000]]);
    expect(derive([running]).map((c) => c.id)).toEqual(["a"]);
    expect(derive([done], { ended, now: 10_000 + LINGER_MS - 1 })).toMatchObject([{ id: "a", status: "done", endedAt: 10_000, pinned: false }]);
    expect(derive([done], { ended, now: 10_000 + LINGER_MS })).toEqual([]);
    expect(derive([done], { now: 10_000 })).toEqual([]);
  });

  it("keeps a pinned chip after it finishes, until it's unpinned or dismissed", () => {
    const ended = new Map([["a", 0]]);
    const pinned = new Set(["a"]);
    expect(derive([done], { ended, now: 60_000, pinned })).toMatchObject([{ id: "a", pinned: true }]);
    // Pinned while still running: shows pinned.
    expect(derive([running], { pinned })).toMatchObject([{ id: "a", pinned: true, status: "running" }]);
    expect(derive([done], { ended, now: 60_000 })).toEqual([]);
    expect(derive([done], { ended, now: 1000, pinned, dismissed: new Set(["a"]) })).toEqual([]);
    // Dismissed during its linger: gone at once.
    expect(derive([done], { ended, now: 1000, dismissed: new Set(["a"]) })).toEqual([]);
  });
});

describe("fitCount (the +N overflow)", () => {
  it("shows them all when they fit, or when not measured yet", () => {
    expect(fitCount([100, 100, 100], 316, 8, 44)).toBe(3);
    expect(fitCount([100, 100, 100], 0, 8, 44)).toBe(3);
    expect(fitCount([], 300, 8, 44)).toBe(0);
  });

  it("keeps room for the +N button when not all fit", () => {
    // 100 + 8 + 100 = 208, +44 = 252 ≤ 260; a third would need 360.
    expect(fitCount([100, 100, 100], 260, 8, 44)).toBe(2);
    expect(fitCount([100, 100, 100], 315, 8, 44)).toBe(2);
    // Not even one beside the +N: only the +N.
    expect(fitCount([300, 100], 200, 8, 44)).toBe(0);
  });
});
