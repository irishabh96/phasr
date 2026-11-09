/**
 * Board fixtures: one card in every lane the board draws, served as backend
 * task cards (`list_task_cards`) with live agent states, so the board shows
 * Queued · Needs you (an approval + a failed task) · Running (activity) ·
 * Review (checks) and "2 merged today" under Review.
 *
 * Timestamps are relative to the real clock: "today", "waiting 38s" and
 * "18m ago" are computed against `Date.now()` in the page.
 */
import { makeFixtures } from "../harness";

type Fixtures = ReturnType<typeof makeFixtures>;

export function boardFixtures(opts: { extraTasks?: number } = {}) {
  const f = makeFixtures();
  const t = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  const MIN = 60_000;
  const base = f.workspaces[0]!;
  const ws = (over: Record<string, unknown>) => ({
    ...base,
    prompt: null,
    exitCode: null,
    finishedAt: null,
    archivedAt: null,
    createdAt: t(3 * 60 * MIN),
    startedAt: t(3 * 60 * MIN),
    updatedAt: t(3 * 60 * MIN),
    baseBranch: "main",
    queuedAt: null,
    dependsOnWorkspaceId: null,
    outcome: null,
    outcomeAt: null,
    mergedInto: null,
    prNumber: null,
    prUrl: null,
    prState: null,
    ...over,
  });
  const card = (workspace: ReturnType<typeof ws>, lane: string, over: Record<string, unknown> = {}) => ({
    workspace,
    lane,
    diff: null,
    agentState: null,
    usage: null,
    finishedAt: null,
    dependsOnName: null,
    ...over,
  });
  const state = (taskId: string, repositoryId: string, over: Record<string, unknown>) => ({
    taskId,
    repositoryId,
    state: "working",
    attention: null,
    lastActivity: null,
    lastTurnEndedAt: null,
    ...over,
  });

  const queued = ws({
    id: "ws-queued",
    repositoryId: "repo-2",
    name: "regenerate API reference from openapi.json",
    agent: "claude",
    status: "pending",
    branch: null,
    worktreePath: null,
    startedAt: null,
    queuedAt: t(5 * MIN),
    dependsOnWorkspaceId: "ws-needs",
  });
  const needs = ws({
    id: "ws-needs",
    name: "upgrade to tauri v2",
    agent: "gemini",
    status: "running",
    branch: "phasr/tauri-v2",
    startedAt: t(9 * MIN),
  });
  const needsState = state("ws-needs", "repo-1", {
    state: "needs-you",
    attention: {
      id: "att-1",
      kind: "shell",
      title: "Run a shell command",
      detail: "pnpm install",
      since: t(38_000),
      source: "hook",
      canRespond: true,
      canAllowForTask: false,
    },
  });
  const failed = ws({
    id: "ws-failed",
    name: "e2e tests for the board",
    agent: "codex",
    status: "failed",
    branch: "phasr/e2e-board",
    exitCode: 1,
    finishedAt: t(12 * MIN),
  });
  const running = ws({
    id: "ws-running",
    name: "fix login redirect bug",
    agent: "claude",
    status: "running",
    branch: "phasr/fix-login",
    startedAt: t(252_000),
  });
  const runningState = state("ws-running", "repo-1", { lastActivity: "Running pnpm test src/auth" });
  const review1 = ws({
    id: "ws-review-1",
    name: "move settings into a sheet",
    agent: "codex",
    status: "completed",
    branch: "phasr/settings-sheet",
    exitCode: 0,
    finishedAt: t(18 * MIN),
  });
  const review2 = ws({
    id: "ws-review-2",
    name: "write changelog for 0.4",
    agent: "claude",
    status: "completed",
    branch: "phasr/changelog",
    exitCode: 0,
    finishedAt: t(62 * MIN),
  });
  const merged1 = ws({
    id: "ws-merged-1",
    name: "add run command presets",
    agent: "claude",
    status: "archived",
    branch: "phasr/run-presets",
    outcome: "merged",
    outcomeAt: t(2 * 60 * MIN),
    mergedInto: "main",
    archivedAt: t(2 * 60 * MIN),
  });
  const merged2 = ws({
    id: "ws-merged-2",
    name: "cursor shape setting",
    agent: "codex",
    status: "archived",
    branch: "phasr/cursor-shape",
    outcome: "merged",
    outcomeAt: t(3 * 60 * MIN),
    mergedInto: "main",
    archivedAt: t(3 * 60 * MIN),
  });

  const cards = [
    card(needs, "needs-you", { agentState: needsState }),
    card(running, "running", { agentState: runningState, diff: { adds: 46, removes: 1, files: 2 } }),
    card(failed, "failed", { finishedAt: t(12 * MIN) }),
    card(review1, "needs-review", { diff: { adds: 212, removes: 48, files: 7 }, finishedAt: t(18 * MIN) }),
    card(review2, "needs-review", { diff: { adds: 61, removes: 0, files: 1 }, finishedAt: t(62 * MIN) }),
    card(queued, "queued", { dependsOnName: "tauri-v2" }),
    card(merged1, "done", { finishedAt: t(2 * 60 * MIN) }),
    card(merged2, "done", { finishedAt: t(3 * 60 * MIN) }),
  ];

  // Perf fixture: `extraTasks` more cards spread over the four columns.
  const lanes = ["queued", "needs-you", "running", "needs-review"] as const;
  for (let i = 0; i < (opts.extraTasks ?? 0); i++) {
    const lane = lanes[i % lanes.length]!;
    const w = ws({
      id: `ws-bulk-${i}`,
      repositoryId: i % 2 ? "repo-2" : "repo-1",
      name: `bulk task ${i}`,
      agent: (["claude", "codex", "gemini"] as const)[i % 3],
      status: lane === "queued" ? "pending" : lane === "needs-review" ? "completed" : "running",
      branch: lane === "queued" ? null : `phasr/bulk-${i}`,
      startedAt: lane === "queued" ? null : t((i + 1) * 1000),
      queuedAt: lane === "queued" ? t(i * 1000) : null,
      finishedAt: lane === "needs-review" ? t(i * MIN) : null,
    });
    cards.push(
      card(w, lane, {
        diff: lane === "needs-review" || lane === "running" ? { adds: i, removes: i % 7, files: 1 + (i % 5) } : null,
        agentState:
          lane === "running"
            ? state(w.id as string, w.repositoryId as string, { lastActivity: `Editing src/file-${i}.ts` })
            : lane === "needs-you"
              ? state(w.id as string, w.repositoryId as string, {
                  state: "needs-you",
                  attention: { ...needsState.attention, id: `att-bulk-${i}`, detail: `pnpm add pkg-${i}` },
                })
              : null,
        finishedAt: lane === "needs-review" ? t(i * MIN) : null,
      }),
    );
  }

  const workspaces = [...f.workspaces, ...cards.map((c) => c.workspace)] as unknown as Fixtures["workspaces"];
  const check = (id: string, status: string) => ({
    id: `cr-${id}`,
    workspaceId: id,
    runCommandId: "rc-2",
    name: "test",
    command: "pnpm test",
    status,
    exitCode: status === "passed" ? 0 : 1,
    fingerprint: null,
    createdAt: t(20 * MIN),
    startedAt: t(20 * MIN),
    finishedAt: t(19 * MIN),
    durationMs: 60_000,
    outputTail: "",
  });
  const summary = (runs: ReturnType<typeof check>[]) => ({
    runs,
    required: [],
    requiredSatisfied: true,
    staleIds: [],
    needsConfirmation: [],
  });

  return {
    ...f,
    workspaces,
    landing: "board",
    checkRuns: { "ws-review-1": summary([check("ws-review-1", "passed")]) },
    overrides: {
      list_task_cards: cards,
      list_agent_states: cards.map((c) => c.agentState).filter(Boolean),
      respond_to_attention: null,
    },
  };
}
