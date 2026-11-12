import { describe, expect, it } from "vitest";
import { patchCardAgentState, patchCardAgentStates } from "./useTaskCards";
import type { TaskAgentState, TaskCard, Workspace } from "@/lib/types";

function card(id: string): TaskCard {
  const workspace = { id, repositoryId: "r" } as Workspace;
  return {
    workspace,
    lane: "running",
    diff: null,
    agentState: null,
    usage: null,
    finishedAt: null,
    dependsOnName: null,
  };
}

const state = (taskId: string, lastActivity: string): TaskAgentState => ({
  taskId,
  repositoryId: "r",
  state: "working",
  attention: null,
  lastActivity,
  lastTurnEndedAt: null,
});

describe("patchCardAgentState", () => {
  it("replaces only the matching card's agent state", () => {
    const cards = [card("a"), card("b")];
    const next = patchCardAgentState(cards, state("b", "Editing x.ts"));
    expect(next?.[1]?.agentState?.lastActivity).toBe("Editing x.ts");
    expect(next?.[0]).toBe(cards[0]);
    expect(cards[1]?.agentState).toBeNull();
  });

  it("patches a batch into one list, keeping untouched cards by identity", () => {
    const cards = [card("a"), card("b"), card("c")];
    const next = patchCardAgentStates(cards, [state("a", "one"), state("c", "three")]);
    expect(next).not.toBe(cards);
    expect(next?.[0]?.agentState?.lastActivity).toBe("one");
    expect(next?.[1]).toBe(cards[1]);
    expect(next?.[2]?.agentState?.lastActivity).toBe("three");
    // Nothing to patch: the same list back, so no cache write happens.
    expect(patchCardAgentStates(cards, [state("zzz", "x")])).toBe(cards);
  });

  it("leaves the list untouched for unknown tasks or an empty cache", () => {
    const cards = [card("a")];
    expect(patchCardAgentState(cards, state("zzz", "x"))).toBe(cards);
    expect(patchCardAgentState(undefined, state("a", "x"))).toBeUndefined();
  });
});
