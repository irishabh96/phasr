import { describe, expect, it } from "vitest";
import { deriveTaskLane, formatAgo, formatElapsed, isToday, visibleBoardTasks } from "./board";
import type { Workspace } from "./types";

const ws = (over: Partial<Workspace>): Workspace => ({
  id: "w",
  repositoryId: "r",
  workspaceKind: "agent",
  name: "task",
  prompt: null,
  agent: "claude",
  command: "claude",
  status: "running",
  branch: "phasr/task",
  worktreePath: "/tmp/w",
  exitCode: null,
  createdAt: "2026-11-09T10:00:00Z",
  startedAt: "2026-11-09T10:00:00Z",
  finishedAt: null,
  archivedAt: null,
  updatedAt: "2026-11-09T10:00:00Z",
  ...over,
});

describe("deriveTaskLane", () => {
  it.each([
    ["pending", {}, "queued"],
    ["running", {}, "running"],
    ["running", { needsYou: true }, "needs-you"],
    ["failed", {}, "failed"],
    ["archived", {}, "done"],
    ["stopped", { changedFiles: 3 }, "review"],
    ["completed", { changedFiles: 0 }, "done"],
    ["stopped", {}, "review"],
  ] as const)("%s %j → %s", (status, signals, lane) => {
    expect(deriveTaskLane(ws({ status }), signals)).toBe(lane);
  });

  it("keeps the in-place local workspace off the board", () => {
    expect(deriveTaskLane(ws({ workspaceKind: "local", status: "running" }))).toBeNull();
  });
});

describe("formatElapsed", () => {
  const t0 = Date.parse("2026-11-09T10:00:00Z");
  it.each([
    [38, "38s"],
    [252, "4m 12s"],
    [21 * 60, "21m"],
    [125 * 60, "2h 5m"],
    [3 * 86400, "3d"],
  ])("%ss → %s", (secs, out) => {
    expect(formatElapsed("2026-11-09T10:00:00Z", t0 + secs * 1000)).toBe(out);
  });
  it("is null for a missing or bad timestamp", () => {
    expect(formatElapsed(null, t0)).toBeNull();
    expect(formatElapsed("nope", t0)).toBeNull();
  });
});

describe("formatAgo / isToday", () => {
  const t0 = Date.parse("2026-11-09T10:00:00Z");
  it("reads naturally", () => {
    expect(formatAgo("2026-11-09T09:42:00Z", t0)).toBe("18m ago");
    expect(formatAgo("2026-11-09T09:59:30Z", t0)).toBe("just now");
    expect(formatAgo("2026-11-08T09:00:00Z", t0)).toBe("yesterday");
  });
  it("isToday compares calendar days", () => {
    expect(isToday("2026-11-09T01:00:00Z", t0)).toBe(true);
    expect(isToday(null, t0)).toBe(false);
  });
});

describe("visibleBoardTasks", () => {
  const now = Date.parse("2026-11-09T12:00:00");
  const task = (id: string, lane: string, finishedAt: string | null, agent: Workspace["agent"] = "claude") => ({
    id,
    lane,
    workspace: { agent, archivedAt: null, finishedAt, updatedAt: "2020-01-01T00:00:00Z" },
  });
  const old = "2026-10-01T10:00:00";
  const today = "2026-11-09T09:00:00";

  it("keeps every non-done task and today's done ones", () => {
    const tasks = [task("r", "running", null), ...Array.from({ length: 7 }, (_, i) => task(`d${i}`, "done", old)), task("t", "done", today)];
    const ids = visibleBoardTasks(tasks, null, now).map((t) => t.id);
    expect(ids).toContain("r");
    expect(ids).toContain("t");
  });

  it("keeps only the first five older done tasks, in board order", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task(`d${i}`, "done", old));
    expect(visibleBoardTasks(tasks, null, now).map((t) => t.id)).toEqual(["d0", "d1", "d2", "d3", "d4"]);
  });

  it("applies the agent filter", () => {
    const tasks = [task("a", "running", null, "claude"), task("b", "running", null, "codex")];
    expect(visibleBoardTasks(tasks, "codex", now).map((t) => t.id)).toEqual(["b"]);
  });

  it("stays fast with thousands of done tasks (no per-task indexOf scan)", () => {
    const tasks = Array.from({ length: 20_000 }, (_, i) => task(`d${i}`, "done", old));
    const t = performance.now();
    expect(visibleBoardTasks(tasks, null, now)).toHaveLength(5);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
