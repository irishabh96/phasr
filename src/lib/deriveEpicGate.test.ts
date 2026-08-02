import { describe, expect, it } from "vitest";
import { deriveEpicIntegrable } from "./deriveEpicGate";
import type { AgentLiveness } from "./deriveAgentState";
import type {
  BoardState,
  ReviewRecord,
  Workspace,
  WorkspaceContract,
} from "./types";

const NOW = Date.parse("2026-07-19T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function subtask(overrides: Partial<Workspace>): Workspace {
  return {
    id: "sub-x",
    repositoryId: "repo-1",
    workspaceKind: "subtask",
    name: "sub",
    prompt: "do it",
    agent: "claude",
    command: "claude",
    status: "running",
    branch: "phasr/sub",
    worktreePath: "/w",
    exitCode: null,
    createdAt: iso(0),
    startedAt: iso(60_000),
    finishedAt: null,
    archivedAt: null,
    shippedAt: null,
    interruptedAt: null,
    parentId: "parent-1",
    role: "frontend",
    autopilotEnabled: false,
    updatedAt: iso(0),
    ...overrides,
  };
}

function publishedContract(subtaskId: string): WorkspaceContract {
  return {
    id: `contract-${subtaskId}`,
    parentId: "parent-1",
    subtaskId,
    role: "backend",
    contractPath: `~/.phasr/tasks/parent-1/contracts/${subtaskId}.md`,
    publishedAt: iso(1_000),
    createdAt: iso(2_000),
  };
}

function review(subtaskId: string, state: ReviewRecord["state"]): ReviewRecord {
  return {
    subtaskId,
    state,
    by: "you",
    comment: null,
    atMs: NOW - 1_000,
    validatePassed: true,
  };
}

type Board = Pick<BoardState, "subtasks" | "dependencies" | "contracts">;
const noLive: Record<string, AgentLiveness> = {};

describe("deriveEpicIntegrable", () => {
  it("is false for an empty board (nothing to integrate)", () => {
    const board: Board = { subtasks: [], dependencies: [], contracts: [] };
    expect(deriveEpicIntegrable(board, [], noLive, NOW)).toBe(false);
  });

  it("is true only once EVERY ticket is integrate-eligible (published contract → needs-review)", () => {
    const a = subtask({ id: "a" });
    const b = subtask({ id: "b" });
    const board: Board = {
      subtasks: [a, b],
      dependencies: [],
      contracts: [publishedContract("a"), publishedContract("b")],
    };
    expect(deriveEpicIntegrable(board, [], noLive, NOW)).toBe(true);
  });

  it("is false while any ticket is still working (no contract / not done)", () => {
    const a = subtask({ id: "a", status: "running" });
    const b = subtask({ id: "b" });
    const board: Board = {
      subtasks: [a, b],
      dependencies: [],
      contracts: [publishedContract("b")], // only b is ready
    };
    expect(deriveEpicIntegrable(board, [], noLive, NOW)).toBe(false);
  });

  it("respects the review decision: a REQUESTED review (in-review) is NOT yet eligible", () => {
    const a = subtask({ id: "a" });
    const b = subtask({ id: "b" });
    const board: Board = {
      subtasks: [a, b],
      dependencies: [],
      contracts: [publishedContract("a"), publishedContract("b")],
    };
    // b is in review (requested) → in-review → not integrate-eligible yet.
    expect(
      deriveEpicIntegrable(board, [review("b", "requested")], noLive, NOW),
    ).toBe(false);
  });

  it("an APPROVED review collapses back to needs-review → integrable", () => {
    const a = subtask({ id: "a" });
    const b = subtask({ id: "b" });
    const board: Board = {
      subtasks: [a, b],
      dependencies: [],
      contracts: [publishedContract("a"), publishedContract("b")],
    };
    expect(
      deriveEpicIntegrable(
        board,
        [review("a", "approved"), review("b", "approved")],
        noLive,
        NOW,
      ),
    ).toBe(true);
  });
});
