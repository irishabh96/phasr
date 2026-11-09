import { describe, expect, it } from "vitest";
import { sameBoardTask, stabilizeBoardTasks, type BoardTask } from "./useBoardTasks";
import type { Attention, Workspace } from "@/lib/types";

const workspace = (id: string) => ({ id, repositoryId: "r" }) as Workspace;
const attention = (): Attention => ({
  id: "att-1",
  kind: "shell",
  title: "Run tests",
  detail: "pnpm test",
  since: "2026-11-10T00:00:00Z",
  source: "hook",
  canRespond: true,
  canAllowForTask: false,
});
const task = (ws: Workspace, over: Partial<BoardTask> = {}): BoardTask => ({
  workspace: ws,
  repository: null,
  lane: "running",
  diff: null,
  activity: "Editing x.ts",
  attention: null,
  finishedAt: null,
  dependsOnName: null,
  notStarted: false,
  ...over,
});

describe("stabilizeBoardTasks", () => {
  it("keeps the previous object for an unchanged row, even when rebuilt", () => {
    const a = workspace("a");
    const b = workspace("b");
    const prev = [task(a), task(b, { diff: { files: 1, adds: 2, removes: 3 } })];
    const byId = new Map(prev.map((t) => [t.workspace.id, t]));
    // A fresh derivation: new objects everywhere, only A's activity moved.
    const next = stabilizeBoardTasks(byId, [
      task(a, { activity: "Reading y.ts" }),
      task(b, { diff: { files: 1, adds: 2, removes: 3 } }),
    ]);
    expect(next[0]).not.toBe(prev[0]);
    expect(next[0]?.activity).toBe("Reading y.ts");
    expect(next[1]).toBe(prev[1]);
  });

  it("compares attention by value, not identity", () => {
    const a = workspace("a");
    expect(
      sameBoardTask(task(a, { attention: attention() }), task(a, { attention: attention() })),
    ).toBe(true);
    expect(
      sameBoardTask(
        task(a, { attention: attention() }),
        task(a, { attention: { ...attention(), since: "2026-11-10T00:01:00Z" } }),
      ),
    ).toBe(false);
  });

  it("a changed workspace row is a changed task", () => {
    expect(sameBoardTask(task(workspace("a")), task(workspace("a")))).toBe(false);
  });
});
