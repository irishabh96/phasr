import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoardStateBadgeView, SubtaskStatusBadge } from "./SubtaskStatusBadge";
import { deriveBoardState } from "@/lib/deriveBoardState";
import { agentStatusMeta } from "@/components/ui/agentStatusMeta";
import type { AgentLiveness } from "@/lib/deriveAgentState";
import type {
  BoardState,
  ReviewRecord,
  Workspace,
  WorkspaceContract,
} from "@/lib/types";

const NOW = Date.parse("2026-07-21T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

// The connected badge reads its data from these mocked query hooks; the REAL
// `deriveBoardState`/`deriveAgentState` stay in play — this suite proves the
// detail badge runs the SAME honest derivation the board card does.
const mocks = vi.hoisted(() => ({
  workspace: undefined as unknown,
  board: undefined as unknown,
  reviews: [] as unknown[],
  liveness: undefined as unknown,
}));

vi.mock("@/lib/hooks/useWorkspaces", () => ({
  useWorkspace: () => ({ data: mocks.workspace }),
}));
vi.mock("@/lib/hooks/useBoard", () => ({
  useBoard: () => ({ data: mocks.board }),
  useBoardGates: () => ({ data: { reviews: mocks.reviews, validations: [] } }),
}));
vi.mock("@/lib/agentLiveness", () => ({
  useAgentLiveness: () => mocks.liveness,
}));
vi.mock("@/lib/hooks/useRestartAgent", () => ({
  useRestartAgent: () => vi.fn(),
}));
vi.mock("@/lib/useNow", () => ({ useNow: () => NOW }));

function subtask(overrides: Partial<Workspace> & { id: string }): Workspace {
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
    role: "frontend",
    autopilotEnabled: false,
    requireHumanApproval: true,
    reviewsSubtaskId: null,
    updatedAt: iso(0),
    ...overrides,
  };
}

function contract(subtaskId: string, published: boolean): WorkspaceContract {
  return {
    id: `contract-${subtaskId}`,
    parentId: "epic-1",
    subtaskId,
    role: "frontend",
    contractPath: `contracts/${subtaskId}.json`,
    publishedAt: published ? iso(1_000) : null,
    createdAt: iso(2_000),
  };
}

function board(
  subtaskRow: Workspace,
  contracts: WorkspaceContract[] = [],
): BoardState {
  return {
    parent: subtask({
      id: "epic-1",
      workspaceKind: "parent",
      name: "checkout",
      parentId: null,
      agent: null,
    }),
    subtasks: [subtaskRow],
    dependencies: [],
    contracts,
  };
}

const IDLE_LIVENESS: AgentLiveness = {
  derivedState: "idle",
  lastActivityAt: iso(30_000),
};

describe("BoardStateBadgeView — honest, never a raw status", () => {
  it("renders the honest agent-family label (Idle, not Running)", () => {
    render(<BoardStateBadgeView state="idle" since={30_000} />);
    expect(screen.getByTestId("agent-badge-label")).toHaveTextContent("Idle");
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("renders Working / Wedged honestly", () => {
    const { rerender } = render(
      <BoardStateBadgeView state="working" since={1_000} />,
    );
    expect(screen.getByTestId("agent-badge-label")).toHaveTextContent(
      "Working",
    );
    rerender(<BoardStateBadgeView state="wedged" since={90_000} />);
    expect(screen.getByTestId("agent-badge-label")).toHaveTextContent("Wedged");
  });

  it("renders the board-only buckets with their calm chips", () => {
    const { rerender } = render(
      <BoardStateBadgeView state="blocked" since={null} blockedOnRoles={["backend"]} />,
    );
    expect(screen.getByTestId("subtask-blocked-chip")).toHaveTextContent(
      "Blocked",
    );

    rerender(<BoardStateBadgeView state="needs-review" since={null} />);
    expect(screen.getByTestId("subtask-review-chip")).toHaveTextContent(
      "Ready for review",
    );

    rerender(<BoardStateBadgeView state="in-review" since={null} />);
    expect(screen.getByTestId("in-review-chip")).toBeInTheDocument();

    const approved: ReviewRecord = {
      subtaskId: "frontend",
      state: "approved",
      by: "qas",
      comment: null,
      atMs: NOW,
      validatePassed: true,
    };
    rerender(
      <BoardStateBadgeView state="needs-review" since={null} review={approved} />,
    );
    expect(screen.getByTestId("approved-chip")).toBeInTheDocument();
  });
});

describe("SubtaskStatusBadge — reconciles with the board card", () => {
  beforeEach(() => {
    mocks.workspace = undefined;
    mocks.board = undefined;
    mocks.reviews = [];
    mocks.liveness = undefined;
  });

  it("shows the honest liveness state (Idle) for a running-but-quiet subtask, never raw 'Running'", () => {
    const ws = subtask({
      id: "frontend",
      status: "running",
      worktreePath: "/wt/frontend",
      startedAt: iso(600_000),
    });
    mocks.workspace = ws;
    mocks.board = board(ws);
    mocks.liveness = IDLE_LIVENESS;

    // The badge label must equal what the board card derives from the SAME inputs.
    const { state } = deriveBoardState(ws, board(ws), IDLE_LIVENESS, NOW);
    expect(state).toBe("idle");

    render(
      <SubtaskStatusBadge workspaceId="frontend" repositoryId="repo-1" />,
    );
    expect(screen.getByTestId("agent-badge-label")).toHaveTextContent("Idle");
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("surfaces the board's 'needs-review' when a contract is published (matches the card)", () => {
    const ws = subtask({
      id: "frontend",
      status: "running",
      worktreePath: "/wt/frontend",
      startedAt: iso(600_000),
    });
    const contracts: WorkspaceContract[] = [contract("frontend", true)];
    mocks.workspace = ws;
    mocks.board = board(ws, contracts);
    mocks.liveness = IDLE_LIVENESS;

    const { state } = deriveBoardState(ws, board(ws, contracts), IDLE_LIVENESS, NOW);
    expect(state).toBe("needs-review");

    render(<SubtaskStatusBadge workspaceId="frontend" repositoryId="repo-1" />);
    expect(screen.getByTestId("subtask-review-chip")).toHaveTextContent(
      "Ready for review",
    );
  });

  it("falls back to the honest agent state before the board loads (never empty, never raw)", () => {
    const ws = subtask({
      id: "frontend",
      status: "running",
      worktreePath: "/wt/frontend",
      startedAt: iso(600_000),
    });
    mocks.workspace = ws;
    mocks.board = undefined; // board not in cache yet
    mocks.liveness = IDLE_LIVENESS;

    render(<SubtaskStatusBadge workspaceId="frontend" repositoryId="repo-1" />);
    expect(screen.getByTestId("agent-badge-label")).toHaveTextContent(
      agentStatusMeta("idle").label,
    );
  });

  it("renders nothing for a non-subtask workspace", () => {
    mocks.workspace = subtask({ id: "x", workspaceKind: "agent" });
    const { container } = render(
      <SubtaskStatusBadge workspaceId="x" repositoryId="repo-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
