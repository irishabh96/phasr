import { describe, expect, it } from "vitest";
import {
  BOARD_COLUMNS,
  boardColumnFor,
  deriveTaskLane,
  doneSummary,
  formatAgo,
  formatElapsed,
  groupBoardTasks,
  isToday,
  visibleBoardTasks,
  type TaskLane,
} from "./board";
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
    const tasks = [
      task("r", "running", null),
      ...Array.from({ length: 7 }, (_, i) => task(`d${i}`, "done", old)),
      task("t", "done", today),
    ];
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

describe("board columns", () => {
  it("are Queued · Needs you · Running · Review, with no Done column", () => {
    expect(BOARD_COLUMNS.map((c) => c.title)).toEqual(["Queued", "Needs you", "Running", "Review"]);
  });

  it.each([
    ["queued", "queued"],
    ["needs-you", "needs-you"],
    ["failed", "needs-you"],
    ["running", "running"],
    ["review", "review"],
    ["done", null],
  ] as const)("lane %s → column %s", (lane, column) => {
    expect(boardColumnFor(lane)).toBe(column);
  });
});

describe("groupBoardTasks", () => {
  const now = Date.parse("2026-11-09T12:00:00");
  const today = "2026-11-09T09:00:00";
  const old = "2026-10-01T10:00:00";
  const task = (
    id: string,
    lane: TaskLane,
    over: { agent?: Workspace["agent"]; outcome?: "merged" | "closed" | null; outcomeAt?: string | null } = {},
  ) => ({
    id,
    lane,
    workspace: {
      agent: over.agent ?? "claude",
      archivedAt: null,
      finishedAt: null,
      updatedAt: old,
      outcome: over.outcome ?? null,
      outcomeAt: over.outcomeAt ?? null,
    },
  });
  const ids = (ts: { id: string }[]) => ts.map((t) => t.id);

  it("puts each lane in its column and keeps done off the board", () => {
    const g = groupBoardTasks(
      [task("q", "queued"), task("n", "needs-you"), task("r", "running"), task("v", "review"), task("d", "done")],
      null,
      now,
    );
    expect(ids(g.columns.queued)).toEqual(["q"]);
    expect(ids(g.columns["needs-you"])).toEqual(["n"]);
    expect(ids(g.columns.running)).toEqual(["r"]);
    expect(ids(g.columns.review)).toEqual(["v"]);
    expect(ids(g.done)).toEqual(["d"]);
  });

  it("files failed tasks under Needs you, after the ones waiting on an answer", () => {
    const g = groupBoardTasks(
      [task("f1", "failed"), task("n1", "needs-you"), task("f2", "failed"), task("n2", "needs-you")],
      null,
      now,
    );
    expect(ids(g.columns["needs-you"])).toEqual(["n1", "n2", "f1", "f2"]);
  });

  it("counts done today, and says merged only when every one was merged", () => {
    const merged = [
      task("m1", "done", { outcome: "merged", outcomeAt: today }),
      task("m2", "done", { outcome: "merged", outcomeAt: today }),
      task("o", "done", { outcome: "merged", outcomeAt: old }),
    ];
    const g = groupBoardTasks(merged, null, now);
    expect(g.doneToday).toBe(2);
    expect(g.mergedToday).toBe(2);
    expect(doneSummary(g)).toBe("2 merged today");

    const mixed = groupBoardTasks([...merged, task("c", "done", { outcome: "closed", outcomeAt: today })], null, now);
    expect(doneSummary(mixed)).toBe("3 done today");
  });

  it("falls back to the total when nothing finished today, and to null with nothing done", () => {
    expect(doneSummary(groupBoardTasks([task("o", "done", { outcomeAt: old })], null, now))).toBe("1 done");
    expect(doneSummary(groupBoardTasks([task("r", "running")], null, now))).toBeNull();
  });

  it("lists done newest first", () => {
    const g = groupBoardTasks(
      [task("a", "done", { outcomeAt: old }), task("b", "done", { outcomeAt: today })],
      null,
      now,
    );
    expect(ids(g.done)).toEqual(["b", "a"]);
  });

  it("applies the agent filter to every column and the done count", () => {
    const g = groupBoardTasks(
      [
        task("a", "running", { agent: "claude" }),
        task("b", "running", { agent: "codex" }),
        task("c", "done", { agent: "claude", outcomeAt: today }),
      ],
      "codex",
      now,
    );
    expect(ids(g.columns.running)).toEqual(["b"]);
    expect(g.done).toHaveLength(0);
    expect(g.doneToday).toBe(0);
  });

  it("groups 20k tasks in one linear pass", () => {
    const lanes: TaskLane[] = ["queued", "needs-you", "running", "review", "failed", "done"];
    const tasks = Array.from({ length: 20_000 }, (_, i) => task(`t${i}`, lanes[i % lanes.length]!));
    const t = performance.now();
    const g = groupBoardTasks(tasks, null, now);
    expect(g.columns["needs-you"].length).toBe(Math.ceil(20_000 / 6) * 2 - 1);
    expect(performance.now() - t).toBeLessThan(500);
  });
});
