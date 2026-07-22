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
  SubtaskReview,
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

describe("worklistBucket — autopilot re-routes the driver's own work (Phase 5a §7)", () => {
  it("needs-review under an autopilot epic → Autopilot driving, NOT Needs you", () => {
    // The AUTO ticket: its producer finished, so autopilot will Validate →
    // Request-review → integrate it. It is the driver's move, never coral.
    expect(worklistBucket("needs-review", true)).toBe("autopilot-driving");
    expect(worklistBucket("needs-review", true)).not.toBe("needs-you");
  });

  it("needs-review with autopilot OFF stays in Needs you (default unchanged)", () => {
    expect(worklistBucket("needs-review", false)).toBe("needs-you");
    // The one-arg call (the sidebar-badge path) defaults to no autopilot.
    expect(worklistBucket("needs-review")).toBe("needs-you");
  });

  it("a genuine HUMAN-STOP stays coral Needs you even under autopilot", () => {
    // wedged/failed/interrupted are the founder's to resolve — the driver does
    // NOT own them, so autopilot must not hide them in the calm group.
    for (const state of ["failed", "wedged", "interrupted"] as const) {
      expect(worklistBucket(state, true)).toBe("needs-you");
    }
  });

  it("blocked/running/recent are unaffected by autopilot (still their calm groups)", () => {
    expect(worklistBucket("blocked", true)).toBe("waiting");
    expect(worklistBucket("working", true)).toBe("running");
    expect(worklistBucket("done", true)).toBe("recent");
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

describe("buildWorklistItems — autopilot epic routing (Phase 5a §7)", () => {
  const NO_LIVENESS: Record<string, AgentLiveness> = {};

  /** One autopilot-ON epic: an AUTO ticket (needs-review) + a HUMAN-STOP (failed). */
  function autopilotWorklist(): WorklistState {
    return {
      repositories: [{ id: "repo-1", name: "payments-app" }],
      boards: [
        {
          parent: ws({
            id: "epic-ap",
            workspaceKind: "parent",
            name: "overnight",
            prompt: "Ship the comments feature",
            agent: null,
            parentId: null,
            autopilotEnabled: true,
          }),
          subtasks: [
            // clean-exit subtask → needs-review → the driver owns it.
            ws({
              id: "ap-done",
              parentId: "epic-ap",
              role: "backend",
              name: "comments API",
              status: "completed",
              exitCode: 0,
              finishedAt: iso(40_000),
            }),
            // failed → HUMAN-STOP → genuinely the founder's.
            ws({
              id: "ap-failed",
              parentId: "epic-ap",
              role: "docs",
              name: "comments docs",
              status: "failed",
              exitCode: 1,
              finishedAt: iso(30_000),
            }),
          ],
          dependencies: [],
          contracts: [],
        },
      ],
      looseAgents: [],
    };
  }

  it("routes the AUTO ticket to Autopilot driving and the HUMAN-STOP to Needs you", () => {
    const items = buildWorklistItems(autopilotWorklist(), NO_LIVENESS, NOW);
    const get = (id: string) => items.find((i) => i.id === id)!;

    expect(get("ap-done").state).toBe("needs-review");
    expect(get("ap-done").bucket).toBe("autopilot-driving"); // driver owns it
    expect(get("ap-failed").state).toBe("failed");
    expect(get("ap-failed").bucket).toBe("needs-you"); // still the founder's
  });

  it("excludes autopilot-driven tickets from the Needs-you badge count", () => {
    const items = buildWorklistItems(autopilotWorklist(), NO_LIVENESS, NOW);
    // Only the failed ticket owes the founder — the driven one does not inflate it.
    expect(needsYouCount(items)).toBe(1);
  });

  it("the SAME clean-exit ticket stays Needs-you when its epic has autopilot OFF", () => {
    const state = autopilotWorklist();
    state.boards[0]!.parent.autopilotEnabled = false;
    const items = buildWorklistItems(state, NO_LIVENESS, NOW);
    expect(items.find((i) => i.id === "ap-done")!.bucket).toBe("needs-you");
  });
});

describe("buildWorklistItems — M4: a subtask's review decision moves the honest lane", () => {
  const NO_LIVENESS: Record<string, AgentLiveness> = {};

  /**
   * One epic with a single clean-exit subtask. ABSENT a review it derives to
   * `needs-review` ("Ready for review"); `review` side-loads the reviewer's
   * decision inline (M4 wire — `WorklistSubtask.review`) so the worklist can tell
   * "awaiting your review" apart from a bounced ticket the agent must rework.
   */
  function reviewedWorklist(review: SubtaskReview | null): WorklistState {
    return {
      repositories: [{ id: "repo-1", name: "payments-app" }],
      boards: [
        {
          parent: ws({
            id: "epic-r",
            workspaceKind: "parent",
            name: "checkout",
            prompt: "Add comments to checkout",
            agent: null,
            parentId: null,
          }),
          subtasks: [
            {
              ...ws({
                id: "ticket",
                parentId: "epic-r",
                role: "backend",
                name: "comments API",
                status: "completed",
                exitCode: 0,
                finishedAt: iso(60_000),
              }),
              review,
            },
          ],
          dependencies: [],
          contracts: [],
        },
      ],
      looseAgents: [],
    };
  }

  it("a bounced ticket (review 'changes-requested') derives to the re-work state, NOT a review invite", () => {
    const items = buildWorklistItems(
      reviewedWorklist({ state: "changes-requested", atMs: NOW - 30_000 }),
      NO_LIVENESS,
      NOW,
    );
    const ticket = items.find((i) => i.id === "ticket")!;
    // The M4 fix: threading `subtask.review` re-opens this clean-exit subtask for
    // re-work instead of collapsing it to `needs-review` (a false "Ready for review").
    expect(ticket.state).toBe("qas-changes-requested");
    expect(ticket.state).not.toBe("needs-review");
    expect(ticket.bucket).toBe("needs-you");
  });

  it("a ticket at review 'requested' derives to in-review (still the review flow, not re-work)", () => {
    const items = buildWorklistItems(
      reviewedWorklist({ state: "requested", atMs: NOW - 30_000 }),
      NO_LIVENESS,
      NOW,
    );
    const ticket = items.find((i) => i.id === "ticket")!;
    expect(ticket.state).toBe("in-review");
    expect(ticket.state).not.toBe("qas-changes-requested");
    expect(ticket.bucket).toBe("needs-you");
  });

  it("the SAME subtask with no review (null) stays the needs-review invite", () => {
    const items = buildWorklistItems(reviewedWorklist(null), NO_LIVENESS, NOW);
    const ticket = items.find((i) => i.id === "ticket")!;
    expect(ticket.state).toBe("needs-review");
    expect(ticket.bucket).toBe("needs-you");
  });

  it("an approved ticket collapses back to needs-review (integrate-eligible)", () => {
    const items = buildWorklistItems(
      reviewedWorklist({ state: "approved", atMs: NOW - 30_000 }),
      NO_LIVENESS,
      NOW,
    );
    expect(items.find((i) => i.id === "ticket")!.state).toBe("needs-review");
  });
});
