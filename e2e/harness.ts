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
    shippedAt: null,
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
    // A persisted decomposition on repo-1: the epic `parent` + its two
    // `subtask` rows. The board (`get_board`/`makeBoard`) keys its subtask ids
    // as `${parentId}-backend`/`${parentId}-frontend`, so these ids match — the
    // sidebar epic node, its rollup, and the board stay consistent. `backend`
    // is running with a worktree (drill-in → the real detail view); `frontend`
    // is pending with no worktree (drill-in → the honest "waiting" pane).
    {
      ...wsBase,
      id: "epic-1",
      repositoryId: "repo-1",
      workspaceKind: "parent",
      name: "task-comments",
      prompt: "Add a task-comments API and wire the comments UI",
      agent: null,
      status: "pending",
      branch: null,
      worktreePath: null,
      interruptedAt: null,
      parentId: null,
      role: null,
    },
    {
      ...wsBase,
      id: "epic-1-backend",
      repositoryId: "repo-1",
      workspaceKind: "subtask",
      name: "comments API",
      agent: "claude",
      status: "running",
      branch: "phasr/epic-1-backend",
      worktreePath: "/Users/test/.phasr/worktrees/epic-1-backend",
      interruptedAt: null,
      parentId: "epic-1",
      role: "backend",
    },
    {
      ...wsBase,
      id: "epic-1-frontend",
      repositoryId: "repo-1",
      workspaceKind: "subtask",
      name: "comments UI",
      agent: "claude",
      status: "pending",
      branch: null,
      worktreePath: null,
      interruptedAt: null,
      parentId: "epic-1",
      role: "frontend",
    },
    // An INTERRUPTED subtask (relaunch-recovery orphan): startup recovery swept
    // it from `running` → `stopped` and stamped `interruptedAt`, so the FE
    // derives `status:"stopped" && interruptedAt != null` → interrupted. Opening
    // it must REPLAY its pre-interruption log (`read_task_log`) behind an
    // explicit "Resume" banner and must NEVER auto re-spawn the agent
    // (`open_task_terminal`). Has a worktree so it opens the REAL detail view
    // (not the "waiting" pane). Its log text comes from the shared
    // `read_task_log` mock below. Lives under epic-1 so the sidebar epic-node
    // count is unchanged (subtasks nest under the parent, never the flat list).
    {
      ...wsBase,
      id: "epic-1-interrupted",
      repositoryId: "repo-1",
      workspaceKind: "subtask",
      name: "interrupted agent",
      agent: "claude",
      status: "stopped",
      branch: "phasr/epic-1-interrupted",
      worktreePath: "/Users/test/.phasr/worktrees/epic-1-interrupted",
      interruptedAt: NOW,
      parentId: "epic-1",
      role: "docs",
    },
    // CONTROL: identical to the interrupted subtask above EXCEPT `interruptedAt`
    // is null — a calm user-stopped subtask. It must keep the unchanged
    // click-to-resume behavior: `open_task_terminal` on open, no log replay, no
    // Resume banner. Differing only in `interruptedAt` makes it a tight control
    // proving that field is the sole pivot for the interrupted-open path.
    {
      ...wsBase,
      id: "epic-1-control",
      repositoryId: "repo-1",
      workspaceKind: "subtask",
      name: "stopped agent",
      agent: "claude",
      status: "stopped",
      branch: "phasr/epic-1-control",
      worktreePath: "/Users/test/.phasr/worktrees/epic-1-control",
      interruptedAt: null,
      parentId: "epic-1",
      role: "qa",
    },
  ];
  // ── Worklist / Home (Phase 2 §C.3) ───────────────────────────────────────
  // A cross-repo attention snapshot exercising ALL FOUR buckets exactly as the
  // mockup Page 01 shows (Needs you 2 · Running 2 · Waiting 1 · Recent 2). A
  // dedicated epic board (repo-1) plus two loose agents. The FE derives every
  // bucket from these raw rows — the mock computes NO state (spec §A4).
  const sub = (over: Record<string, unknown>) => ({
    ...wsBase,
    repositoryId: "repo-1",
    workspaceKind: "subtask",
    agent: "claude",
    status: "pending",
    branch: null,
    worktreePath: null,
    interruptedAt: null,
    parentId: "epic-w",
    role: null,
    name: (over.name as string) ?? (over.id as string),
    ...over,
  });
  const worklist = {
    repositories: repositories.map((r) => ({ id: r.id, name: r.name })),
    boards: [
      {
        parent: sub({
          id: "epic-w",
          workspaceKind: "parent",
          name: "checkout",
          prompt: "Add task-comments to checkout: API, web UI, docs, QA",
          agent: null,
          parentId: null,
          role: null,
          status: "pending",
          startedAt: null,
        }),
        subtasks: [
          // running (no liveness, old startedAt) → working → Running
          sub({
            id: "w-backend",
            role: "backend",
            name: "task-comments-api",
            status: "running",
            startedAt: NOW,
            branch: "phasr/comments-api",
          }),
          // pending consumer of an unpublished producer → blocked → Waiting
          sub({
            id: "w-frontend",
            role: "frontend",
            name: "web-integration",
            status: "pending",
            startedAt: null,
            branch: "phasr/web-integration",
          }),
          // failed → Needs you
          sub({
            id: "w-failed",
            role: "backend",
            name: "login-api",
            agent: "codex",
            status: "failed",
            exitCode: 1,
            startedAt: NOW,
            finishedAt: NOW,
            branch: "phasr/login-api",
          }),
          // published contract → needs-review → Needs you
          sub({
            id: "w-review",
            role: "frontend",
            name: "web-ui",
            status: "running",
            startedAt: NOW,
            branch: "phasr/web-ui",
          }),
        ],
        dependencies: [
          {
            id: "edge-w",
            parentId: "epic-w",
            fromSubtaskId: "w-backend",
            toSubtaskId: "w-frontend",
            createdAt: NOW,
          },
        ],
        contracts: [
          {
            id: "contract-w-review",
            parentId: "epic-w",
            subtaskId: "w-review",
            role: "frontend",
            contractPath: "/contracts/w-review.json",
            publishedAt: NOW,
            createdAt: NOW,
          },
        ],
      },
    ],
    // Standalone single-agent work (not part of any decomposition). Only LOOSE
    // agents reach the Recent bucket (`done`/`stopped`) — a clean-exit subtask
    // becomes `needs-review` (Needs you) instead.
    looseAgents: [
      // ws-agent (running → Running)
      workspaces.find((w) => w.id === "ws-agent"),
      // a calm user-stopped standalone spike → stopped → Recent
      {
        ...wsBase,
        id: "loose-spike",
        repositoryId: "repo-2",
        workspaceKind: "agent",
        name: "spike-rate-limit",
        agent: "opencode",
        status: "stopped",
        branch: "phasr/spike-rate-limit",
        worktreePath: null,
        interruptedAt: null,
        parentId: null,
        role: null,
        startedAt: NOW,
        finishedAt: NOW,
      },
      // ws-done (completed clean → done → Recent, "merged into main")
      workspaces.find((w) => w.id === "ws-done"),
    ],
  };
  // ── Ticket brief (Phase 2 §C.1 — the Brief tab) ──────────────────────────
  // A canned brief for any subtask ticket. `read_ticket_brief` returns it keyed
  // to the requested id; `write_ticket_section` echoes a `saved` result with a
  // bumped mtime (the FE adopts it). The PRD deliberately carries a raw-HTML +
  // `javascript:` injection so the markdown-sanitization test can prove neither
  // executes (react-markdown ignores raw HTML; rehype-sanitize drops the proto).
  const nowMs = Date.parse(NOW);
  const section = (content: string, mtimeMs: number) => ({
    content,
    mtimeMs,
    lastEditedBy: "you" as const,
    lastEditedAtMs: nowMs - 1_200_000,
  });
  const ticketBrief = {
    ticketId: "epic-1-backend",
    title: "comments UI",
    description: section(
      "Add a comments panel to the checkout ticket view. Reads and writes " +
        "through the task-comments API and reuses the app's honest empty/error " +
        "states. Ships behind the `comments` flag.",
      1000,
    ),
    prd: section(
      "## Goal\n\nA collaborator can leave, read, and remove comments.\n\n" +
        "## Requirements\n\n- Optimistic add; roll back on failure.\n" +
        "- Empty state copy.\n\n" +
        // Injection payloads — MUST render inert (no raw HTML, no javascript:).
        '<img src=x onerror="window.__XSS__=1">\n\n' +
        "[danger](javascript:alert(1)) and a [safe link](https://example.com).",
      2000,
    ),
    trd: section(
      "## Data\n\n`GET/POST/DELETE /api/tickets/:id/comments`\n\n" +
        "## Component\n\nCommentsPanel — reuse GlassTextarea + PanelState.",
      3000,
    ),
    assets: [
      {
        id: "panel-mock.png",
        name: "panel-mock.png",
        storage: "in-repo" as const,
        path: "/Users/test/code/phasr/.phasr/tickets/epic-1-backend/assets/panel-mock.png",
        sizeBytes: 20480,
        kind: "image" as const,
        addedAtMs: nowMs,
      },
      {
        id: "spec-v2.pdf",
        name: "spec-v2.pdf",
        storage: "in-repo" as const,
        path: "/Users/test/code/phasr/.phasr/tickets/epic-1-backend/assets/spec-v2.pdf",
        sizeBytes: 51200,
        kind: "pdf" as const,
        addedAtMs: nowMs,
      },
    ],
    figma: [
      {
        id: "figma-1",
        url: "https://figma.com/file/checkout-comments",
        label: "Panel",
        addedBy: "you" as const,
        addedAtMs: nowMs,
      },
    ],
    commentCount: 2,
  };
  const ticketComments = [
    {
      id: "c-1",
      author: "Ronak",
      authorKind: "you" as const,
      role: null,
      body: "Match the login panel spacing — 12px gaps, not 8.",
      createdAtMs: nowMs - 1_200_000,
    },
    {
      id: "c-2",
      author: "claude",
      authorKind: "agent" as const,
      role: "frontend",
      body: "Adopted 12px gaps and wired ConfirmDialog on delete.",
      createdAtMs: nowMs - 360_000,
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
      runInValidate: false,
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
      // A Validate check (Phase 3) — so `checksConfigured` is true for repo-1.
      runInValidate: true,
      sortOrder: 1,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];
  const gitStatus = [
    {
      path: "src/app.ts",
      oldPath: null,
      staged: "other",
      unstaged: "modified",
      adds: 12,
      removes: 3,
    },
    {
      path: "src/new.ts",
      oldPath: null,
      staged: "added",
      unstaged: "other",
      adds: 40,
      removes: 0,
    },
    {
      path: "README.md",
      oldPath: null,
      staged: "other",
      unstaged: "modified",
      adds: 1,
      removes: 1,
    },
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
    // Returning-user restore: seed the last-open workspace so `/` restores it
    // (the muscle-memory path, open decision #5). A worklist test that wants the
    // new-user `/worklist` fallback sets `fixtures.lastWorkspace = null`.
    lastWorkspace: { repositoryId: "repo-1", workspaceId: "ws-agent" } as {
      repositoryId: string;
      workspaceId: string;
    } | null,
    repositories,
    workspaces,
    worklist,
    ticketBrief,
    ticketComments,
    agents,
    userSettings,
    runCommands,
    gitStatus,
    branchStatus,
    commits,
    sampleDiff,
  };
}

// Runs INSIDE the browser (serialized) — must be self-contained.
function installMock(cfg: ReturnType<typeof makeFixtures>) {
  const f = cfg;
  localStorage.setItem(
    "phasr.auth.desktopSession",
    JSON.stringify(f.session.desktopSession),
  );
  // Seed the last-open workspace so `/` restores it on boot (returning-user
  // path). Cleared to `null` by tests that exercise the `/worklist` fallback.
  if (f.lastWorkspace) {
    localStorage.setItem(
      "phasr.lastWorkspace",
      JSON.stringify(f.lastWorkspace),
    );
  }

  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const channels: Record<string, { onmessage?: (m: unknown) => void }> = {};
  const calls: Array<{ cmd: string; args: unknown }> = [];
  // Seed overrides at boot (e.g. make open_task_terminal reject from the very
  // first mount) via fixtures.overrides — set before any command fires.
  const overrides: Record<string, unknown> = {
    ...((f as any).overrides ?? {}),
  };

  // A minimal but valid multi-agent BoardState (parent + backend→frontend
  // subtasks + one edge) so the "New workflow" entry point renders end-to-end:
  // start_decomposition resolves with parent id "parent-new"; get_board returns
  // the same shape keyed on whatever parentId the board route requests, so the
  // navigation lands on a live board rather than an empty/error state.
  const boardWs = (over: Record<string, unknown>) => ({
    repositoryId: "repo-1",
    workspaceKind: "subtask",
    name: (over.id as string) ?? "subtask",
    prompt: null,
    agent: "claude",
    command: "claude",
    status: "pending",
    branch: null,
    worktreePath: null,
    exitCode: null,
    createdAt: f.now,
    startedAt: null,
    finishedAt: null,
    archivedAt: null,
    interruptedAt: null,
    parentId: null,
    role: null,
    updatedAt: f.now,
    ...over,
  });
  // ── Phase 3 gate state (mutable) ─────────────────────────────────────────
  // `review.json` / `validate.json` per subtask, mutated by the gate commands
  // so a subsequent get_board_gates reflects a live change (the FE invalidates
  // the gate side-load after each mutation). Keyed by subtask id; the parent id
  // is the subtask id minus its trailing role segment (makeBoard's convention).
  const reviewsBySubtask: Record<string, unknown> = {};
  const validationsBySubtask: Record<string, unknown> = {};
  const parentOf = (subtaskId: string) =>
    subtaskId.replace(/-(backend|frontend|docs|qa)$/, "");

  const makeBoard = (parentId: string) => ({
    parent: boardWs({
      id: parentId,
      workspaceKind: "parent",
      name: "task-comments",
      prompt: "Add a task-comments API and wire the comments UI",
      agent: null,
      parentId: null,
    }),
    subtasks: [
      boardWs({
        id: `${parentId}-backend`,
        parentId,
        role: "backend",
        name: "comments API",
        status: "running",
        startedAt: f.now,
      }),
      boardWs({
        id: `${parentId}-frontend`,
        parentId,
        role: "frontend",
        name: "comments UI",
        status: "pending",
      }),
    ],
    dependencies: [
      {
        id: `${parentId}-edge`,
        parentId,
        fromSubtaskId: `${parentId}-backend`,
        toSubtaskId: `${parentId}-frontend`,
        createdAt: f.now,
      },
    ],
    contracts: [],
  });

  const RESP = (cmd: string, a: any): unknown => {
    switch (cmd) {
      case "consume_pending_auth_callback":
        return null;
      case "set_session":
        return f.session.userId;
      case "start_cloud_sync":
      case "stop_cloud_sync":
      case "clear_session":
        return null;
      case "list_repositories":
        return f.repositories;
      case "get_repository":
        return f.repositories.find((r) => r.id === a?.id) ?? null;
      case "list_workspaces":
        return f.workspaces.filter((w) => w.repositoryId === a?.repositoryId);
      case "list_worklist":
        return f.worklist;
      // ── Phase 2 tickets / brief (§C.1) ─────────────────────────────────
      case "read_ticket_brief":
        return {
          ...f.ticketBrief,
          ticketId: a?.ticketId ?? f.ticketBrief.ticketId,
        };
      case "write_ticket_section":
        // Echo a `saved` result with a bumped mtime (the FE adopts it as the new
        // base). The conflict path is exercised by a test via `setResponse`.
        return {
          kind: "saved",
          section: {
            content: a?.content ?? "",
            mtimeMs: Date.parse(f.now) + 5000,
            lastEditedBy: "you",
            lastEditedAtMs: Date.parse(f.now),
          },
        };
      case "list_ticket_assets":
        return f.ticketBrief.assets;
      case "add_ticket_asset": {
        const name = String(a?.sourcePath ?? "dropped.png")
          .split(/[/\\]/)
          .pop();
        return {
          id: `asset-${name}`,
          name,
          storage: "in-repo",
          path: a?.sourcePath ?? "/tmp/dropped.png",
          sizeBytes: 2048,
          kind: /\.pdf$/i.test(name ?? "") ? "pdf" : "image",
          addedAtMs: Date.parse(f.now),
        };
      }
      case "remove_ticket_asset":
        return null;
      case "add_ticket_figma_link":
        return {
          id: "figma-new",
          url: a?.url ?? "https://figma.com/file/new",
          label: a?.label ?? null,
          addedBy: "you",
          addedAtMs: Date.parse(f.now),
        };
      case "remove_ticket_figma_link":
        return null;
      case "list_ticket_comments":
        return f.ticketComments;
      case "add_ticket_comment":
        return {
          id: "comment-new",
          author: "Ronak",
          authorKind: "you",
          role: null,
          body: a?.body ?? "",
          createdAtMs: Date.parse(f.now),
        };
      case "watch_ticket":
      case "unwatch_ticket":
        return null;
      case "get_workspace": {
        const w = f.workspaces.find((x) => x.id === a?.id);
        return w ?? { __reject: "not found" };
      }
      case "list_agents":
        return f.agents;
      case "get_user_settings":
        return f.userSettings;
      case "update_user_settings":
        return f.userSettings;
      case "list_run_commands":
        return f.runCommands.filter((r) => r.repositoryId === a?.repositoryId);
      case "create_run_command":
      case "update_run_command":
        return { ...f.runCommands[0], ...a, id: a?.id ?? "rc-new" };
      case "delete_run_command":
        return null;
      case "git_status":
        return f.gitStatus;
      case "git_branch_status":
        return f.branchStatus;
      case "git_merge_in_progress":
        return { kind: "none" };
      case "git_diff":
        return f.sampleDiff;
      case "git_log":
        return f.commits;
      case "git_commit_files":
        return [{ path: "src/app.ts", oldPath: null, status: "modified" }];
      case "git_commit_diff":
        return f.sampleDiff;
      case "watch_workspace":
      case "unwatch_workspace":
        return null;
      case "git_stage":
      case "git_unstage":
      case "git_discard":
      case "git_resolve_conflict":
      case "git_continue_merge":
      case "git_abort_merge":
      case "git_fetch":
        return null;
      case "git_commit":
        return { sha: "c".repeat(40), message: a?.message ?? "commit" };
      case "git_push":
        return {
          branch: f.branchStatus.branch,
          pullRequestUrl:
            "https://github.com/acme/phasr/compare/main...phasr/add-feature",
          provider: "github",
        };
      case "git_merge_to_main":
      case "git_sync_with_main":
        return { kind: "clean", message: "Merged cleanly" };
      case "ship_epic":
        return { kind: "clean", message: "Merged cleanly" };
      case "git_repo_merge_in_progress":
        return { kind: "none" };
      case "git_repo_abort_merge":
        return null;
      case "git_push_default_branch":
        return {
          branch: f.repositories[0]?.defaultBranch ?? "main",
          pullRequestUrl: null,
          provider: null,
        };
      case "open_pull_request":
        return {
          url: "https://github.com/acme/phasr/pull/1",
          provider: "github",
          headBranch: "phasr/add-feature",
          baseBranch: "main",
        };
      case "check_workspace_delete":
        return { hasUnpushedCommits: false };
      case "archive_workspace":
      case "delete_workspace":
      case "delete_repository":
        return null;
      case "update_workspace": {
        // Real backend returns the updated Workspace row; the rename hook's
        // onSuccess reads workspace.repositoryId, so null would throw.
        const w = f.workspaces.find((x) => x.id === a?.id) ?? f.workspaces[0];
        return { ...w, ...(a?.name ? { name: a.name } : {}) };
      }
      case "create_workspace":
        return {
          ...f.workspaces[0],
          id: "ws-created",
          name: a?.name ?? "new-ws",
          status: "stopped",
        };
      case "start_task":
        return {
          taskId: "task-new",
          workspace: {
            ...f.workspaces[0],
            id: "ws-created",
            status: "running",
          },
        };
      case "plan_decomposition":
        // The Planner drafting step (§C): return a canned ProposedPlan the
        // review surface hydrates into editable tickets + a DAG. Persists
        // nothing — the single write is still start_decomposition below.
        return {
          subtasks: [
            {
              role: "backend",
              agent: "claude",
              prompt:
                "Build the task-comments REST endpoints (list, create, delete) with tests. Publish the response schema as the handoff contract.",
            },
            {
              role: "frontend",
              agent: "claude",
              prompt:
                "Wire the comments panel to the API using the published contract. Optimistic add, empty + error states.",
            },
            {
              role: "docs",
              agent: "gemini",
              prompt:
                "Document the comments API in the reference + a short how-to.",
            },
            {
              role: "qa",
              agent: "codex",
              prompt: "Write e2e coverage for the comments flow.",
            },
          ],
          edges: [
            { fromRole: "backend", toRole: "frontend" },
            { fromRole: "backend", toRole: "docs" },
            { fromRole: "frontend", toRole: "qa" },
          ],
        };
      case "start_decomposition":
        return makeBoard("parent-new");
      case "get_board":
        return makeBoard(a?.parentId ?? "parent-new");
      // ── Phase 3 gates (Validate + Review/QAS) ──────────────────────────
      case "validate_ticket": {
        const result = {
          subtaskId: a?.subtaskId,
          checks: [
            {
              name: "test",
              command: "pnpm test",
              passed: true,
              exitCode: 0,
              tailOutput: "ok",
            },
          ],
          passed: true,
          ranAtMs: Date.parse(f.now),
        };
        validationsBySubtask[a?.subtaskId] = result;
        return result;
      }
      case "get_validate_result":
        return validationsBySubtask[a?.subtaskId] ?? null;
      case "request_review": {
        reviewsBySubtask[a?.subtaskId] = {
          subtaskId: a?.subtaskId,
          state: "requested",
          by: "you",
          comment: null,
          atMs: Date.parse(f.now),
          validatePassed: true,
        };
        return makeBoard(parentOf(a?.subtaskId ?? "parent-new"));
      }
      case "resolve_review": {
        reviewsBySubtask[a?.subtaskId] = {
          subtaskId: a?.subtaskId,
          state: a?.decision === "approve" ? "approved" : "changes-requested",
          by: "you",
          comment: a?.comment ?? null,
          atMs: Date.parse(f.now),
          validatePassed: true,
        };
        return makeBoard(parentOf(a?.subtaskId ?? "parent-new"));
      }
      case "get_review":
        return reviewsBySubtask[a?.subtaskId] ?? null;
      case "get_board_gates": {
        const pid = a?.parentId ?? "parent-new";
        const belongs = (id: string) => id.startsWith(pid);
        return {
          reviews: Object.entries(reviewsBySubtask)
            .filter(([id]) => belongs(id))
            .map(([, v]) => v),
          validations: Object.entries(validationsBySubtask)
            .filter(([id]) => belongs(id))
            .map(([, v]) => v),
        };
      }
      case "open_task_terminal":
        return { taskId: a?.taskId ?? "ws-agent", startedAt: f.now };
      case "read_task_log":
        return "$ agent finished\r\nAll done.\r\n";
      case "start_session_terminal":
        return a?.sessionId ?? "session-1";
      case "attach_session_terminal":
        return null;
      case "send_input_to_task":
      case "send_session_input":
      case "send_run_command_input":
      case "resize_task":
      case "resize_session":
      case "resize_run_command":
      case "stop_session_terminal":
      case "stop_run_command":
      case "start_run_command":
        return null;
      case "list_launchers":
        return [
          { id: "vscode", name: "VS Code", kind: "editor", available: true },
          {
            id: "terminal",
            name: "Terminal",
            kind: "terminal",
            available: true,
          },
        ];
      case "launch_app":
        return null;
      case "list_repo_files":
        return ["src/app.ts", "src/new.ts", "README.md"];
      case "list_local_branches":
        return ["main", "dev"];
      case "validate_workspace_path":
        return {
          path: a?.path ?? "/x",
          absolutePath: a?.path ?? "/x",
          exists: true,
          isDir: true,
          isGitRepo: true,
          message: null,
        };
      case "create_repository":
        return {
          ...f.repositories[0],
          id: "repo-new",
          name: a?.name ?? "new-repo",
        };
      case "git_init_repository":
      case "git_init_empty_repository":
      case "git_clone_repository":
      case "git_init_from_template":
        return { ...f.repositories[0], id: "repo-new" };
      case "register_notification_route":
      case "activate_notification":
        return null;
      default:
        return null;
    }
  };

  (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: () => {},
  };
  (window as any).__E2E__ = {
    calls,
    names: () => calls.map((c) => c.cmd),
    emit: (event: string, payload: unknown) =>
      (listeners[event] ?? []).forEach((h) => h({ event, id: 1, payload })),
    pty: (key: string, msg: unknown) => channels[key]?.onmessage?.(msg),
    channelKeys: () => Object.keys(channels),
    setResponse: (cmd: string, val: unknown) => {
      overrides[cmd] = val;
    },
    clearCalls: () => {
      calls.length = 0;
    },
  };

  (window as any).__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    },
    transformCallback: (cb: unknown) => cb,
    convertFileSrc: (s: string) => s,
    unregisterCallback: () => {},
    invoke: (cmd: string, args: any) => {
      if (cmd === "plugin:event|listen") {
        (listeners[args.event] ??= []).push(args.handler);
        return Promise.resolve(listeners[args.event].length);
      }
      if (cmd === "plugin:event|unlisten") return Promise.resolve();
      if (cmd.startsWith("plugin:")) {
        // opener/dialog/notification/etc — benign, resolve falsy
        if (cmd.includes("is_permission_granted"))
          return Promise.resolve("granted");
        return Promise.resolve(null);
      }
      const chKey = args?.taskId ?? args?.id ?? args?.sessionId;
      if (args?.onEvent && chKey != null) channels[chKey] = args.onEvent;
      const clean = args ? { ...args } : args;
      if (clean && "onEvent" in clean) clean.onEvent = "<Channel>";
      calls.push({ cmd, args: clean });
      const val = cmd in overrides ? overrides[cmd] : RESP(cmd, args);
      if (val && typeof val === "object" && "__reject" in (val as any))
        return Promise.reject((val as any).__reject);
      return Promise.resolve(val === undefined ? null : val);
    },
  };
}

export async function bootApp(page: Page, fixtures = makeFixtures()) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));
  await page.addInitScript(installMock, fixtures);
  await page.goto("/");
  return { errors };
}

export const calls = (page: Page) =>
  page.evaluate(
    () => (window as any).__E2E__.calls as Array<{ cmd: string; args: any }>,
  );
export const callNames = (page: Page) =>
  page.evaluate(() => (window as any).__E2E__.names() as string[]);
export const clearCalls = (page: Page) =>
  page.evaluate(() => (window as any).__E2E__.clearCalls());
export const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as any).__E2E__.emit(e, p), [
    event,
    payload,
  ] as const);
export const pty = (page: Page, key: string, msg: unknown) =>
  page.evaluate(([k, m]) => (window as any).__E2E__.pty(k, m), [
    key,
    msg,
  ] as const);
export const setResponse = (page: Page, cmd: string, val: unknown) =>
  page.evaluate(([c, v]) => (window as any).__E2E__.setResponse(c, v), [
    cmd,
    val,
  ] as const);

/** Wait until an invoke with the given command name has been recorded. */
export async function waitForCall(page: Page, cmd: string, timeout = 5000) {
  await expect
    .poll(async () => (await callNames(page)).includes(cmd), { timeout })
    .toBe(true);
}
