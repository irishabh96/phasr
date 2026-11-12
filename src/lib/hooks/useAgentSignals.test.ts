import { describe, expect, it } from "vitest";
import { upsertAgentState } from "./useAgentSignals";
import type { TaskAgentState } from "@/lib/types";

const st = (taskId: string, state: TaskAgentState["state"]): TaskAgentState => ({
  taskId,
  repositoryId: "r",
  state,
  attention: null,
  lastActivity: null,
  lastTurnEndedAt: null,
});

describe("upsertAgentState", () => {
  it("adds a task it hasn't seen", () => {
    expect(upsertAgentState(undefined, st("a", "working"))).toEqual([st("a", "working")]);
  });
  it("replaces by task id without touching others", () => {
    const prev = [st("a", "working"), st("b", "idle")];
    const next = upsertAgentState(prev, st("a", "needs-you"));
    expect(next).toEqual([st("a", "needs-you"), st("b", "idle")]);
    expect(prev[0]!.state).toBe("working");
  });
});
