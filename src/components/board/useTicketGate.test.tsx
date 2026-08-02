import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTicketGate } from "./useTicketGate";
import type { BoardState, ReviewRecord, Workspace } from "@/lib/types";
import type { AgentLiveness } from "@/lib/deriveAgentState";

const NOW = Date.parse("2026-07-20T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

// Mutable per-test state the mocked query hooks read from. The REAL
// `deriveBoardState` + `deriveNextGate` stay in play — this test exercises
// `useTicketGate`'s own derivation (that it threads `board.parent.autopilotEnabled`
// into `deriveNextGate`), so only the data-fetching hooks are stubbed.
const mocks = vi.hoisted(() => ({
  board: undefined as unknown,
  reviews: [] as unknown[],
  validations: [] as unknown[],
  runCommands: [] as unknown[],
  liveness: undefined as unknown,
}));

vi.mock("@/lib/hooks/useBoard", () => ({
  useBoard: () => ({ data: mocks.board }),
  useBoardGates: () => ({
    data: { reviews: mocks.reviews, validations: mocks.validations },
  }),
  useValidateTicket: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useRequestReview: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useResolveReview: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("@/lib/hooks/useRunCommands", () => ({
  useRunCommands: () => ({ data: mocks.runCommands }),
}));

vi.mock("@/lib/agentLiveness", () => ({
  useAgentLiveness: () => mocks.liveness,
}));

vi.mock("@/lib/useNow", () => ({
  useNow: () => NOW,
}));

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
    shippedAt: null,
    interruptedAt: null,
    parentId: "epic-1",
    role: null,
    autopilotEnabled: false,
    updatedAt: iso(0),
    ...overrides,
  };
}

/** The board whose `parent` is this ticket's epic — carries the autopilot flag. */
function board(autopilotEnabled: boolean, subtask: Workspace): BoardState {
  return {
    parent: ws({
      id: "epic-1",
      workspaceKind: "parent",
      name: "checkout",
      parentId: null,
      agent: null,
      autopilotEnabled,
    }),
    subtasks: [subtask],
    dependencies: [],
    contracts: [],
  };
}

// A running subtask with a live "working" snapshot and no checks/review/validate
// → `deriveBoardState` yields "working", and `deriveTicketGate` lands on the
// enabled primary "Request review" — an AUTOPILOT-OWNED gate.
const FORWARD_SUBTASK = ws({
  id: "frontend",
  role: "frontend",
  name: "comments UI",
  status: "running",
  startedAt: iso(600_000),
  branch: "phasr/frontend",
});

const WORKING_LIVENESS: AgentLiveness = {
  derivedState: "working",
  lastActivityAt: iso(1_000),
};

describe("useTicketGate — autopilot threads through the shared derivation", () => {
  beforeEach(() => {
    mocks.reviews = [];
    mocks.validations = [];
    mocks.runCommands = []; // no checks configured → gate = Request review
    mocks.liveness = WORKING_LIVENESS;
  });

  it("downgrades an autopilot-owned ticket gate to NEUTRAL (still enabled)", () => {
    mocks.board = board(true, FORWARD_SUBTASK);

    const { result } = renderHook(() => useTicketGate(FORWARD_SUBTASK));

    expect(result.current).not.toBeNull();
    const gate = result.current!.gate;
    // The autopilot-owned AUTO step reads calm, never coral…
    expect(gate.verb).toBe("request-review");
    expect(gate.intent).toBe("neutral");
    // …but it is NEVER a dead end (I4) — the founder can still click it.
    expect(gate.enabled).toBe(true);
  });

  it("keeps the same gate PRIMARY when the epic's autopilot is off (parity)", () => {
    mocks.board = board(false, FORWARD_SUBTASK);

    const { result } = renderHook(() => useTicketGate(FORWARD_SUBTASK));

    const gate = result.current!.gate;
    expect(gate.verb).toBe("request-review");
    expect(gate.intent).toBe("primary");
    expect(gate.enabled).toBe(true);
  });

  it("never downgrades the HUMAN-STOP Approve gate, even under autopilot", () => {
    // A requested review puts the ticket in-review → the reviewer's Approve gate.
    // Approve is not an AUTO verb, so autopilot must leave it coral primary.
    const review: ReviewRecord = {
      subtaskId: FORWARD_SUBTASK.id,
      state: "requested",
      by: "qas",
      comment: null,
      atMs: NOW - 1_000,
      validatePassed: true,
    };
    mocks.reviews = [review];
    mocks.board = board(true, FORWARD_SUBTASK);

    const { result } = renderHook(() => useTicketGate(FORWARD_SUBTASK));

    const gate = result.current!.gate;
    expect(gate.verb).toBe("approve");
    expect(gate.intent).toBe("primary");
  });
});
