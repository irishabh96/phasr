import { describe, expect, it } from "vitest";
import { activeRunTabFor, runKey, runningIn, runTabsForTask, runTarget } from "./runScope";
import type { RunningCommand } from "./types";

const running = (id: string, ws: string | null, isRunning = true): RunningCommand => ({
  runCommandId: id,
  workspaceId: ws,
  startedAt: "",
  running: isRunning,
  exitCode: null,
  port: null,
});

describe("runTarget", () => {
  it("is the task's worktree, or the repo checkout when it has none", () => {
    expect(runTarget({ id: "t1", worktreePath: "/wt/t1" })).toBe("t1");
    expect(runTarget({ id: "draft", worktreePath: null })).toBeNull();
    expect(runTarget(undefined)).toBeNull();
  });
});

describe("runKey", () => {
  it("keys by the task, and the board never collides with a task", () => {
    expect(runKey("dev", "t1")).not.toBe(runKey("dev", "t2"));
    expect(runKey("dev", null)).not.toBe(runKey("dev", "t1"));
    expect(runKey("dev", undefined)).toBe(runKey("dev", null));
  });
});

describe("runningIn", () => {
  const all = [running("dev", "t1"), running("test", "t2"), running("lint", null)];
  it("keeps only the exact target", () => {
    expect(runningIn(all, "t1").map((r) => r.runCommandId)).toEqual(["dev"]);
    // The backend answers `null` with every scope; only the checkout's own count.
    expect(runningIn(all, null).map((r) => r.runCommandId)).toEqual(["lint"]);
  });
  it("tolerates a missing list", () => {
    expect(runningIn(undefined, null)).toEqual([]);
  });
});

describe("runTabsForTask", () => {
  it("shows a tab only in the task it was opened in", () => {
    const shown = { [runKey("dev", "task-a")]: true as const };
    expect(runTabsForTask(["dev"], shown, [], "task-a", "task-a")).toEqual(["dev"]);
    expect(runTabsForTask(["dev"], shown, [], "task-b", "task-b")).toEqual([]);
  });

  it("scopes worktree-less tasks by task, not by the shared checkout", () => {
    const shown = { [runKey("dev", "draft-a")]: true as const };
    expect(runTabsForTask(["dev"], shown, [], "draft-a", null)).toEqual(["dev"]);
    expect(runTabsForTask(["dev"], shown, [], "draft-b", null)).toEqual([]);
  });

  it("also shows commands running in this task's worktree", () => {
    expect(runTabsForTask(["dev", "test"], {}, [running("test", "task-b")], "task-b", "task-b")).toEqual(["test"]);
  });

  it("never lists another task's running command (the `null` list holds every scope)", () => {
    const all = [running("dev", "task-a"), running("lint", null)];
    expect(runTabsForTask(["dev", "lint"], {}, all, "draft", null)).toEqual([]);
    expect(runTabsForTask(["dev"], {}, all, "task-b", "task-b")).toEqual([]);
  });

  it("ignores exited commands and a missing list", () => {
    expect(runTabsForTask(["dev"], {}, [running("dev", "t", false)], "t", "t")).toEqual([]);
    expect(runTabsForTask(["dev"], {}, null, "t", "t")).toEqual([]);
  });
});

describe("activeRunTabFor", () => {
  it("keeps the active tab when it is this task's", () => {
    expect(activeRunTabFor("dev", ["dev", "test"])).toBe("dev");
  });
  it("falls back to this task's newest tab when the active one is elsewhere", () => {
    expect(activeRunTabFor("other", ["dev", "test"])).toBe("test");
    expect(activeRunTabFor(null, [])).toBeNull();
  });
});
