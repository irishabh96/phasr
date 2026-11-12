import { describe, expect, it } from "vitest";
import { prependNotification } from "./useInbox";
import { upsertCheckRun, upsertRunningCommand } from "./useReview";
import type { AppNotification, CheckRun, CheckSummary, RunningCommand } from "@/lib/types";

const run = (id: string, runCommandId: string, status: CheckRun["status"]): CheckRun => ({
  id,
  workspaceId: "ws",
  runCommandId,
  name: runCommandId,
  command: "true",
  status,
  exitCode: null,
  fingerprint: "fp",
  createdAt: "2026-11-09T10:00:00Z",
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  outputTail: "",
});

describe("upsertCheckRun", () => {
  it("replaces the command's previous run and appends new commands", () => {
    const summary: CheckSummary = {
      runs: [run("r1", "test", "passed")],
      required: ["test"],
      requiredSatisfied: true,
      staleIds: [],
      needsConfirmation: [],
    };
    const rerun = upsertCheckRun(summary, run("r2", "test", "running"));
    expect(rerun?.runs.map((r) => r.id)).toEqual(["r2"]);
    const lint = upsertCheckRun(rerun, run("r3", "lint", "queued"));
    expect(lint?.runs.map((r) => r.id)).toEqual(["r2", "r3"]);
    expect(upsertCheckRun(undefined, run("x", "y", "queued"))).toBeUndefined();
  });
});

describe("upsertRunningCommand", () => {
  it("keys by run command AND task", () => {
    const a: RunningCommand = {
      runCommandId: "dev",
      workspaceId: "ws-a",
      startedAt: "2026-11-09T10:00:00Z",
      running: true,
      exitCode: null,
      port: null,
    };
    const b = { ...a, workspaceId: "ws-b" };
    const list = upsertRunningCommand(upsertRunningCommand([], a), b);
    expect(list).toHaveLength(2);
    const withPort = upsertRunningCommand(list, { ...a, port: 5173 });
    expect(withPort.find((r) => r.workspaceId === "ws-a")?.port).toBe(5173);
    expect(withPort.find((r) => r.workspaceId === "ws-b")?.port).toBeNull();
  });
});

describe("prependNotification", () => {
  const n = (id: string): AppNotification => ({
    id,
    workspaceId: null,
    repositoryId: null,
    kind: "task_failed",
    title: id,
    body: null,
    payload: {},
    createdAt: "2026-11-09T10:00:00Z",
    readAt: null,
  });

  it("prepends once and respects the list's limit", () => {
    const list = prependNotification([n("a")], n("b"), 2);
    expect(list?.map((x) => x.id)).toEqual(["b", "a"]);
    expect(prependNotification(list, n("b"), 2)).toBe(list);
    expect(prependNotification(list, n("c"), 2)?.map((x) => x.id)).toEqual(["c", "b"]);
    expect(prependNotification(undefined, n("c"), null)).toBeUndefined();
  });
});
