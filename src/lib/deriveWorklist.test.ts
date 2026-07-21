import { describe, expect, it } from "vitest";
import {
  buildWorklistItems,
  needsYouCount,
  worklistBucket,
  type WorklistBucket,
} from "./deriveWorklist";
import type { BoardCardState } from "./deriveBoardState";
import type { AgentLiveness } from "./deriveAgentState";
import type {
  BoardState,
  Workspace,
  WorkspaceContract,
  WorkspaceDependency,
  WorklistState,
} from "./types";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("worklistBucket — every BoardCardState maps to exactly one bucket", () => {
  // The exhaustive mapping the surface + the sidebar badge both rely on.
  const cases: ReadonlyArray<[BoardCardState, WorklistBucket]> = [
    ["wedged", "needs-you"],
    ["failed", "needs-you"],
    ["interrupted", "needs-you"],
    ["needs-review", "needs-you"],
    ["working", "running"],
    ["idle", "running"],
    ["resolving", "running"],
    ["blocked", "waiting"],
    ["done", "recent"],
    ["stopped", "recent"],
  ];

  it.each(cases)("%s → %s", (state, bucket) => {
    expect(worklistBucket(state)).toBe(bucket);
  });

  it("puts blocked in Waiting — never Needs-you (the calm group, spec §A4)", () => {
    expect(worklistBucket("blocked")).toBe("waiting");
    expect(worklistBucket("blocked")).not.toBe("needs-you");
  });

  it("never puts idle/running under Needs-you (honest-neutral: quiet is not an alert)", () => {
    expect(worklistBucket("idle")).toBe("running");
    expect(worklistBucket("working")).toBe("running");
  });
});

// ── row builder fixtures ────────────────────────────────────────────────────

function ws(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    repositoryId: "repo-1",
    workspaceKind: "subtask",
    name: overrides.id,
    prompt: null,
    agent: "claude",
    command: "claude",
    status: "pending",
    branch: null,
    worktreePath: null,
    exitCode: null,
    createdAt: iso(600_000),
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    interruptedAt: null,
    parentId: "epic-1",
    role: null,
    autopilotEnabled: false,
    updatedAt: iso(0),
    ...overrides,
  };
}

function edge(from: string, to: string): WorkspaceDependency {
  return {
    id: `edge-${from}-${to}`,
    parentId: "epic-1",
    fromSubtaskId: from,
    toSubtaskId: to,
    createdAt: iso(0),
  };
}

function contract(subtaskId: string): WorkspaceContract {
  return {
    id: `contract-${subtaskId}`,
    parentId: "epic-1",
    subtaskId,
    role: "backend",
    contractPath: `/contracts/${subtaskId}.json`,
    publishedAt: iso(60_000),
    createdAt: iso(120_000),
  };
}

function board(): BoardState {
  return {
    parent: ws({
      id: "epic-1",
      workspaceKind: "parent",
      name: "checkout",
      prompt: "Add task-comments to checkout",
      agent: null,
      parentId: null,
    }),
    subtasks: [
      // running (no liveness) with an old startedAt → working → Running
      ws({
        id: "backend",
        role: "backend",
        name: "comments API",
        status: "running",
        startedAt: iso(600_000),
        branch: "phasr/backend",
      }),
      // pending consumer of an unpublished producer → blocked → Waiting
      ws({
        id: "frontend",
        role: "frontend",
        name: "comments UI",
        status: "pending",
        branch: "phasr/frontend",
      }),
      // failed → Needs you
      ws({
        id: "docs",
        role: "docs",
        name: "docs",
        status: "failed",
        exitCode: 1,
        finishedAt: iso(120_000),
      }),
      // completed clean SUBTASK → needs-review (awaiting integration) → Needs you,
      // NOT `done`: a subtask that exited clean is the human's turn to integrate.
      ws({
        id: "qa",
        role: "qa",
        name: "qa",
        status: "completed",
        exitCode: 0,
        finishedAt: iso(300_000),
      }),
    ],
    dependencies: [edge("backend", "frontend")],
    contracts: [],
  };
}

function worklist(): WorklistState {
  return {
    repositories: [
      { id: "repo-1", name: "payments-app" },
      { id: "repo-2", name: "infra" },
    ],
    boards: [board()],
    looseAgents: [
      // running standalone agent → working → Running
      ws({
        id: "loose-agent",
        repositoryId: "repo-2",
        workspaceKind: "agent",
        name: "spike-rate-limit",
        role: null,
        parentId: null,
        status: "running",
        startedAt: iso(600_000),
        branch: "phasr/spike",
      }),
      // a completed standalone agent → done → Recent (only loose agents reach
      // `done`; subtasks become `needs-review` first).
      ws({
        id: "loose-done",
        repositoryId: "repo-2",
        workspaceKind: "agent",
        name: "spike-cache",
        role: null,
        parentId: null,
        status: "completed",
        exitCode: 0,
        finishedAt: iso(3_600_000),
        branch: "phasr/spike-cache",
      }),
    ],
  };
}

describe("buildWorklistItems — derives + buckets every row cross-repo", () => {
  const NO_LIVENESS: Record<string, AgentLiveness> = {};

  it("buckets an epic's subtasks by honest derived state", () => {
    const items = buildWorklistItems(worklist(), NO_LIVENESS, NOW);
    const get = (id: string) => items.find((i) => i.id === id)!;

    expect(get("backend").bucket).toBe("running");
    expect(get("frontend").bucket).toBe("waiting"); // blocked, calm group
    expect(get("frontend").state).toBe("blocked");
    expect(get("docs").bucket).toBe("needs-you"); // failed
    expect(get("qa").state).toBe("needs-review"); // clean-exit subtask
    expect(get("qa").bucket).toBe("needs-you"); // awaiting integration
    expect(get("loose-done").bucket).toBe("recent"); // done loose agent
  });

  it("carries repo name, epic goal, persona + agent-type onto each subtask row", () => {
    const items = buildWorklistItems(worklist(), NO_LIVENESS, NOW);
    const backend = items.find((i) => i.id === "backend")!;
    expect(backend.repoName).toBe("payments-app");
    expect(backend.epicName).toBe("checkout"); // parent.name (short label)
    expect(backend.role).toBe("backend");
    expect(backend.agent).toBe("claude");
    expect(backend.parentId).toBe("epic-1");
  });

  it("includes loose agents with no epic, keyed to their own repo", () => {
    const items = buildWorklistItems(worklist(), NO_LIVENESS, NOW);
    const loose = items.find((i) => i.id === "loose-agent")!;
    expect(loose.bucket).toBe("running");
    expect(loose.epicName).toBeNull();
    expect(loose.parentId).toBeNull();
    expect(loose.repoName).toBe("infra");
  });

  it("re-buckets a running subtask to Needs-you when liveness reports wedged", () => {
    const live: Record<string, AgentLiveness> = {
      backend: { derivedState: "wedged", lastActivityAt: iso(600_000) },
    };
    const items = buildWorklistItems(worklist(), live, NOW);
    expect(items.find((i) => i.id === "backend")!.bucket).toBe("needs-you");
  });

  it("a published producer contract flips its consumer out of Waiting", () => {
    const state = worklist();
    state.boards[0]!.contracts = [contract("backend")];
    const items = buildWorklistItems(state, NO_LIVENESS, NOW);
    // backend published → needs-review → Needs you; frontend now unblocked.
    expect(items.find((i) => i.id === "backend")!.bucket).toBe("needs-you");
    expect(items.find((i) => i.id === "frontend")!.state).not.toBe("blocked");
  });

  it("needsYouCount counts only the Needs-you rows", () => {
    const items = buildWorklistItems(worklist(), NO_LIVENESS, NOW);
    // `docs` (failed) + `qa` (needs-review); `frontend` blocked is Waiting, not this.
    expect(needsYouCount(items)).toBe(2);
  });

  it("returns [] for an empty worklist", () => {
    const empty: WorklistState = {
      repositories: [],
      boards: [],
      looseAgents: [],
    };
    expect(buildWorklistItems(empty, NO_LIVENESS, NOW)).toEqual([]);
  });
});
