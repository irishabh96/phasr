import { describe, expect, it } from "vitest";
import {
  blockingRoles,
  boardColumn,
  deriveBoardState,
} from "./deriveBoardState";
import type { AgentLiveness } from "./deriveAgentState";
import type {
  BoardState,
  Workspace,
  WorkspaceContract,
  WorkspaceDependency,
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
    status: "pending",
    branch: null,
    worktreePath: null,
    exitCode: null,
    createdAt: iso(0),
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    interruptedAt: null,
    parentId: "parent-1",
    role: "frontend",
    updatedAt: iso(0),
    ...overrides,
  };
}

function edge(fromSubtaskId: string, toSubtaskId: string): WorkspaceDependency {
  return {
    id: `edge-${fromSubtaskId}-${toSubtaskId}`,
    parentId: "parent-1",
    fromSubtaskId,
    toSubtaskId,
    createdAt: iso(0),
  };
}

function contract(
  subtaskId: string,
  role: string,
  published: boolean,
): WorkspaceContract {
  return {
    id: `contract-${subtaskId}`,
    parentId: "parent-1",
    subtaskId,
    role,
    contractPath: `~/.phasr/tasks/parent-1/contracts/${role}.md`,
    publishedAt: published ? iso(1_000) : null,
    createdAt: iso(2_000),
  };
}

const live = (
  derivedState: AgentLiveness["derivedState"],
  msAgo: number | null,
): AgentLiveness => ({
  derivedState,
  lastActivityAt: msAgo == null ? null : iso(msAgo),
});

// The canonical PoC topology: backend → frontend, one edge.
const BACKEND = "sub-backend";
const FRONTEND = "sub-frontend";
const EDGE = edge(BACKEND, FRONTEND);

describe("deriveBoardState", () => {
  describe("blocked — a pending consumer whose producer hasn't published", () => {
    it("marks a pending consumer blocked when the producer has no contract", () => {
      const frontend = subtask({ id: FRONTEND, role: "frontend", status: "pending" });
      const r = deriveBoardState(
        frontend,
        { dependencies: [EDGE], contracts: [] },
        undefined,
        NOW,
      );
      expect(r.state).toBe("blocked");
      expect(r.since).toBeNull();
    });

    it("stays blocked when the producer has a contract ROW but it isn't published", () => {
      const frontend = subtask({ id: FRONTEND, status: "pending" });
      const r = deriveBoardState(
        frontend,
        { dependencies: [EDGE], contracts: [contract(BACKEND, "backend", false)] },
        undefined,
        NOW,
      );
      expect(r.state).toBe("blocked");
    });

    it("unblocks once the producer publishes its contract", () => {
      const frontend = subtask({ id: FRONTEND, status: "pending", startedAt: null });
      const r = deriveBoardState(
        frontend,
        { dependencies: [EDGE], contracts: [contract(BACKEND, "backend", true)] },
        undefined,
        NOW,
      );
      // No longer blocked → falls through to the honest pending state.
      expect(r.state).not.toBe("blocked");
      expect(r.state).toBe("resolving");
    });

    it("the ROOT subtask (no incoming edge) is never blocked", () => {
      const backend = subtask({ id: BACKEND, role: "backend", status: "pending" });
      const r = deriveBoardState(
        backend,
        { dependencies: [EDGE], contracts: [] },
        undefined,
        NOW,
      );
      expect(r.state).not.toBe("blocked");
    });

    it("a RUNNING consumer is not 'blocked' even with an unsatisfied edge (only pending blocks)", () => {
      const frontend = subtask({
        id: FRONTEND,
        status: "running",
        startedAt: iso(5_000),
      });
      const r = deriveBoardState(
        frontend,
        { dependencies: [EDGE], contracts: [] },
        undefined,
        NOW,
      );
      expect(r.state).toBe("working");
    });
  });

  describe("needs-review — contract published or clean exit", () => {
    it("a published contract → needs-review even while the PTY is still running", () => {
      const backend = subtask({
        id: BACKEND,
        role: "backend",
        status: "running",
        startedAt: iso(5_000),
      });
      const r = deriveBoardState(
        backend,
        { dependencies: [EDGE], contracts: [contract(BACKEND, "backend", true)] },
        live("working", 2_000),
        NOW,
      );
      expect(r.state).toBe("needs-review");
    });

    it("a cleanly-exited (done) subtask with no contract → needs-review", () => {
      const backend = subtask({
        id: BACKEND,
        status: "completed",
        exitCode: 0,
        finishedAt: iso(10_000),
      });
      const r = deriveBoardState(
        backend,
        { dependencies: [], contracts: [] },
        undefined,
        NOW,
      );
      expect(r.state).toBe("needs-review");
      expect(r.since).toBe(10_000);
    });
  });

  describe("honest liveness passthrough (Step 0 reuse)", () => {
    it("reuses working from the live snapshot", () => {
      const backend = subtask({ id: BACKEND, status: "running", startedAt: iso(1_000) });
      const r = deriveBoardState(
        backend,
        { dependencies: [], contracts: [] },
        live("working", 2_000),
        NOW,
      );
      expect(r.state).toBe("working");
      expect(r.since).toBe(2_000);
    });

    it("reuses idle (neutral, never coral)", () => {
      const backend = subtask({ id: BACKEND, status: "running", startedAt: iso(1_000) });
      const r = deriveBoardState(
        backend,
        { dependencies: [], contracts: [] },
        live("idle", 90_000),
        NOW,
      );
      expect(r.state).toBe("idle");
    });

    it("reuses wedged (a frozen agent stays honest on the board)", () => {
      const backend = subtask({ id: BACKEND, status: "running", startedAt: iso(1_000) });
      const r = deriveBoardState(
        backend,
        { dependencies: [], contracts: [] },
        live("wedged", 840_000),
        NOW,
      );
      expect(r.state).toBe("wedged");
    });

    it("a nonzero exit stays honest (failed, not needs-review)", () => {
      const backend = subtask({
        id: BACKEND,
        status: "failed",
        exitCode: 1,
        finishedAt: iso(60_000),
      });
      const r = deriveBoardState(
        backend,
        { dependencies: [], contracts: [] },
        undefined,
        NOW,
      );
      expect(r.state).toBe("failed");
    });
  });

  describe("precedence", () => {
    it("published contract beats a still-blocked-looking pending edge", () => {
      // Contrived: this subtask both consumes an unsatisfied edge AND has its
      // own published contract — needs-review wins (it did its job).
      const mid = subtask({ id: "sub-mid", status: "pending" });
      const board = {
        dependencies: [edge("sub-upstream", "sub-mid")],
        contracts: [contract("sub-mid", "middle", true)],
      };
      expect(deriveBoardState(mid, board, undefined, NOW).state).toBe("needs-review");
    });
  });
});

describe("blockingRoles", () => {
  const board: BoardState = {
    parent: subtask({ id: "parent-1", workspaceKind: "parent", role: null }),
    subtasks: [
      subtask({ id: BACKEND, role: "backend", status: "running" }),
      subtask({ id: FRONTEND, role: "frontend", status: "pending" }),
    ],
    dependencies: [EDGE],
    contracts: [],
  };

  it("returns the producer role a blocked consumer waits on", () => {
    const frontend = board.subtasks[1]!;
    expect(blockingRoles(frontend, board)).toEqual(["backend"]);
  });

  it("returns [] once the producer has published", () => {
    const published: BoardState = {
      ...board,
      contracts: [contract(BACKEND, "backend", true)],
    };
    expect(blockingRoles(board.subtasks[1]!, published)).toEqual([]);
  });

  it("returns [] for the root (never blocked)", () => {
    expect(blockingRoles(board.subtasks[0]!, board)).toEqual([]);
  });
});

describe("boardColumn", () => {
  it("blocked / resolving / stopped → backlog", () => {
    expect(boardColumn("blocked")).toBe("backlog");
    expect(boardColumn("resolving")).toBe("backlog");
    expect(boardColumn("stopped")).toBe("backlog");
  });

  it("working / idle / wedged / failed / interrupted → in-progress", () => {
    for (const s of ["working", "idle", "wedged", "failed", "interrupted"] as const) {
      expect(boardColumn(s)).toBe("in-progress");
    }
  });

  it("needs-review → review, done → done", () => {
    expect(boardColumn("needs-review")).toBe("review");
    expect(boardColumn("done")).toBe("done");
  });
});
