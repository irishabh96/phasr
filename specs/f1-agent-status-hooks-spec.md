# Spec: Track F1 — Agent status via Claude Code hooks

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** F (features) · **Ships as:** 0.5.0 · **Size:** ~3–4 days
**Depends on:** Spike S2 (hook-injection route + payload shapes), perf Phase 3 landed
**Independent of:** the ghostty-web patch — this is Rust + UI work only
**Provenance:** derived from a local iTerm2 source read, 2026-08-27 (iTerm2 master's
`cc-status` shim and `ToolStatus.swift` UI rules).

## Objective

Replace heuristic agent-liveness guessing with **ground truth** wherever the agent is Claude
Code: the agent tells us what it is doing, over a channel we own. Heuristics remain the
fallback for arbitrary commands.

iTerm2 keeps a `ScreenWatchPoller` alongside its hook integration for exactly this reason —
hooks cover the agent you integrated with; something has to cover everything else.

## User story

- As a developer supervising several agents, I want to know at a glance which one is
  **working**, which is **waiting on me**, and which is **idle** — from what the agent
  actually reports, not from whether bytes moved — so I stop tabbing through terminals to
  find the one that needs an answer.
- As a developer whose agent is running background tasks, I do not want it shown as idle just
  because it stopped printing.
- As a developer running a non-Claude command, I want the old heuristic status rather than a
  blank.

## Transport

A **unix domain socket** in the app-data directory, owned by the Tauri backend. A tiny
`phasr-hook` shim (shipped inside the app bundle) is what Claude Code invokes: it reads the
hook JSON on stdin, attaches the phasr session id from its environment, and writes **one
frame** to the socket. No HTTP, no ports, no listening on localhost.

## #PATH_DECISION — unix socket, not the alternatives

| Option | Verdict |
|---|---|
| **Unix socket in app-data (chosen)** | Filesystem-permissioned, no port to collide or be scanned, no firewall prompt, trivially testable from a Rust test. |
| Localhost HTTP/TCP port | Rejected: any local process (and any web page via a fetch to localhost) can reach it; needs a port allocation strategy; may trigger macOS network prompts. |
| OSC escape sequence into the PTY (what cc-status does) | Rejected here: it must survive our coalescer, our WASM parser and our IPC before anything can read it, and it needs the S1 engine patch to be observable at all. We copy iTerm2's *state model*, not its transport (see the overview spec). |
| A file the shim appends to, polled by Rust | Rejected: adds latency and a polling cost to the thing whose whole point is timeliness. |
| stdin/stdout of the agent process | Rejected: the agent owns those; that is the PTY stream. |

## #EXPORT_CRITICAL — the socket accepts JSON from a local process

The socket is an **input surface that accepts structured data and mutates UI state**. It must
be built defensively:

1. **Path + permissions.** The socket lives in phasr's app-data directory, created with
   permissions that allow **only the current user** (mode `0600` on the socket, and the
   containing directory not world-writable). It must not live in `/tmp` or any
   world-writable directory, where another local user could pre-create or replace it.
2. **Stale-socket handling.** On startup, an existing socket file is removed and recreated
   only after confirming no live listener owns it — never blindly `unlink`-and-bind a path a
   different process may legitimately hold.
3. **No authority beyond status.** A frame can only set a session's displayed status,
   indicator, and detail. It **cannot** spawn processes, write files, run commands, change
   settings, or address a session the sender did not identify. Treat the session id as a
   claim, not proof: an unknown id is dropped, not created.
4. **Bounded frames.** Per-frame size cap and a per-connection frame-rate cap; malformed
   JSON is dropped with a counter, never panics, never blocks the accept loop.
5. **Text is data, never markup or shell input.** `status` and `detail` strings are rendered
   as text (the repository-notes precedent: bodies stored raw, rendered as text, never
   `dangerouslySetInnerHTML`). They must never reach a shell, a git argument, or a PTY write.
   Truncate to a display cap before storing.
6. **Detail may contain user content.** `detail` carries "last assistant message" and
   permission summaries — i.e. text from the user's repository. It stays local: it is not
   logged to disk beyond normal app state and **is not synced to the cloud** in this version.
7. **The socket is torn down on app exit**, and its lifetime is scoped to the app process.

## State model — copy these semantics exactly (they are already debugged)

Three fields per session:

- **`status`** — text ("working", "waiting", "idle")
- **`indicator`** — dot colour
- **`detail`** — secondary line

Every update is per-field **tri-state: set / clear / leave alone**. This is the whole trick:
it is what stops `"Allow Edit: foo.ts"` lingering in `detail` after the permission was
granted, without forcing every event to restate every field.

### Event → status mapping

| Hook event | `status` | `indicator` (dot) | `detail` |
|---|---|---|---|
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | working | orange | **clear** (new turn) |
| `PermissionRequest` | waiting | blue | permission summary |
| `Notification(idle_prompt)` **with** background tasks | working | orange | "N background tasks" |
| `Notification(idle_prompt)` idle | idle | green | last assistant message |
| `Stop` / `SubagentStop` | *leave alone* | *leave alone* | last message; **store bg-task count** |
| `SessionStart` / `SessionEnd` | *leave alone* | *leave alone* | **clear all** |

**The stored background-task count matters.** `idle_prompt` payloads **omit** the count, so
the handler must **read back the count stashed at the last `Stop`** to decide between the two
`idle_prompt` rows. Without it, a session busy with background tasks flips to green/idle the
moment it stops printing — the exact bug this whole track exists to fix.

### UI rules (from iTerm2's `ToolStatus.swift`)

- **Priority sort**: `waiting` > `working` > `idle`, then **oldest-changed first** within a
  bucket.
- **Debounce status bursts at 50 ms.** A tool-use burst produces many events in a few
  milliseconds; the UI must not strobe.
- **Per-session snooze**: sink the session to the bottom and dim it; **auto-unsnooze on the
  next status change**.

## Acceptance criteria

1. **Socket exists and is defensible.** All seven #EXPORT_CRITICAL properties hold, each with
   a Rust test: mode/permissions, stale-socket handling, unknown-session-id dropped, oversize
   frame rejected, malformed JSON dropped without panic, frame-rate cap enforced, teardown on
   exit.
2. **Session identity works end-to-end.** A hook fired by a phasr-spawned agent reaches the
   backend already attributed to the right session, using the env variable S2 chose. (Note:
   **no such variable exists today** — see the correction below.)
3. **The full mapping table is implemented and asserted**, row by row, including the
   tri-state semantics: an event that says "leave alone" for a field provably does not modify
   it, and an event that says "clear" provably empties it.
4. **The `Stop` → `idle_prompt` background-task readback is asserted**: a scripted sequence
   `Stop(bgTasks=2)` → `Notification(idle_prompt)` yields **working / orange / "2 background
   tasks"**, not idle/green.
5. **`detail` lifecycle is asserted**: `PermissionRequest` sets a permission summary;
   the next `PreToolUse`/`PostToolUse` **clears** it. No lingering "Allow Edit: …".
6. **Priority sort** renders `waiting` above `working` above `idle`, oldest-changed first
   within each bucket.
7. **50 ms debounce**: a burst of N events inside 50 ms produces **one** UI update carrying
   the final state.
8. **Snooze** sinks and dims a session, and the **next** status change auto-unsnoozes it.
9. **Non-Claude commands still get heuristic states.** A workspace running `codex`,
   `copilot`, `gemini`, `opencode` or a plain shell (`src/lib/types.ts:23`) shows the
   heuristic status; hook state never blanks it.
10. **`kill -9` on the agent degrades gracefully**: within the heuristic timeout the session
    stops reading as "working". No stuck orange dot. Hook silence must never be interpreted
    as "still working forever".
11. **Hook state is the primary source for Working / Idle / Waiting**; Wedged and Failed
    remain heuristic (a hook cannot report that the process it lives in has wedged).

## #PLAN_UNCERTAINTY — the fallback pipeline is on a different branch

The plan says F1 integrates with "the existing honest-status liveness pipeline". **That
pipeline is not on `master` and therefore not on this branch.** It lives on `feat/task-board`
(`src-tauri/src/orchestrator/liveness.rs`, `src/lib/agentLiveness.ts`,
`src/lib/deriveAgentState.ts`), pushed to origin but never merged.

What this branch actually has:

| Piece | Location | Behaviour |
|---|---|---|
| `list_task_activity` | `src-tauri/src/commands/orchestrator.rs:61` | returns `lastOutputAt` (epoch ms) per running task |
| `TaskActivity` wire type | `src/lib/types.ts:99` | `{ taskId, lastOutputAt }` |
| `useRecentlyActiveTasks` | `src/lib/hooks/useTaskActivity.ts` | `ACTIVITY_TIMEOUT_MS = 10 * 60_000`, `POLL_MS = 60_000` |
| Sidebar activity dot | `src/components/AppSidebar.tsx` (~line 345) | `<StatusDot status="running" />` when recently active |
| `last_output_at` source | `src-tauri/src/pty/handle.rs:740` | stamped by the coalescer per read |

That is a *much* coarser fallback than Working/Idle/Wedged/Done/Failed: a 10-minute silence
timeout polled once a minute.

**An architect must settle before implementation starts:**
(a) does F1 build on this branch's `lastOutputAt` model, or (b) does `feat/task-board` merge
first? This spec is written against **(a)**, with the fallback consulted through a single
seam so that swapping in the richer pipeline is a localized change. Criterion 10's "degrades
gracefully" bar is correspondingly weaker under (a) — a killed agent takes up to
`ACTIVITY_TIMEOUT_MS` to stop reading as active — and that must be accepted or (b) chosen.

## Correction to the plan — `PHASR_TASK_ID` does not exist

The plan states `PHASR_TASK_ID` is "set in `terminal_env()`". Verified: it is **not**.
`terminal_env(shell: &str)` (`src-tauri/src/pty/shell.rs:73`) sets only `TERM`
(`xterm-256color`), `COLORTERM`, `TERM_PROGRAM` (`kitty`), `SHELL`, `LANG` if unset, and a
macOS PATH augmentation; it takes no task id and there is no such variable anywhere in the
tree. Its single call site is `src-tauri/src/pty/handle.rs:172`, where `task_id` **is** in
scope. Introducing the variable is F1/S2 work, not an assumption. S2 chooses the injection
point; F1 implements it.

## Implementation notes — verified entry points

| Piece | Location |
|---|---|
| PTY env (must carry the session id) | `src-tauri/src/pty/shell.rs:73` `terminal_env`; call site `src-tauri/src/pty/handle.rs:172`; env test at `shell.rs:233` |
| Agent enum + default command templates | `src-tauri/src/domain/agent.rs` — `Agent::Claude => "claude --dangerously-skip-permissions"` (:71) |
| Command interpolation (where `--settings` would be appended, if S2 picks route A) | `src-tauri/src/orchestrator/templating.rs:37` `interpolate_command` |
| Command registration + managed state | `src-tauri/src/lib.rs` — `generate_handler!` list and `.manage(...)` calls (see `NotificationRouteRegistry` at :55 for the pattern) |
| Frontend IPC surface ("3+1": Rust command, `tauri.ts`, `types.ts`, `e2e/harness.ts`) | `src/lib/tauri.ts`, `src/lib/types.ts`, `e2e/harness.ts` |
| Agent icons / labels for the UI | `src/lib/agentIcons.ts`, `src/lib/types.ts:23` (`Agent` union) |
| Sidebar surface to extend | `src/components/AppSidebar.tsx` |
| Session guard precedent | `session.require()` as the first line of every command (repository-notes spec, `src-tauri/src/commands/notes.rs`) |

## Test / evidence plan

- **Rust** (`cargo test --manifest-path src-tauri/Cargo.toml`) — the primary suite:
  - Socket lifecycle: bind, permissions, stale-file handling, teardown.
  - Frame parsing: every row of the mapping table, driven by the **captured payload shapes S2
    recorded** (not invented fixtures).
  - Tri-state semantics: set / clear / leave-alone per field.
  - The `Stop` → `idle_prompt` background-count readback.
  - Adversarial frames: oversize, malformed, unknown session id, flood.
- **vitest** (`pnpm test`): priority sort, oldest-changed tiebreak, 50 ms debounce, snooze and
  auto-unsnooze — all pure functions, all directly unit-testable, following the
  `deriveAgentState.test.ts` shape that exists on `feat/task-board`.
- **Playwright** (`e2e/harness.ts`): the UI half — scripted status payloads pushed through
  the mocked IPC assert rendering, ordering, debounce, dimming. **Limitation, stated:** the
  harness mocks the Tauri IPC layer entirely, so it **cannot** validate the socket, the shim,
  hook firing, or env inheritance. It proves the reducer and the view, nothing below them.
- **Manual** — required, and the only proof of criteria 2 and 10 end-to-end: spawn a real
  Claude agent against `github.com/irishabh96/test-repo`, drive it through a permission
  request and a completion, then `kill -9` it. Add the checklist entry to
  `docs/MANUAL-VERIFICATION.md`.

## Out of scope

Non-Claude agent integrations · a Cockpit-style dedicated panel (this version renders into
existing surfaces) · notifications on status change (that is **F3**, which consumes this
track's signal) · syncing status to the cloud · historical status timeline · the OSC 21337
wire protocol.
