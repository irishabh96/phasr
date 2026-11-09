import { describe, expect, it } from "vitest";
import { runTabsForTask } from "./runTabs";
import type { RunningCommand } from "./types";

const running = (id: string, ws: string | null): RunningCommand =>
  ({ runCommandId: id, workspaceId: ws, startedAt: "", running: true, exitCode: null, port: null }) as RunningCommand;

describe("runTabsForTask", () => {
  it("shows a tab only in the task it was opened in", () => {
    const shown = { "dev@task-a": true as const };
    expect(runTabsForTask(["dev"], shown, [], "task-a")).toEqual(["dev"]);
    expect(runTabsForTask(["dev"], shown, [], "task-b")).toEqual([]);
  });
  it("also shows commands running here (e.g. started on task start)", () => {
    expect(runTabsForTask(["dev", "test"], {}, [running("test", "task-b")], "task-b")).toEqual(["test"]);
  });
  it("tolerates a missing running list", () => {
    expect(runTabsForTask(["dev"], {}, null, "t")).toEqual([]);
  });
});
