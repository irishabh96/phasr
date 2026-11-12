import { QueryClient, QueryClientProvider, hashKey } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { memo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentSignalKeys,
  useAgentSignalEvents,
  useTaskAgentState,
} from "@/lib/hooks/useAgentSignals";
import { useBoardTasks, type BoardTask } from "@/lib/hooks/useBoardTasks";
import { taskCardKeys, useTaskCardEvents } from "@/lib/hooks/useTaskCards";
import type { Repository, TaskAgentState, TaskCard, Workspace } from "@/lib/types";

/**
 * P4 (specs/ui-mission-control-polish-spec.md §6.2): agent events reach the
 * store at ≤ 30 Hz, and an event for task A re-renders nothing that only
 * shows task B.
 */

type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: Handler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return Promise.resolve(() => {});
  },
}));

const repo = { id: "r", name: "phasr" } as Repository;
const ws = (id: string): Workspace =>
  ({
    id,
    repositoryId: "r",
    workspaceKind: "agent",
    name: id,
    agent: "claude",
    status: "running",
    branch: `b-${id}`,
    worktreePath: `/w/${id}`,
    exitCode: null,
    createdAt: "2026-11-10T00:00:00Z",
    startedAt: id === "a" ? "2026-11-10T01:00:00Z" : "2026-11-10T00:30:00Z",
    finishedAt: null,
    archivedAt: null,
    updatedAt: "2026-11-10T00:00:00Z",
  }) as Workspace;
const state = (taskId: string, lastActivity: string): TaskAgentState => ({
  taskId,
  repositoryId: "r",
  state: "working",
  attention: null,
  lastActivity,
  lastTurnEndedAt: null,
});
const card = (id: string): TaskCard => ({
  workspace: ws(id),
  lane: "running",
  diff: null,
  agentState: state(id, "start"),
  usage: null,
  finishedAt: null,
  dependsOnName: null,
});

vi.mock("@/lib/tauri", () => ({
  tauri: {
    listRepositories: () => Promise.resolve([repo]),
    listWorkspaces: () => Promise.resolve([ws("a"), ws("b")]),
    listTaskCards: () => Promise.resolve([card("a"), card("b")]),
    listAgentStates: () => Promise.resolve([state("a", "start"), state("b", "start")]),
  },
}));

function emit(event: string, payload: unknown) {
  for (const h of handlers.get(event) ?? []) h({ payload });
}

let client: QueryClient;
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Cache writes that reached `key` — what every subscriber is notified of. */
function countUpdates(key: readonly unknown[]) {
  const hash = hashKey(key);
  const counter = { n: 0 };
  client.getQueryCache().subscribe((e) => {
    if (
      e.type === "updated" &&
      e.action.type === "success" &&
      e.query.queryHash === hash
    )
      counter.n += 1;
  });
  return counter;
}

const renders: Record<string, number> = {};
const Row = memo(function Row({ task }: { task: BoardTask }) {
  renders[task.workspace.id] = (renders[task.workspace.id] ?? 0) + 1;
  return <li>{task.activity}</li>;
});
/** The two subscriptions `useAppEvents` mounts for these events. */
function Rows() {
  useAgentSignalEvents();
  useTaskCardEvents();
  const { tasks } = useBoardTasks(null);
  return (
    <ul>
      {tasks.map((t) => (
        <Row key={t.workspace.id} task={t} />
      ))}
    </ul>
  );
}
function InspectorFor({ taskId }: { taskId: string }) {
  const st = useTaskAgentState(taskId);
  renders[`inspector-${taskId}`] = (renders[`inspector-${taskId}`] ?? 0) + 1;
  return <p>{st?.lastActivity}</p>;
}

/** Let the mocked fetches, the trailing flush and their renders land. */
async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  for (const k of Object.keys(renders)) delete renders[k];
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("agent events → store at ≤ 30 Hz", () => {
  it("100 events for task A within 100ms make ≤ 4 store updates, and the last state wins", async () => {
    render(<Rows />, { wrapper: Wrapper });
    await settle();
    const states = countUpdates(agentSignalKeys.states());
    const cards = countUpdates(taskCardKeys.list(null));

    await act(async () => {
      for (let i = 0; i < 100; i++) {
        emit("phasr://task-agent-state", state("a", `tool ${i}`));
        await vi.advanceTimersByTimeAsync(1);
      }
    });
    console.log(`P4 store updates in 100ms: states=${states.n} cards=${cards.n}`);
    // One per event (100) before; ≤ 30 Hz now.
    expect(states.n).toBeLessThanOrEqual(4);
    expect(cards.n).toBeLessThanOrEqual(4);

    await settle();
    const snapshot = client.getQueryData<TaskAgentState[]>(agentSignalKeys.states());
    expect(snapshot?.find((s) => s.taskId === "a")?.lastActivity).toBe("tool 99");
    const list = client.getQueryData<TaskCard[]>(taskCardKeys.list(null));
    expect(list?.find((c) => c.workspace.id === "a")?.agentState?.lastActivity).toBe(
      "tool 99",
    );
    // Untouched task keeps its identity in both caches.
    expect(snapshot?.find((s) => s.taskId === "b")?.lastActivity).toBe("start");
  });

  it("a turn that ends mid-burst still refreshes that task's summary", async () => {
    render(<Rows />, { wrapper: Wrapper });
    await settle();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await act(async () => {
      emit("phasr://task-agent-state", {
        ...state("a", "done"),
        state: "idle",
        lastTurnEndedAt: "2026-11-10T02:00:00Z",
      });
      emit("phasr://task-agent-state", state("a", "next turn"));
      await vi.advanceTimersByTimeAsync(40);
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: agentSignalKeys.summary("a") });
  });

  it("a burst for task A never re-renders task B's row or B's inspector", async () => {
    render(
      <>
        <Rows />
        <InspectorFor taskId="a" />
        <InspectorFor taskId="b" />
      </>,
      { wrapper: Wrapper },
    );
    await settle();
    expect(renders.a).toBeGreaterThan(0);
    const before = { ...renders };

    await act(async () => {
      for (let i = 0; i < 100; i++) {
        emit("phasr://task-agent-state", state("a", `tool ${i}`));
        await vi.advanceTimersByTimeAsync(1);
      }
    });
    await settle();

    console.log(
      `P4 renders during A's burst: rowA=${renders.a! - before.a!} rowB=${renders.b! - before.b!} ` +
        `inspectorA=${renders["inspector-a"]! - before["inspector-a"]!} ` +
        `inspectorB=${renders["inspector-b"]! - before["inspector-b"]!}`,
    );
    expect(renders.b).toBe(before.b);
    expect(renders["inspector-b"]).toBe(before["inspector-b"]);
    // A's row did update — at most once per flush, not once per event.
    expect(renders.a! - before.a!).toBeGreaterThan(0);
    expect(renders.a! - before.a!).toBeLessThanOrEqual(5);
    expect(renders["inspector-a"]! - before["inspector-a"]!).toBeLessThanOrEqual(5);
  });
});
