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

  const listeners: Record<string, Array<(e: unknown) => void>> = {};
  const channels: Record<string, { onmessage?: (m: unknown) => void }> = {};
  const calls: Array<{ cmd: string; args: unknown }> = [];
  // Seed overrides at boot (e.g. make open_task_terminal reject from the very
  // first mount) via fixtures.overrides — set before any command fires.
  const overrides: Record<string, unknown> = { ...((f as any).overrides ?? {}) };
  let sessionSeq = 0;

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
    // Raw PTY output. Since perf phase 4 a real channel delivers output as
    // an ArrayBuffer with no envelope at all (`InvokeResponseBody::Raw`),
    // so the mock delivers one too — otherwise every terminal spec would be
    // exercising a shape the app no longer receives.
    //
    // `TextEncoder` gives the UTF-8 bytes of the text, which is what a PTY
    // would have produced for it; its result owns an exactly-sized buffer,
    // so `.buffer` is the chunk and nothing is copied.
    ptyOut: (key: string, text: string) =>
      channels[key]?.onmessage?.(new TextEncoder().encode(text).buffer),
    channelKeys: () => Object.keys(channels),
    setResponse: (cmd: string, val: unknown) => { overrides[cmd] = val; },
    clearCalls: () => { calls.length = 0; },
  };

  (window as any).__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
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
        if (cmd.includes("is_permission_granted")) return Promise.resolve("granted");
        return Promise.resolve(null);
      }
      const chKey = args?.taskId ?? args?.id ?? args?.sessionId;
      if (args?.onEvent && chKey != null) channels[chKey] = args.onEvent;
      const clean = args ? { ...args } : args;
      if (clean && "onEvent" in clean) clean.onEvent = "<Channel>";
      calls.push({ cmd, args: clean });
      const val = cmd in overrides ? overrides[cmd] : RESP(cmd, args);
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
    if (m.type() === "error") errors.push(m.text());
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
 * Emit PTY output. **Use this instead of hand-building an output message** —
 * the wire shape is a backend detail, and every spec that spelled it out
 * inline had to be edited by hand when it changed (twice now: lossy string →
 * base64 JSON → raw bytes). This is the single place that knows.
 *
 * **What this cannot prove.** The mock never spawns a PTY and never crosses
 * a real IPC, so it validates that the app *handles* the current payload
 * shape and nothing whatsoever about the transport that produces it. The
 * evidence for the raw-payload move is `src-tauri/src/ipcbench.rs` running
 * in a real shell, plus the `docs/MANUAL-VERIFICATION.md` entry — the same
 * class of gap ADR-002:820-830 recorded when it noted that the Rust
 * serializer and the JS decoder had never met in one process.
 */
export const ptyOut = (page: Page, key: string, text: string) =>
  page.evaluate(
    ([k, t]) => (window as any).__E2E__.ptyOut(k, t),
    [key, text] as const,
  );

/** Feed many chunks inside ONE round trip — for throughput probes, where
 *  per-`evaluate` overhead would otherwise swamp what is being measured. */
export const ptyBurst = (page: Page, key: string, texts: string[]) =>
  page.evaluate(
    ([k, chunks]) => {
      for (const text of chunks as string[]) {
        (window as any).__E2E__.ptyOut(k, text);
      }
    },
    [key, texts] as const,
  );
export const setResponse = (page: Page, cmd: string, val: unknown) =>
  page.evaluate(([c, v]) => (window as any).__E2E__.setResponse(c, v), [cmd, val] as const);

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
