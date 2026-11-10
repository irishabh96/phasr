/**
 * E2E harness: boots the REAL phasr app in a browser against the Vite dev
 * server with a mocked Tauri IPC layer. Seeds an auth session, answers the
 * boot-critical `invoke` commands with fixtures, records every call, and lets
 * a test emit Tauri events + PTY channel messages. Lets us drive real screens
 * end-to-end (finding integration/render/state/interaction bugs) without the
 * native shell. Native-only paths (real PTY/git/OS) still need manual QA.
 */
import { type Page, expect } from "@playwright/test";

const NOW = "2026-07-13T10:00:00.000Z";

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}
// JWT with sub/name/email and NO exp -> readDesktopSession treats it "fresh"
// (no Clerk refresh needed). Signature is never verified client-side.
const JWT = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({
  sub: "user_test",
  name: "Ronak",
  email: "ronak@tamasha.live",
  picture: null,
})}.sig`;

export function makeFixtures() {
  const repositories = [
    {
      id: "repo-1",
      name: "phasr",
      remoteUrl: "https://github.com/acme/phasr",
      localPath: "/Users/test/code/phasr",
      defaultBranch: "main",
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "repo-2",
      name: "sidecar",
      remoteUrl: null,
      localPath: "/Users/test/code/sidecar",
      defaultBranch: "main",
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const wsBase = {
    prompt: "Add the thing",
    command: "claude",
    exitCode: null,
    createdAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    archivedAt: null,
    updatedAt: NOW,
  };
  const workspaces = [
    {
      ...wsBase,
      id: "ws-agent",
      repositoryId: "repo-1",
      workspaceKind: "agent",
      name: "add-feature",
      agent: "claude",
      status: "running",
      branch: "phasr/add-feature",
      worktreePath: "/Users/test/.phasr/worktrees/ws-agent",
    },
    {
      ...wsBase,
      id: "ws-done",
      repositoryId: "repo-1",
      workspaceKind: "agent",
      name: "fix-bug",
      agent: "codex",
      status: "completed",
      branch: "phasr/fix-bug",
      worktreePath: "/Users/test/.phasr/worktrees/ws-done",
      exitCode: 0,
      finishedAt: NOW,
    },
    {
      ...wsBase,
      id: "ws-local",
      repositoryId: "repo-1",
      workspaceKind: "local",
      name: "main",
      agent: null,
      prompt: null,
      status: "stopped",
      branch: "main",
      worktreePath: "/Users/test/code/phasr",
    },
  ];
  const agents = [
    { agent: "claude", label: "Claude", command: "claude", isDefault: true },
    { agent: "codex", label: "Codex", command: "codex", isDefault: false },
    { agent: "gemini", label: "Gemini", command: "gemini", isDefault: false },
  ];
  const userSettings = {
    theme: "dark",
    accentColor: "coral",
    sansFont: "system-ui",
    monoFont: "SF Mono",
    baseFontSize: 13,
    cursorStyle: "block",
    cursorBlink: true,
    terminalScrollback: 5000,
    defaultEditor: "vscode",
    defaultTerminal: "terminal",
    keyboardShortcuts: "default",
    branchPrefixTemplate: "phasr/",
    worktreeBasePath: "/Users/test/.phasr/worktrees",
    defaultMergeStrategy: "merge",
    autoFetchSeconds: 0,
    honorGpgSign: false,
    autoPushOnCommit: false,
    updatedAt: NOW,
  };
  const runCommands = [
    {
      id: "rc-1",
      repositoryId: "repo-1",
      name: "dev",
      command: "pnpm dev",
      shortcut: "1",
      pinned: true,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: "rc-2",
      repositoryId: "repo-1",
      name: "test",
      command: "pnpm test",
      shortcut: null,
      pinned: false,
      sortOrder: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const EARLIER = new Date(Date.parse(NOW) - 3_600_000).toISOString();
  const notes = [
    {
      id: "note-1",
      repositoryId: "repo-1",
      body: "Seed script needs DATABASE_URL exported first — .env.local is stale.",
      originKind: "terminal",
      originWorkspaceId: "ws-agent",
      originWorkspaceName: "add-feature",
      originTerminalId: "session:dead",
      originLabel: "Terminal 2",
      createdAt: NOW,
      updatedAt: NOW,
      doneAt: null,
    },
    {
      id: "note-2",
      repositoryId: "repo-1",
      body: "Codex keeps rewriting the vite config. Pin it in the prompt.",
      originKind: "workspace",
      originWorkspaceId: "ws-gone",
      originWorkspaceName: "checkout-flow",
      originTerminalId: null,
      originLabel: "Agent",
      createdAt: EARLIER,
      updatedAt: EARLIER,
      doneAt: null,
    },
  ];
  const gitStatus = [
    { path: "src/app.ts", oldPath: null, staged: "other", unstaged: "modified", adds: 12, removes: 3 },
    { path: "src/new.ts", oldPath: null, staged: "added", unstaged: "other", adds: 40, removes: 0 },
    { path: "README.md", oldPath: null, staged: "other", unstaged: "modified", adds: 1, removes: 1 },
  ];
  const branchStatus = {
    branch: "phasr/add-feature",
    upstream: "origin/phasr/add-feature",
    ahead: 2,
    behind: 0,
    hasRemote: true,
    detached: false,
    targetRef: "origin/main",
    aheadOfTarget: 2,
    behindOfTarget: 0,
    // The task's base: what Merge locally merges into and the counts are against.
    baseBranch: "main",
  };
  const commits = [
    {
      sha: "a".repeat(40),
      shortSha: "aaaaaaa",
      subject: "Add the feature",
      body: null,
      authorName: "Ronak",
      authorEmail: "ronak@tamasha.live",
      authorDate: NOW,
      parents: ["b".repeat(40)],
    },
  ];
  const sampleDiff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 111..222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,3 @@",
    " context line",
    "-old line",
    "+new line",
  ].join("\n");
  return {
    now: NOW,
    session: {
      userId: "user_test",
      desktopSession: {
        jwt: JWT,
        userId: "user_test",
        expiresAt: null,
        profile: { name: "Ronak", email: "ronak@tamasha.live", imageUrl: null },
      },
    },
    repositories,
    workspaces,
    agents,
    userSettings,
    runCommands,
    notes,
    gitStatus,
    branchStatus,
    commits,
    sampleDiff,
    // Live-PTY activity snapshot: the running fixture workspace produced
    // output "just now", so its sidebar dot shows by default. Override
    // `list_task_activity` with a stale timestamp to test the timeout.
    taskActivity: [{ taskId: "ws-agent", lastOutputAt: Date.now() }],
  };
}

// Runs INSIDE the browser (serialized) — must be self-contained.
function installMock(cfg: ReturnType<typeof makeFixtures>) {
  const f = cfg;
  localStorage.setItem("phasr.auth.desktopSession", JSON.stringify(f.session.desktopSession));
  // The suite runs at 1280px, the A-Compact width; specs assume both side
  // panels open unless they fold them. A spec testing auto-collapse sets
  // `fixtures.autoCollapse = true`.
  if (!(f as any).autoCollapse) localStorage.setItem("phasr.autoCollapse", "off");
  // Cold launch reopens the last task (the board is "/" otherwise). Specs
  // that want the board set `fixtures.landing = "board"`.
  if ((f as any).landing !== "board" && !localStorage.getItem("phasr.lastWorkspace")) {
    localStorage.setItem(
      "phasr.lastWorkspace",
      JSON.stringify({ repositoryId: "repo-1", workspaceId: "ws-agent" }),
    );
  }

  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const listenerIds = new Map<number, (e: unknown) => void>();
  let listenerSeq = 0;
  const channels: Record<string, { onmessage?: (m: unknown) => void }> = {};
  const calls: Array<{ cmd: string; args: unknown }> = [];
  // Seed overrides at boot (e.g. make open_task_terminal reject from the very
  // first mount) via fixtures.overrides — set before any command fires.
  const overrides: Record<string, unknown> = { ...((f as any).overrides ?? {}) };
  let sessionSeq = 0;

  // ── Stateful backend (opt-in: `fixtures.stateful = true`) ──────────────
  //
  // Without it every command answers from the fixtures, so "after doing X
  // the UI shows Y" can't be tested: delete returns null and the lists
  // still hold the row, start_task's task appears nowhere, and no event
  // follows a mutation. With it the fixtures are the INITIAL state of an
  // in-memory store: mutations change the store, list commands read it,
  // and each mutation emits what the real backend emits
  // (`src-tauri/src/commands/events.rs`, `orchestrator/board.rs`):
  //
  //  - `phasr://task-status` for lifecycle transitions (orchestrator
  //    `broadcast_status`: create / queue / launch / resume / stop),
  //  - `phasr://task-cards-changed` `{repositoryId, taskIds?}`, coalesced
  //    per repository (the board's `on_status`, and `notify_changed` after
  //    update / archive / delete / approve / discard / merge),
  //  - `phasr://task-agent-state` for agent-state changes,
  //  - `phasr://run-command-state` for run commands,
  //  - `phasr://transcript` for a transcript-view task's items
  //    (`get_transcript` / `set_agent_view` / `interrupt_task` /
  //    `stop_background_shell`, and `send_message_to_task` when the task's
  //    `agentView` is "transcript"; `world.transcript` / `subagent` /
  //    `backgroundShell` / `turnStarts` / `turnEnds` drive the agent),
  //  - `phasr://suggestions` when a turn's reply suggestions are ready
  //    (`world.suggestionsReady`). Until then `suggest_replies` answers
  //    `[]` — or, with `fixtures.holdSuggestions`, stays pending like a
  //    generation in flight and resolves with them.
  //
  // Events fire a beat AFTER the command resolves, as over real IPC. The
  // store survives a reload (sessionStorage), like the backend outlives
  // the webview. Mutations the real backend doesn't announce (deleting a
  // repository) announce nothing here either — that gap is the point.
  const stateful = !!(f as any).stateful;
  const NOT_HANDLED = Symbol("not-handled");
  const STORE_KEY = "phasr.e2e.backend";
  const EVENT_DELAY = (f as any).eventDelayMs ?? 40;
  const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const nowIso = () => new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null;
  if (stateful) {
    const saved = sessionStorage.getItem(STORE_KEY);
    if (saved) {
      db = JSON.parse(saved);
    } else {
      const seededCards = Array.isArray(overrides.list_task_cards) ? (overrides.list_task_cards as any[]) : [];
      const seededStates = Array.isArray(overrides.list_agent_states) ? (overrides.list_agent_states as any[]) : [];
      const fx = f as any;
      db = {
        seq: 0,
        prSeq: 41,
        repositories: clone(f.repositories),
        workspaces: clone(f.workspaces),
        // Per task: diff vs base (decides review vs done), uncommitted
        // changes (the approve / merge gate), a dependency's display name.
        meta: {} as Record<string, any>,
        agentStates: {} as Record<string, any>,
        runCommands: clone(f.runCommands),
        running: [] as any[],
        notes: clone(f.notes),
        settings: { defaultPermissionMode: "ask-shell", ...clone(f.userSettings) },
        remoteMerged: {} as Record<string, true>,
        // Agent transcript view: per task, the persisted items
        // (`fixtures.transcripts` seeds them) and whether a turn runs.
        transcripts: clone(fx.transcripts ?? {}) as Record<string, any[]>,
        turns: {} as Record<string, true>,
        // Reply suggestions per task, once "generated".
        suggestions: {} as Record<string, any[]>,
      };
      for (const c of seededCards) {
        const i = db.workspaces.findIndex((w: any) => w.id === c.workspace.id);
        if (i === -1) db.workspaces.push(clone(c.workspace));
        db.meta[c.workspace.id] = { diff: c.diff ?? null, dependsOnName: c.dependsOnName ?? null };
        if (c.agentState) db.agentStates[c.workspace.id] = clone(c.agentState);
      }
      for (const s of seededStates) db.agentStates[s.taskId] = clone(s);
      for (const w of db.workspaces) {
        if (w.workspaceKind !== "agent" || db.meta[w.id]) continue;
        const files = f.gitStatus.length;
        const adds = f.gitStatus.reduce((n: number, g: any) => n + (g.adds ?? 0), 0);
        const removes = f.gitStatus.reduce((n: number, g: any) => n + (g.removes ?? 0), 0);
        db.meta[w.id] = { diff: w.worktreePath ? { adds, removes, files } : null };
      }
      for (const [id, m] of Object.entries(fx.taskMeta ?? {})) db.meta[id] = { ...(db.meta[id] ?? {}), ...(m as object) };
    }
    db.transcripts ??= {};
    db.turns ??= {};
    db.suggestions ??= {};
    // The store answers these now; a spec can still inject a failure with
    // setResponse.
    delete overrides.list_task_cards;
    delete overrides.list_agent_states;
    delete overrides.respond_to_attention;
  }
  const save = () => {
    if (stateful) sessionStorage.setItem(STORE_KEY, JSON.stringify(db));
  };

  const fire = (event: string, payload: unknown) =>
    (listeners[event] ?? []).slice().forEach((h) => h({ event, id: 1, payload: clone(payload) }));
  const later = (fn: () => void) => window.setTimeout(fn, EVENT_DELAY);
  /** `suggest_replies` calls held until `world.suggestionsReady`. */
  const suggestWaiters: Array<(v: unknown) => void> = [];

  // Board change notifications, coalesced per repository like
  // `TaskBoard::queue_change`: task ids when every cause named one.
  const pendingCards = new Map<string, Set<string> | null>();
  let cardsTimer: number | null = null;
  const cardsChanged = (repositoryId: string, taskId?: string) => {
    if (!pendingCards.has(repositoryId)) pendingCards.set(repositoryId, taskId ? new Set([taskId]) : null);
    else {
      const cur = pendingCards.get(repositoryId);
      if (cur && taskId) cur.add(taskId);
      else pendingCards.set(repositoryId, null);
    }
    if (cardsTimer !== null) return;
    cardsTimer = window.setTimeout(() => {
      cardsTimer = null;
      const batch = [...pendingCards.entries()];
      pendingCards.clear();
      for (const [repositoryId, ids] of batch) {
        fire("phasr://task-cards-changed", {
          repositoryId,
          ...(ids ? { taskIds: [...ids].sort() } : {}),
        });
      }
    }, EVENT_DELAY);
  };
  /** `broadcast_status` → task-status, and the board's `on_status`. */
  const statusChanged = (w: any) => {
    later(() =>
      fire("phasr://task-status", {
        taskId: w.id,
        repositoryId: w.repositoryId,
        status: w.status,
        exitCode: w.exitCode ?? null,
      }),
    );
    cardsChanged(w.repositoryId, w.id);
  };
  const setAgentState = (w: any, patch: Record<string, unknown>) => {
    const next = {
      taskId: w.id,
      repositoryId: w.repositoryId,
      state: "working",
      attention: null,
      lastActivity: null,
      lastTurnEndedAt: null,
      ...(db.agentStates[w.id] ?? {}),
      ...patch,
    };
    db.agentStates[w.id] = next;
    later(() => fire("phasr://task-agent-state", next));
    cardsChanged(w.repositoryId, w.id);
  };

  /**
   * Agent transcript view (specs/agent-transcript-view-spec.md §4): store
   * the item (replace by id, else append) and emit `phasr://transcript`
   * the way `agent_stream`'s event bridge does.
   */
  const transcriptPut = (taskId: string, item: any, op?: "append" | "update") => {
    const list = (db.transcripts[taskId] ??= []);
    const i = list.findIndex((x: any) => x.id === item.id);
    if (i === -1) list.push(item);
    else list[i] = item;
    const payload = { taskId, op: op ?? (i === -1 ? "append" : "update"), item };
    later(() => fire("phasr://transcript", payload));
  };
  let tsSeq = 0;
  const transcriptId = (kind: string) => `${kind}-${++db.seq}-${++tsSeq}`;
  const turnStarts = (w: any) => {
    db.turns[w.id] = true;
    setAgentState(w, { state: "working", attention: null });
  };
  const turnEnds = (w: any) => {
    delete db.turns[w.id];
    setAgentState(w, { state: "idle", attention: null, lastTurnEndedAt: nowIso() });
  };

  const findWs = (id: string) => db.workspaces.find((w: any) => w.id === id) ?? null;
  const repoOf = (w: any) => db.repositories.find((r: any) => r.id === w.repositoryId) ?? null;
  const touch = (w: any) => {
    w.updatedAt = nowIso();
    return w;
  };
  const reject = (msg: string) => ({ __reject: msg });

  /** `domain::board::derive_lane`, verbatim. */
  const laneOf = (w: any): string | null => {
    if (w.workspaceKind === "local") return null;
    if (w.outcome) return "done";
    const diff = db.meta[w.id]?.diff ?? null;
    const hasChanges = diff ? diff.files > 0 : null;
    const agent = db.agentStates[w.id]?.state ?? null;
    const unlaunched = w.status === "pending" && !w.branch;
    if (w.status === "archived") return "archived";
    if (unlaunched) return w.queuedAt ? "queued" : "draft";
    switch (w.status) {
      case "failed":
        return "failed";
      case "running":
        if (agent === "needs-you") return "needs-you";
        if ((agent === "idle" || agent === "exited") && hasChanges === true) return "needs-review";
        return "running";
      case "stopped":
      case "completed":
        return hasChanges === false ? "done" : "needs-review";
      default:
        return agent === "needs-you" ? "needs-you" : agent ? "running" : "draft";
    }
  };
  const FINISHED_LANES = new Set(["needs-review", "done", "failed", "archived"]);
  const cardOf = (w: any) => {
    const lane = laneOf(w);
    if (!lane) return null;
    const m = db.meta[w.id] ?? {};
    const dep = w.dependsOnWorkspaceId ? findWs(w.dependsOnWorkspaceId) : null;
    return {
      workspace: w,
      lane,
      diff: lane === "draft" || lane === "queued" || lane === "archived" ? null : (m.diff ?? null),
      agentState: db.agentStates[w.id] ?? null,
      usage: null,
      finishedAt: FINISHED_LANES.has(lane) ? (w.outcomeAt ?? w.finishedAt ?? w.archivedAt ?? w.updatedAt) : null,
      dependsOnName: m.dependsOnName ?? dep?.name ?? null,
    };
  };

  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
  /** What `launch` writes: the worktree, branch and base, running now. */
  const launch = (w: any) => {
    const repo = repoOf(w);
    const now = nowIso();
    w.status = "running";
    w.branch = `phasr/${slug(w.name) || w.id}`;
    w.worktreePath = `/Users/test/.phasr/worktrees/${w.id}`;
    w.baseBranch = w.baseBranch ?? repo?.defaultBranch ?? "main";
    w.startedAt = now;
    w.finishedAt = null;
    w.exitCode = null;
    touch(w);
    db.meta[w.id] = { ...(db.meta[w.id] ?? {}), diff: { adds: 0, removes: 0, files: 0 } };
    statusChanged(w);
    setAgentState(w, { state: "working", attention: null });
  };
  const newTaskRow = (input: any, extra: Record<string, unknown>) => {
    const now = nowIso();
    return {
      id: `ws-new-${++db.seq}`,
      repositoryId: input.repositoryId,
      workspaceKind: "agent",
      name: input.name,
      prompt: input.prompt ?? null,
      agent: input.agent,
      command: input.agent,
      status: "pending",
      branch: null,
      worktreePath: null,
      exitCode: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      archivedAt: null,
      updatedAt: now,
      permissionMode: input.permissionMode ?? db.settings.defaultPermissionMode ?? "ask-shell",
      notifyOnAttention: input.notifyOnAttention ?? true,
      lastTurnEndedAt: null,
      baseBranch: input.baseBranch ?? null,
      queuedAt: null,
      dependsOnWorkspaceId: input.dependsOn ?? null,
      outcome: null,
      outcomeAt: null,
      mergedInto: null,
      prNumber: null,
      prUrl: null,
      prState: null,
      ...extra,
    };
  };
  /** `quiesce_task`: the PTY and the agent state go, the row stops. */
  const quiesce = (w: any) => {
    if (w.status === "running") {
      w.status = "stopped";
      w.finishedAt = nowIso();
    }
    delete db.agentStates[w.id];
    stopRunsFor(w.id);
  };

  const runChannels: Record<string, { onmessage?: (m: unknown) => void }> = {};
  const runKeyOf = (id: string, ws: string | null | undefined) => `${id}@${ws ?? ""}`;
  const runState = (r: any) => later(() => fire("phasr://run-command-state", { ...r }));
  const runOut = (key: string, text: string) =>
    runChannels[key]?.onmessage?.({
      type: "output",
      taskId: key,
      chunk: btoa(unescape(encodeURIComponent(text))),
    });
  const startRun = (id: string, ws: string | null, onEvent?: any) => {
    const key = runKeyOf(id, ws);
    if (onEvent) runChannels[key] = onEvent;
    let r = db.running.find((x: any) => x.runCommandId === id && (x.workspaceId ?? null) === ws);
    if (r?.running) return;
    const rc = db.runCommands.find((x: any) => x.id === id);
    if (!rc) return reject("run command not found");
    if (!r) {
      r = { runCommandId: id, workspaceId: ws, startedAt: nowIso(), running: true, exitCode: null, port: null };
      db.running.push(r);
    }
    Object.assign(r, { startedAt: nowIso(), running: true, exitCode: null, port: null });
    runState(r);
    const port = (f as any).runPorts?.[id] ?? null;
    later(() => {
      runOut(key, `$ ${rc.command}\r\n`);
      if (port && r.running) {
        runOut(key, `  ➜  Local:   http://localhost:${port}/\r\n`);
        r.port = port;
        save();
        runState(r);
      }
    });
  };
  const stopRun = (r: any) => {
    if (!r.running) return;
    Object.assign(r, { running: false, exitCode: null, port: null });
    runState(r);
    runChannels[runKeyOf(r.runCommandId, r.workspaceId)]?.onmessage?.({
      type: "exit",
      taskId: r.runCommandId,
      exitCode: null,
    });
  };
  function stopRunsFor(workspaceId: string) {
    for (const r of db.running) if (r.workspaceId === workspaceId) stopRun(r);
  }

  /** The stateful answer to `cmd`, or NOT_HANDLED to fall back to RESP. */
  const STATE = (cmd: string, a: any): unknown => {
    switch (cmd) {
      // ── repositories ──
      case "list_repositories":
        return db.repositories;
      case "get_repository":
        return db.repositories.find((r: any) => r.id === a?.id) ?? reject("not found");
      case "create_repository": {
        const input = a?.input ?? {};
        const now = nowIso();
        const repo = {
          id: `repo-new-${++db.seq}`,
          name: input.name,
          remoteUrl: input.remoteUrl ?? null,
          localPath: input.localPath ?? null,
          defaultBranch: "main",
          createdAt: now,
          updatedAt: now,
        };
        db.repositories.push(repo);
        return repo;
      }
      case "delete_repository": {
        const repo = db.repositories.find((r: any) => r.id === a?.id);
        if (!repo) return reject("not found");
        // Like `commands::repositories::delete_repository`: quiesce every
        // task, drop the rows — and announce nothing to the board.
        for (const w of db.workspaces.filter((x: any) => x.repositoryId === repo.id)) quiesce(w);
        db.workspaces = db.workspaces.filter((x: any) => x.repositoryId !== repo.id);
        db.repositories = db.repositories.filter((r: any) => r.id !== repo.id);
        return null;
      }

      // ── workspaces / tasks ──
      case "list_workspaces":
        return db.workspaces.filter((w: any) => w.repositoryId === a?.repositoryId);
      case "get_workspace":
        return findWs(a?.id) ?? reject("not found");
      case "list_task_cards":
        return db.workspaces
          .filter((w: any) => !a?.repositoryId || w.repositoryId === a.repositoryId)
          .map(cardOf)
          .filter(Boolean)
          .sort((x: any, y: any) => y.workspace.createdAt.localeCompare(x.workspace.createdAt));
      case "list_agent_states":
        return Object.values(db.agentStates);
      case "get_system_status":
        return {
          agentsRunning: db.workspaces.filter((w: any) => w.workspaceKind === "agent" && w.status === "running").length,
          worktrees: db.workspaces.filter((w: any) => w.workspaceKind === "agent" && w.worktreePath).length,
          sync: "off",
        };
      case "update_workspace": {
        const w = findWs(a?.id);
        if (!w) return reject("not found");
        const input = a?.input ?? {};
        for (const k of ["name", "prompt", "agent", "command", "status", "branch", "worktreePath", "exitCode", "permissionMode", "notifyOnAttention"]) {
          if (input[k] !== undefined) w[k] = input[k];
        }
        touch(w);
        cardsChanged(w.repositoryId);
        return w;
      }
      case "archive_workspace": {
        const w = findWs(a?.id);
        if (!w) return reject("not found");
        quiesce(w);
        w.status = "archived";
        w.archivedAt = nowIso();
        touch(w);
        cardsChanged(w.repositoryId);
        return w;
      }
      case "check_workspace_delete": {
        const w = findWs(a?.id);
        if (!w) return reject("not found");
        return { hasUnpushedCommits: !!db.meta[w.id]?.unpushed };
      }
      case "delete_workspace": {
        const w = findWs(a?.id);
        // Already gone: the real command answers exactly this.
        if (!w) return reject("not found");
        quiesce(w);
        db.workspaces = db.workspaces.filter((x: any) => x.id !== w.id);
        delete db.meta[w.id];
        cardsChanged(w.repositoryId);
        return null;
      }
      case "start_task": {
        const input = a?.input ?? {};
        const repo = db.repositories.find((r: any) => r.id === input.repositoryId);
        if (!repo) return reject("not found");
        const w = newTaskRow(input, {});
        db.workspaces.push(w);
        if (input.runIn === "in-place") {
          w.status = "running";
          w.worktreePath = repo.localPath;
          w.startedAt = nowIso();
          db.meta[w.id] = { diff: null };
          statusChanged(w);
          setAgentState(w, { state: "working" });
        } else {
          w.baseBranch = input.baseBranch ?? repo.defaultBranch;
          launch(w);
        }
        return { taskId: w.id, workspace: w };
      }
      case "create_task_draft": {
        const input = a?.input ?? {};
        if (!db.repositories.some((r: any) => r.id === input.repositoryId)) return reject("not found");
        const w = newTaskRow(input, { queuedAt: input.queue ? nowIso() : null });
        db.workspaces.push(w);
        db.meta[w.id] = { diff: null };
        statusChanged(w);
        return w;
      }
      case "update_task_draft":
      case "set_task_queued": {
        const w = findWs(a?.id);
        if (!w) return reject("not found");
        if (!(w.status === "pending" && !w.branch)) return reject("this task has already started");
        if (cmd === "set_task_queued") w.queuedAt = a?.queued ? nowIso() : null;
        else {
          const input = a?.input ?? {};
          for (const k of ["name", "prompt", "agent", "permissionMode", "baseBranch", "notifyOnAttention"]) {
            if (input[k] !== undefined) w[k] = input[k];
          }
          if (input.dependsOn !== undefined) w.dependsOnWorkspaceId = input.dependsOn;
        }
        touch(w);
        statusChanged(w);
        return w;
      }
      case "start_queued_task": {
        const w = findWs(a?.id);
        if (!w) return reject("not found");
        if (w.status === "pending" && !w.branch) launch(w);
        return { taskId: w.id, workspace: w };
      }
      case "open_task_terminal": {
        const w = findWs(a?.taskId);
        if (!w) return reject("not found");
        if (w.workspaceKind === "agent") {
          if (["completed", "failed", "archived"].includes(w.status))
            return reject(`task is already finished (status: ${w.status}); create a new one to retry`);
          if (w.status === "pending" && !w.startedAt) return reject("this task hasn't started yet; start it first");
          if (w.status !== "running") {
            // Resume in the same worktree (`open_terminal`).
            w.status = "running";
            w.startedAt = nowIso();
            w.finishedAt = null;
            w.exitCode = null;
            touch(w);
            statusChanged(w);
            setAgentState(w, { state: "working", attention: null });
          }
        }
        return { taskId: w.id, startedAt: w.startedAt ?? f.now };
      }
      case "stop_task": {
        const w = findWs(a?.taskId);
        if (!w) return reject("not found");
        if (w.status !== "running") return null;
        w.status = "stopped";
        w.finishedAt = nowIso();
        touch(w);
        statusChanged(w);
        setAgentState(w, { state: "exited", attention: null });
        later(() => channels[w.id]?.onmessage?.({ type: "exit", taskId: w.id, exitCode: null }));
        return null;
      }
      case "respond_to_attention": {
        const w = findWs(a?.taskId);
        if (!w || w.status !== "running") return reject(`task is not running: ${a?.taskId}`);
        const st = db.agentStates[w.id];
        if (st?.state !== "needs-you" || st.attention?.id !== a?.attentionId) return reject("stale attention");
        setAgentState(w, { state: "working", attention: null });
        return null;
      }

      // ── agent transcript view ──
      case "get_transcript":
        return db.transcripts[a?.taskId] ?? [];
      case "suggest_replies":
        return db.suggestions[a?.taskId] ?? [];
      case "set_agent_view": {
        const w = findWs(a?.taskId);
        if (!w) return reject("not found");
        if (a?.view !== "transcript" && a?.view !== "terminal") return reject(`unknown view: ${a?.view}`);
        if (db.turns[w.id]) return reject("can't switch views while a turn is running; stop it first");
        w.agentView = a.view;
        touch(w);
        cardsChanged(w.repositoryId, w.id);
        return w;
      }
      case "interrupt_task": {
        const w = findWs(a?.taskId);
        if (!w) return reject("not found");
        if (!db.turns[w.id]) return null;
        transcriptPut(w.id, { kind: "system", id: transcriptId("system"), ts: nowIso(), level: "info", text: "Interrupted" });
        turnEnds(w);
        return null;
      }
      case "stop_background_shell": {
        // The CLI's `stop_task`: the command's item turns "killed".
        const w = findWs(a?.taskId);
        if (!w) return reject("not found");
        const item = (db.transcripts[w.id] ?? []).find((x: any) => x.id === a?.toolUseId);
        if (!item || item.backgroundStatus !== "running") return reject("that background command isn't running");
        transcriptPut(w.id, { ...item, backgroundStatus: "killed" }, "update");
        save();
        return null;
      }
      case "send_message_to_task": {
        const w = findWs(a?.taskId);
        // Terminal view keeps the fixture answer.
        if (!w || w.agentView !== "transcript") return NOT_HANDLED;
        if (w.status !== "running") return reject("agent not running");
        if (db.agentStates[w.id]?.state === "needs-you") return reject("the agent is waiting for your answer");
        transcriptPut(w.id, { kind: "user", id: transcriptId("user"), ts: nowIso(), text: a?.text ?? "" });
        turnStarts(w);
        return null;
      }

      // ── close-out ──
      case "approve_and_create_pr": {
        const w = findWs(a?.workspaceId);
        if (!w) return reject("not found");
        if (!w.branch) return reject("task has no branch");
        const input = a?.input ?? {};
        const m = (db.meta[w.id] ??= {});
        if (m.dirty && !input.commitDirty) return reject("worktree has uncommitted changes");
        if (m.dirty) m.dirty = false;
        const number = ++db.prSeq;
        const repo = repoOf(w);
        w.prNumber = number;
        w.prUrl = `${repo?.remoteUrl ?? "https://github.com/acme/repo"}/pull/${number}`;
        w.prState = input.draft ? "draft" : "open";
        touch(w);
        cardsChanged(w.repositoryId);
        return { url: w.prUrl, number, viaGh: true, draft: !!input.draft };
      }
      case "refresh_pr_states": {
        const changed: any[] = [];
        for (const w of db.workspaces) {
          if (!db.remoteMerged[w.id] || w.outcome || (a?.repositoryId && w.repositoryId !== a.repositoryId)) continue;
          w.outcome = "merged";
          w.outcomeAt = nowIso();
          w.mergedInto = w.baseBranch ?? repoOf(w)?.defaultBranch ?? "main";
          w.prState = "merged";
          touch(w);
          changed.push(w);
          cardsChanged(w.repositoryId);
        }
        return changed;
      }
      case "discard_workspace": {
        const w = findWs(a?.workspaceId);
        if (!w) return reject("not found");
        quiesce(w);
        w.outcome = "closed";
        w.outcomeAt = nowIso();
        w.worktreePath = null;
        touch(w);
        cardsChanged(w.repositoryId);
        return w;
      }
      case "git_merge_to_main": {
        const w = findWs(a?.workspaceId);
        if (!w) return reject("not found");
        const m = (db.meta[w.id] ??= {});
        if (w.workspaceKind === "agent" && m.dirty && !a?.commitDirty) return reject("worktree has uncommitted changes");
        if (m.dirty) m.dirty = false;
        if (w.workspaceKind === "agent") {
          w.outcome = "merged";
          w.outcomeAt = nowIso();
          w.mergedInto = w.baseBranch ?? repoOf(w)?.defaultBranch ?? "main";
          touch(w);
          cardsChanged(w.repositoryId);
        }
        return { kind: "clean", message: "Merged cleanly" };
      }
      case "git_status": {
        const w = findWs(a?.workspaceId);
        // Uncommitted changes only while the task is dirty (`taskMeta`).
        if (w?.workspaceKind === "agent") return db.meta[w.id]?.dirty ? f.gitStatus : [];
        return NOT_HANDLED;
      }
      case "git_branch_status": {
        const w = findWs(a?.workspaceId);
        if (!w) return NOT_HANDLED;
        return { ...f.branchStatus, branch: w.branch ?? f.branchStatus.branch, baseBranch: w.baseBranch ?? "main" };
      }

      // ── run commands ──
      case "list_run_commands":
        return db.runCommands.filter((r: any) => r.repositoryId === a?.repositoryId);
      case "list_running_commands":
        return a?.workspaceId == null
          ? db.running
          : db.running.filter((r: any) => r.workspaceId === a.workspaceId);
      case "start_run_command":
        return startRun(a?.id, a?.workspaceId ?? null, a?.onEvent) ?? null;
      case "start_run_command_for_task":
        return startRun(a?.id, a?.workspaceId ?? null) ?? null;
      case "attach_run_command": {
        const ws = a?.workspaceId ?? null;
        const r = db.running.find((x: any) => x.runCommandId === a?.id && (x.workspaceId ?? null) === ws && x.running);
        if (!r) return reject("not running");
        runChannels[runKeyOf(a.id, ws)] = a.onEvent;
        return null;
      }
      case "stop_run_command": {
        const ws = a?.workspaceId ?? null;
        const r = db.running.find((x: any) => x.runCommandId === a?.id && (x.workspaceId ?? null) === ws);
        if (r) stopRun(r);
        return null;
      }

      // ── notes ──
      case "list_notes_for_repository":
        return db.notes.filter((n: any) => n.repositoryId === a?.repositoryId);
      case "create_note": {
        const input = a?.input ?? {};
        const now = nowIso();
        const origin = input.originWorkspaceId ? findWs(input.originWorkspaceId) : null;
        const note = {
          id: `note-new-${++db.seq}`,
          repositoryId: input.repositoryId,
          body: (input.body ?? "").trim(),
          originKind: input.originKind ?? "repository",
          originWorkspaceId: input.originWorkspaceId ?? null,
          originWorkspaceName: origin?.name ?? null,
          originTerminalId: input.originTerminalId ?? null,
          originLabel: input.originLabelHint ?? "Repository home",
          createdAt: now,
          updatedAt: now,
          doneAt: null,
        };
        db.notes.unshift(note);
        return note;
      }
      case "update_note": {
        const n = db.notes.find((x: any) => x.id === a?.id);
        if (!n) return reject("not found");
        if (a?.input?.body !== undefined) n.body = a.input.body;
        n.updatedAt = nowIso();
        return n;
      }
      case "set_note_done": {
        const n = db.notes.find((x: any) => x.id === a?.id);
        if (!n) return reject("not found");
        n.doneAt = a?.done ? nowIso() : null;
        return n;
      }
      case "delete_note":
        db.notes = db.notes.filter((x: any) => x.id !== a?.id);
        return null;

      // ── settings ──
      case "get_user_settings":
        return db.settings;
      case "update_user_settings":
        db.settings = { ...db.settings, ...(a?.settings ?? {}), updatedAt: nowIso() };
        return db.settings;
      default:
        return NOT_HANDLED;
    }
  };

  /**
   * Things that happen OUTSIDE the app — an agent asking for approval or
   * getting back to work, a PR merged on GitHub. A spec drives these the
   * way the world would; everything the user does goes through the UI.
   */
  const world = {
    agentAsks(taskId: string, attention: Record<string, unknown> = {}) {
      const w = findWs(taskId);
      if (!w) throw new Error(`no task ${taskId}`);
      setAgentState(w, {
        state: "needs-you",
        attention: {
          id: `att-${++db.seq}`,
          kind: "shell",
          title: "Run a shell command",
          detail: "pnpm install",
          since: nowIso(),
          source: "hook",
          canRespond: true,
          canAllowForTask: false,
          ...attention,
        },
      });
      save();
      return db.agentStates[taskId].attention.id;
    },
    agentWorking(taskId: string, lastActivity: string | null = null) {
      const w = findWs(taskId);
      if (!w) throw new Error(`no task ${taskId}`);
      setAgentState(w, { state: "working", attention: null, lastActivity });
      save();
    },
    prMergedOnRemote(taskId: string) {
      db.remoteMerged[taskId] = true;
      save();
    },
    /** Transcript view: the agent streams an item (new id → append, else update). */
    transcript(taskId: string, item: Record<string, unknown>, op?: "append" | "update") {
      if (!findWs(taskId)) throw new Error(`no task ${taskId}`);
      transcriptPut(taskId, { ts: nowIso(), ...item }, op);
      save();
    },
    /**
     * Transcript view: a subagent (an `Agent` call, id `id`) and the items it
     * produced so far, nested under it by `parentId` — as `agent_stream`
     * emits them. `steps` / `latest` follow its tool calls unless given.
     * Once it's no longer running it has a `finishedAt` (now, unless
     * given); `tokens` only when given. Call again with more `items` to
     * stream its progress.
     */
    subagent(
      taskId: string,
      call: { id: string; description: string; type?: string; status?: string; output?: string; steps?: number; latest?: string; tokens?: number; finishedAt?: string },
      items: Array<Record<string, unknown>> = [],
    ) {
      if (!findWs(taskId)) throw new Error(`no task ${taskId}`);
      const tools = items.filter((i) => i.kind === "tool");
      const last = tools[tools.length - 1] as { title?: string } | undefined;
      const known = (db.transcripts[taskId] ?? []).find((x: any) => x.id === call.id);
      const status = call.status ?? "running";
      const finishedAt = status === "running" ? undefined : (call.finishedAt ?? known?.subagent?.finishedAt ?? nowIso());
      transcriptPut(taskId, {
        kind: "tool",
        id: call.id,
        ts: known?.ts ?? nowIso(),
        tool: "Agent",
        input: { description: call.description, subagent_type: call.type ?? "general-purpose", prompt: call.description },
        title: `Running a subagent: ${call.description}`,
        status,
        ...(call.output ? { output: call.output } : {}),
        subagent: {
          type: call.type ?? "general-purpose",
          description: call.description,
          steps: call.steps ?? tools.length,
          ...((call.latest ?? last?.title) ? { latest: call.latest ?? last?.title } : {}),
          ...(call.tokens !== undefined ? { tokens: call.tokens } : {}),
          ...(finishedAt ? { finishedAt } : {}),
        },
      });
      for (const item of items) transcriptPut(taskId, { ts: nowIso(), ...item, parentId: call.id });
      save();
    },
    /**
     * Transcript view: a Bash call the agent ran with `run_in_background`
     * (id `id`); `status` is the command's own ("running" until it ends).
     */
    backgroundShell(
      taskId: string,
      shell: { id: string; command: string; status?: string; output?: string; parentId?: string; startedAt?: string },
    ) {
      if (!findWs(taskId)) throw new Error(`no task ${taskId}`);
      const known = (db.transcripts[taskId] ?? []).find((x: any) => x.id === shell.id);
      transcriptPut(taskId, {
        kind: "tool",
        id: shell.id,
        ts: shell.startedAt ?? known?.ts ?? nowIso(),
        tool: "Bash",
        input: { command: shell.command, run_in_background: true },
        title: `Running ${shell.command}`,
        status: "done",
        background: true,
        backgroundStatus: shell.status ?? "running",
        ...(shell.output !== undefined ? { output: shell.output } : {}),
        ...(shell.parentId ? { parentId: shell.parentId } : {}),
      });
      save();
    },
    /** A turn starts (agent state `working`); views can't switch until it ends. */
    turnStarts(taskId: string) {
      const w = findWs(taskId);
      if (!w) throw new Error(`no task ${taskId}`);
      turnStarts(w);
      save();
    },
    /** The turn ends (agent state `idle`), optionally with its result line. */
    /**
     * The turn's reply suggestions are ready (`turnId` = its result item's
     * id): a `suggest_replies` waiting on them resolves, later ones answer
     * them, and `phasr://suggestions` fires.
     */
    suggestionsReady(taskId: string, turnId: string, suggestions: any[]) {
      if (!findWs(taskId)) throw new Error(`no task ${taskId}`);
      db.suggestions[taskId] = suggestions;
      for (const resolve of suggestWaiters.splice(0)) resolve(clone(suggestions));
      later(() => fire("phasr://suggestions", { taskId, turnId, suggestions }));
      save();
    },
    turnEnds(taskId: string, result: Record<string, unknown> | null = null) {
      const w = findWs(taskId);
      if (!w) throw new Error(`no task ${taskId}`);
      if (result) transcriptPut(taskId, { kind: "result", id: transcriptId("result"), ts: nowIso(), durationMs: 0, costUsd: null, isError: false, ...result });
      turnEnds(w);
      save();
    },
  };

  const RESP = (cmd: string, a: any): unknown => {
    switch (cmd) {
      case "consume_pending_auth_callback": return null;
      case "set_session": return f.session.userId;
      case "start_cloud_sync":
      case "stop_cloud_sync":
      case "clear_session": return null;
      case "list_repositories": return f.repositories;
      case "get_repository": return f.repositories.find((r) => r.id === a?.id) ?? null;
      case "list_workspaces": return f.workspaces.filter((w) => w.repositoryId === a?.repositoryId);
      case "list_task_activity": return f.taskActivity;
      case "get_workspace": {
        const w = f.workspaces.find((x) => x.id === a?.id);
        return w ?? { __reject: "not found" };
      }
      case "list_agents": return f.agents;
      case "get_user_settings": return f.userSettings;
      // Echo the payload — the real command returns the updated row, and
      // the settings UI renders the mutation's response.
      case "update_user_settings": return a?.settings ?? f.userSettings;
      case "list_run_commands": return f.runCommands.filter((r) => r.repositoryId === a?.repositoryId);
      case "create_run_command":
      case "update_run_command": return { ...f.runCommands[0], ...a, id: a?.id ?? "rc-new" };
      case "delete_run_command": return null;
      case "list_notes_for_repository": return f.notes.filter((n) => n.repositoryId === a?.repositoryId);
      case "create_note": return {
        id: "note-new",
        repositoryId: a?.input?.repositoryId,
        body: (a?.input?.body ?? "").trim(),
        originKind: a?.input?.originKind ?? "repository",
        originWorkspaceId: a?.input?.originWorkspaceId ?? null,
        originWorkspaceName: null,
        originTerminalId: a?.input?.originTerminalId ?? null,
        originLabel: a?.input?.originLabelHint ?? "Repository home",
        createdAt: f.now,
        updatedAt: f.now,
      };
      case "update_note": return { ...f.notes.find((n) => n.id === a?.id), ...(a?.input?.body ? { body: a.input.body } : {}), updatedAt: f.now };
      case "set_note_done": {
        // Stateful on purpose: the panel refetches after the mutation,
        // and a stateless mock would silently revert the toggle.
        const n = f.notes.find((x) => x.id === a?.id);
        if (n) n.doneAt = a?.done ? new Date().toISOString() : null;
        return n;
      }
      case "delete_note": return null;
      case "git_status": return f.gitStatus;
      case "git_branch_status": return f.branchStatus;
      case "git_merge_in_progress": return { kind: "none" };
      case "git_diff": return f.sampleDiff;
      case "git_log": return f.commits;
      case "git_commit_files": return [{ path: "src/app.ts", oldPath: null, status: "modified" }];
      case "git_commit_diff": return f.sampleDiff;
      case "watch_workspace":
      case "unwatch_workspace": return null;
      case "git_stage":
      case "git_unstage":
      case "git_discard":
      case "git_resolve_conflict":
      case "git_continue_merge":
      case "git_abort_merge":
      case "git_fetch": return null;
      case "git_commit": return { sha: "c".repeat(40), message: a?.message ?? "commit" };
      case "git_push": return { branch: f.branchStatus.branch, pullRequestUrl: "https://github.com/acme/phasr/compare/main...phasr/add-feature", provider: "github" };
      case "git_merge_to_main":
      case "git_sync_with_main": return { kind: "clean", message: "Merged cleanly" };
      case "open_pull_request": return { url: "https://github.com/acme/phasr/pull/1", provider: "github", headBranch: "phasr/add-feature", baseBranch: "main" };
      case "check_workspace_delete": return { hasUnpushedCommits: false };
      case "archive_workspace":
      case "delete_workspace":
      case "delete_repository": return null;
      case "update_workspace": {
        // Real backend returns the updated Workspace row; the rename hook's
        // onSuccess reads workspace.repositoryId, so null would throw.
        const w = f.workspaces.find((x) => x.id === a?.id) ?? f.workspaces[0];
        return { ...w, ...(a?.name ? { name: a.name } : {}) };
      }
      case "create_workspace":
        return { ...f.workspaces[0], id: "ws-created", name: a?.name ?? "new-ws", status: "stopped" };
      case "start_task":
        return { taskId: "task-new", workspace: { ...f.workspaces[0], id: "ws-created", status: "running" } };
      case "open_task_terminal": return { taskId: a?.taskId ?? "ws-agent", startedAt: f.now };
      case "read_task_log": return "$ agent finished\r\nAll done.\r\n";
      // A UNIQUE id per shell, like the real backend. It used to hand every
      // session terminal the same "session-1", which made "did this
      // keystroke reach THIS terminal's PTY?" unanswerable — every
      // terminal's input landed on the same id.
      case "start_session_terminal": return a?.sessionId ?? `session-${++sessionSeq}`;
      case "attach_session_terminal": return null;
      case "send_input_to_task":
      case "send_session_input":
      case "send_run_command_input":
      case "resize_task":
      case "resize_session":
      case "resize_run_command":
      case "stop_session_terminal":
      case "stop_run_command":
      case "start_run_command": return null;
      // Like the backend: attach only succeeds for a live command; a tab
      // mount then starts it only on an explicit Run.
      case "attach_run_command": return { __reject: "not running" };
      // Synced settings not yet trusted here: `{ key, value }[]`; confirm
      // takes the exact keys and answers with the ones it confirmed.
      case "list_unconfirmed_settings": return [];
      case "confirm_settings_on_this_machine": return Array.isArray(a?.keys) ? a.keys : [];
      case "list_launchers": return [
        { id: "vscode", name: "VS Code", kind: "editor", available: true },
        { id: "terminal", name: "Terminal", kind: "terminal", available: true },
      ];
      case "launch_app": return null;
      case "list_repo_files": return ["src/app.ts", "src/new.ts", "README.md"];
      case "list_local_branches": return ["main", "dev"];
      case "validate_workspace_path":
        return { path: a?.path ?? "/x", absolutePath: a?.path ?? "/x", exists: true, isDir: true, isGitRepo: true, message: null };
      case "create_repository": return { ...f.repositories[0], id: "repo-new", name: a?.name ?? "new-repo" };
      case "git_init_repository":
      case "git_init_empty_repository":
      case "git_clone_repository":
      case "git_init_from_template": return { ...f.repositories[0], id: "repo-new" };
      case "register_notification_route":
      case "activate_notification": return null;
      // Per-task check summaries (`fixtures.checkRuns[workspaceId]`); none by default.
      case "list_check_runs": return (f as any).checkRuns?.[a?.workspaceId] ?? null;
      default: return null;
    }
  };

  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  (window as any).__E2E__ = {
    calls,
    names: () => calls.map((c) => c.cmd),
    emit: (event: string, payload: unknown) =>
      (listeners[event] ?? []).forEach((h) => h({ event, id: 1, payload })),
    pty: (key: string, msg: unknown) => channels[key]?.onmessage?.(msg),
    channelKeys: () => Object.keys(channels),
    setResponse: (cmd: string, val: unknown) => { overrides[cmd] = val; },
    clearResponse: (cmd: string) => { delete overrides[cmd]; },
    clearCalls: () => { calls.length = 0; },
    // Stateful backend only: the outside world (agents, GitHub).
    world,
  };

  (window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: (cb: unknown) => cb,
    convertFileSrc: (s: string) => s,
    unregisterCallback: () => {},
    invoke: (cmd: string, args: any) => {
      if (cmd === "plugin:event|listen") {
        (listeners[args.event] ??= []).push(args.handler);
        if (!stateful) return Promise.resolve(listeners[args.event].length);
        // Stateful: real ids, so an unmounted listener really goes away
        // (otherwise every remount adds a handler that keeps firing).
        const eventId = ++listenerSeq;
        listenerIds.set(eventId, args.handler);
        return Promise.resolve(eventId);
      }
      if (cmd === "plugin:event|unlisten") {
        if (stateful) {
          const h = listenerIds.get(args?.eventId);
          if (h) {
            listenerIds.delete(args.eventId);
            const list = listeners[args.event] ?? [];
            const i = list.indexOf(h);
            if (i !== -1) list.splice(i, 1);
          }
        }
        return Promise.resolve();
      }
      if (cmd.startsWith("plugin:")) {
        // A spec can stand in for a native plugin (e.g. the folder picker,
        // `plugin:dialog|open`) via setResponse/overrides.
        if (cmd in overrides) {
          calls.push({ cmd, args });
          return Promise.resolve(overrides[cmd]);
        }
        // opener/dialog/notification/etc — benign, resolve falsy
        if (cmd.includes("is_permission_granted")) return Promise.resolve("granted");
        return Promise.resolve(null);
      }
      const chKey = args?.taskId ?? args?.id ?? args?.sessionId;
      if (args?.onEvent && chKey != null) channels[chKey] = args.onEvent;
      const clean = args ? { ...args } : args;
      if (clean && "onEvent" in clean) clean.onEvent = "<Channel>";
      calls.push({ cmd, args: clean });
      // A generation in flight: answers when `world.suggestionsReady` runs.
      if (stateful && cmd === "suggest_replies" && !(cmd in overrides) && !db.suggestions[args?.taskId] && (f as any).holdSuggestions)
        return new Promise((resolve) => suggestWaiters.push(resolve));
      let val: unknown = NOT_HANDLED;
      if (cmd in overrides) val = overrides[cmd];
      else if (stateful) {
        val = STATE(cmd, args);
        // Over real IPC every answer is a fresh copy. Handing out the
        // store's own objects would let an in-place mutation make the old
        // and new query data deep-equal, and React Query would keep the
        // stale render.
        if (val !== NOT_HANDLED) {
          save();
          if (val !== null && val !== undefined) val = clone(val);
        }
      }
      if (val === NOT_HANDLED) val = RESP(cmd, args);
      // `start_session_terminal` carries no id IN — the id is what it
      // returns — so its channel can only be keyed after the fact.
      if (cmd === "start_session_terminal" && typeof val === "string" && args?.onEvent)
        channels[val] = args.onEvent;
      if (val && typeof val === "object" && "__reject" in (val as any))
        return Promise.reject((val as any).__reject);
      return Promise.resolve(val === undefined ? null : val);
    },
  };
}

/**
 * There is one emulator (ADR-002 — the previous engine was removed after
 * ghostty-web had been used in anger). `expectBackend` survives that because a
 * terminal that fails to construct leaves the mount empty rather than
 * throwing, and every terminal spec below is meaningless if that happens.
 */

export async function bootApp(page: Page, fixtures = makeFixtures()) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // A resource 404 names its URL only in the location (e.g. the dev
    // server's missing /favicon.ico) — carry it so BENIGN filters can see it.
    const text = m.text();
    errors.push(text.startsWith("Failed to load resource") ? `${text} [${m.location().url}]` : text);
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.addInitScript(installMock, fixtures);
  await page.goto("/");
  return { errors };
}

/**
 * Wait until a real emulator has been built into the visible mount. The
 * attribute is only set once the surface exists, so this doubles as "the
 * terminal is ready" for every spec that then writes to it.
 */
export async function expectBackend(page: Page, backend = "ghostty") {
  await expect(terminal(page)).toHaveAttribute("data-terminal-kind", backend, {
    timeout: 20_000,
  });
}

export const calls = (page: Page) =>
  page.evaluate(() => (window as any).__E2E__.calls as Array<{ cmd: string; args: any }>);
export const callNames = (page: Page) =>
  page.evaluate(() => (window as any).__E2E__.names() as string[]);
export const clearCalls = (page: Page) =>
  page.evaluate(() => (window as any).__E2E__.clearCalls());
export const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as any).__E2E__.emit(e, p), [event, payload] as const);
export const pty = (page: Page, key: string, msg: unknown) =>
  page.evaluate(([k, m]) => (window as any).__E2E__.pty(k, m), [key, msg] as const);

/**
 * Emit PTY output. **Use this instead of hand-building `{type:"output"}`** —
 * the wire encoding of `chunk` is a backend detail, and every spec that
 * spelled it out inline had to be edited by hand when it changed. This is
 * the single place that knows.
 */
export const ptyOut = (page: Page, key: string, text: string) =>
  pty(page, key, { type: "output", chunk: encodeChunk(text) });

/** Feed many chunks inside ONE round trip — for throughput probes, where
 *  per-`evaluate` overhead would otherwise swamp what is being measured. */
export const ptyBurst = (page: Page, key: string, texts: string[]) =>
  page.evaluate(
    ([k, chunks]) => {
      for (const chunk of chunks as string[]) {
        (window as any).__E2E__.pty(k, { type: "output", chunk });
      }
    },
    [key, texts.map(encodeChunk)] as const,
  );

/** `PtyEvent.output.chunk` is base64 of the PTY's raw bytes — see
 *  `src/lib/ptyChunk.ts`. Specs pass plain text and this encodes it. */
function encodeChunk(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}
export const setResponse = (page: Page, cmd: string, val: unknown) =>
  page.evaluate(([c, v]) => (window as any).__E2E__.setResponse(c, v), [cmd, val] as const);
/** Undo a `setResponse`: the command answers from the fixtures / store again. */
export const clearResponse = (page: Page, cmd: string) =>
  page.evaluate((c) => (window as any).__E2E__.clearResponse(c), cmd);

/**
 * The outside world, for the stateful backend (`fixtures.stateful`): what
 * an agent or GitHub does, which no click can stand in for. Each changes
 * the store and emits the events the real backend would.
 */
export const world = {
  /** The agent stops on an approval dialog. Resolves to the attention id. */
  agentAsks: (page: Page, taskId: string, attention: Record<string, unknown> = {}) =>
    page.evaluate(
      ([id, att]) => (window as any).__E2E__.world.agentAsks(id, att) as string,
      [taskId, attention] as const,
    ),
  /** The agent is working again (e.g. after an answer typed in its terminal). */
  agentWorking: (page: Page, taskId: string, activity: string | null = null) =>
    page.evaluate(([id, act]) => (window as any).__E2E__.world.agentWorking(id, act), [taskId, activity] as const),
  /** The task's PR was merged on GitHub; the next `refresh_pr_states` sees it. */
  prMergedOnRemote: (page: Page, taskId: string) =>
    page.evaluate((id) => (window as any).__E2E__.world.prMergedOnRemote(id), taskId),
  /**
   * Transcript view: the agent's stream produces `item` (a §4
   * `TranscriptItem`; `ts` defaults to now). A new id appends, a known id
   * updates — or force `op`. Emits `phasr://transcript`.
   */
  transcript: (page: Page, taskId: string, item: Record<string, unknown>, op?: "append" | "update") =>
    page.evaluate(
      ([id, it, o]) => (window as any).__E2E__.world.transcript(id, it, o ?? undefined),
      [taskId, item, op ?? null] as const,
    ),
  /**
   * Transcript view: a subagent call and its items so far (nested under it
   * by `parentId`). Repeat with more items to stream its progress.
   */
  subagent: (
    page: Page,
    taskId: string,
    call: { id: string; description: string; type?: string; status?: string; output?: string; steps?: number; latest?: string; tokens?: number; finishedAt?: string },
    items: Array<Record<string, unknown>> = [],
  ) =>
    page.evaluate(
      ([id, c, its]) => (window as any).__E2E__.world.subagent(id, c, its),
      [taskId, call, items] as const,
    ),
  /** Transcript view: a background Bash command (`status` = its own; "running" by default). */
  backgroundShell: (
    page: Page,
    taskId: string,
    shell: { id: string; command: string; status?: string; output?: string; parentId?: string; startedAt?: string },
  ) => page.evaluate(([id, s]) => (window as any).__E2E__.world.backgroundShell(id, s), [taskId, shell] as const),
  /** A turn starts: agent state `working` (Stop shows, sends queue). */
  turnStarts: (page: Page, taskId: string) =>
    page.evaluate((id) => (window as any).__E2E__.world.turnStarts(id), taskId),
  /** A turn's reply suggestions are ready: held `suggest_replies` calls resolve, `phasr://suggestions` fires. */
  suggestionsReady: (page: Page, taskId: string, turnId: string, suggestions: Array<{ label: string; text: string; source: string }>) =>
    page.evaluate(([id, t, s]) => (window as any).__E2E__.world.suggestionsReady(id, t, s), [taskId, turnId, suggestions] as const),
  /** The turn ends (`idle`), optionally appending its result line. */
  turnEnds: (page: Page, taskId: string, result: Record<string, unknown> | null = null) =>
    page.evaluate(([id, r]) => (window as any).__E2E__.world.turnEnds(id, r), [taskId, result] as const),
};

/** Wait until an invoke with the given command name has been recorded. */
export async function waitForCall(page: Page, cmd: string, timeout = 5000) {
  await expect
    .poll(async () => (await callNames(page)).includes(cmd), { timeout })
    .toBe(true);
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

/**
 * The one visible terminal. Specs used to reach for the emulator's own class
 * names, which pinned them to its markup; `data-testid` is set by all three terminal
 * components and survives a backend swap. `visible: true` matters because
 * the workspace mounts EVERY inner tab and hides the inactive ones with
 * `display: none` — `.first()` alone can resolve to a hidden one.
 */
export const terminal = (page: Page) =>
  page.getByTestId("terminal-surface").filter({ visible: true }).first();

/**
 * Mirror of `src/lib/terminal/bridge.ts`'s DEV-only global. Declared here
 * rather than imported because `tsconfig.json` only includes `src`, so this
 * directory is transpiled but never typechecked against it.
 */
interface TerminalBridge {
  ids(): string[];
  grid(id: string): { rows: number; cols: number } | null;
  cellRect(
    id: string,
    col: number,
    row: number,
  ): { x: number; y: number; width: number; height: number } | null;
  lineText(id: string, row: number): string | null;
  backend(id: string): string | null;
}

const BRIDGE = "__PHASR_TERM__";

/**
 * Locate a cell's click point by the text on its line, via the DEV-only
 * `window.__PHASR_TERM__` bridge. Replaces dividing a bounding box by
 * hardcoded grid dimensions, which was wrong at any other viewport size and
 * failed silently when it was.
 *
 * `row` is viewport-relative for the rect and buffer-absolute for the text
 * (mirroring `TerminalSurface`); they coincide until something scrolls off,
 * and `expectLine` makes a mismatch fail loudly instead of silently
 * clicking the wrong character.
 */
export async function cellPoint(
  page: Page,
  col: number,
  row: number,
  expectLine: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([bridgeKey, col, row, expectLine]) => {
      const bridge = (window as any)[bridgeKey as string] as
        | TerminalBridge
        | undefined;
      if (!bridge) throw new Error(`${bridgeKey} missing (not a DEV build?)`);
      for (const id of bridge.ids()) {
        const line = bridge.lineText(id, row as number);
        if (!line?.includes(expectLine as string)) continue;
        const r = bridge.cellRect(id, col as number, row as number);
        if (!r) throw new Error(`no cell ${col},${row} on ${id}`);
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      const seen = bridge
        .ids()
        .map(
          (id) => `${id}: ${JSON.stringify(bridge.lineText(id, row as number))}`,
        )
        .join(" | ");
      throw new Error(
        `no terminal has ${JSON.stringify(expectLine)} on row ${row}. Saw: ${seen}`,
      );
    },
    [BRIDGE, col, row, expectLine] as const,
  );
}

/** Grid of the first live surface — `null` if the bridge sees no terminal. */
export const terminalGrid = (page: Page) =>
  page.evaluate((bridgeKey) => {
    const bridge = (window as any)[bridgeKey] as TerminalBridge | undefined;
    const id = bridge?.ids()[0];
    return id ? bridge!.grid(id) : null;
  }, BRIDGE);

/**
 * One ~32 KiB burst of agent-TUI repaint traffic: absolute cursor moves, SGR
 * colour runs, clear-to-EOL, box drawing and a spinner - i.e. dense in bytes
 * that JSON has to escape and that a byte-native emulator would rather have
 * raw. Deterministic in `seed` so before/after runs feed identical bytes.
 *
 * Calibrated against 49 MB of real phasr PTY logs: agent TUI streams cost
 * 1.355-1.461x their raw size once serde_json has escaped them (base64 is a
 * flat 1.333x). This frame lands at 1.423x, i.e. inside that band rather
 * than at the flattering end of it.
 */
export function tuiFrame(seed: number): string {
  const spin = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827";
  const out: string[] = [];
  for (let row = 1; row <= 220; row++) {
    const n = (seed * 220 + row) % 1000;
    out.push(
      `\x1b[${(row % 40) + 1};1H` +
        `\x1b[2K` +
        `\x1b[38;5;${n % 256}m\u2502\x1b[0m ` +
        `${spin[n % spin.length]} ` +
        `\x1b[1mfile ${n}\x1b[22m ` +
        `\x1b[7m ${n % 100}% \x1b[27m ` +
        `\x1b[38;5;244m src/lib/module_${n}.ts\x1b[39m ` +
        `\x1b[38;5;${(n * 7) % 256}m\u2500\u2500\x1b[0m ` +
        `${"tokens ".repeat(3)}${n}\x1b[K`,
    );
  }
  return out.join("");
}
