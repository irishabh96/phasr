# Spec: Spike S2 — Claude Code hook-injection channel

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Type:** Spike (time-boxed investigation) · **Timebox:** ½ day
**Gates:** Track F1 (agent status via hooks).
**Provenance:** derived from a local iTerm2 source read, 2026-08-27.

## Question to answer

**What is the cleanest way to attach Claude Code hooks to *phasr-spawned* agents without
mutating the user's repository or their global Claude settings — and does a hook process
launched that way inherit enough PTY environment to identify which phasr session it came
from?**

## Why the question is open

Two unknowns, and the second is a **verified defect in the original plan**:

1. Claude Code's settings-resolution order and which of the three injection routes actually
   fires hooks for our invocation shape.
2. **`PHASR_TASK_ID` does not exist anywhere in the codebase.** The plan assumed it was
   already set in `terminal_env()`. It is not: `terminal_env(shell: &str)`
   (`src-tauri/src/pty/shell.rs:73`) takes only the shell path and sets exactly `TERM`
   (`xterm-256color`), `COLORTERM`, `TERM_PROGRAM` (`kitty`), `SHELL`, and `LANG` if unset,
   plus a macOS PATH augmentation. Adding a per-session id therefore means changing that
   function's signature (or injecting at its single call site,
   `src-tauri/src/pty/handle.rs:172`, where `task_id` is already in scope). That is a design
   choice this spike must make, not assume.

## Candidate routes (evaluate all three)

| Route | Mechanism | Cost | Risk |
|---|---|---|---|
| **A — `--settings <file>`** | Command template appends the flag. The default template lives at `src-tauri/src/domain/agent.rs:71` (`Agent::Claude => "claude --dangerously-skip-permissions"`); interpolation happens in `interpolate_command` (`src-tauri/src/orchestrator/templating.rs:37`). | Small | User-customised templates may not carry the flag; flag support/precedence must be verified against the shipping CLI. |
| **B — settings env var** | Export a Claude-settings environment variable from the PTY env alongside the new task id. | Smallest | Only viable if the CLI honours such a variable; must be confirmed empirically, not from memory. |
| **C — `.claude/settings.local.json` in the worktree** | Write our hook config into the workspace worktree. | Small | **Last resort.** Mutates user-owned space; collides with the user's own file; survives after phasr exits. |

## Method (½ day, in order)

1. **Confirm the identity gap.** Re-verify that no `PHASR_TASK_ID` exists
   (`grep -rn PHASR_TASK_ID src-tauri/src src`) and decide the injection point: extend
   `terminal_env` to take the task id, or set the extra env at `handle.rs:172`. Record which
   and why.
2. **Test route B first** (cheapest): spawn a real `claude` invocation through a phasr PTY
   with the candidate env var set and a hook that writes a marker file. Did the hook fire?
3. **Test route A**: same, via `--settings <tempfile>` appended by the template. Confirm
   whether user settings still merge (hooks from our file must *add*, not replace the user's
   working configuration).
4. **Confirm env inheritance**: the hook process must see the task id from the PTY
   environment. This is the `TERM_SESSION_ID` trick cc-status relies on; verify our analog
   survives shell → claude → hook subprocess.
5. **Confirm event coverage**: with the winning route, verify each event F1 depends on
   actually fires: `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`,
   `Notification` (idle_prompt), `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`.
   Record the *actual JSON shape* of each payload — F1's parser is written against it.
6. **Write the decision** and stop.

## #PATH_DECISION — env injection point

Extending `terminal_env(shell)` to `terminal_env(shell, task_id)` makes the session identity
part of the terminal contract and keeps its unit test
(`shell.rs:233 terminal_env_overrides_terminal_keys_and_strips_runtime_keys`) as the one
place that asserts what a phasr terminal's environment is. Injecting at `handle.rs:172`
instead keeps `shell.rs` free of orchestrator concepts.

Preference (to be confirmed by the spike): **extend `terminal_env`**, because
`should_pass_env` filtering already lives there and a task id set outside that filter can be
silently stripped by a future change to it.

**Settled by the architect (2026-08-27), two parts:**

1. **Extend `terminal_env(shell) → terminal_env(shell, session)`** — confirmed, for the reason
   above. Verified: the single call site is inside the spawn-candidate loop
   (`src-tauri/src/pty/handle.rs:172`, `for (key, value) in shell::terminal_env(&launch.shell)`),
   so the signature change is one line there plus the unit test at `shell.rs:233`.
2. **The variable carries an unguessable per-session token, not the raw task id.** See
   `specs/f1-agent-status-hooks-spec.md`, "#PATH_DECISION — Q2 corollary". The spike must
   report the *variable name*; the *value* is a minted token by decision. The shim reads either
   one from its environment, so this costs nothing and closes the spoofing hole in F1's socket.
3. **Sequencing:** F1 lands this signature change; F2 later adds `ZDOTDIR`/`--rcfile` to the
   same shape. The two must not both re-shape `terminal_env` — see "Serialization constraints"
   in `specs/iterm2-parity-overview-spec.md`.

## Decision criteria

Pick the route that satisfies all of:
- Hooks fire for phasr's own invocations, verified by an observed side effect.
- The user's repo and the user's global `~/.claude` config are untouched.
- The user's own hooks/settings are not disabled by ours.
- The hook subprocess can read the phasr session id from its environment.

If no route satisfies all four, return **BLOCKED** and F1 falls back to heuristics only —
which means F1 as specced does not ship and the architect must re-scope it.

## Acceptance criteria

1. A written decision (route A / B / C / BLOCKED) is appended under **Decision**, dated and
   signed.
2. The decision records, for the winning route, the **observed** evidence that a hook fired
   (marker file contents or captured stdin JSON) — not a prediction.
3. The decision includes the captured JSON payload shape for **every** event in Method step
   5, including which of them omit a background-task count (F1's tri-state semantics depend
   on this).
4. The decision names the env-injection point chosen (per #PATH_DECISION) and the exact
   variable name.
5. The decision states whether the user's own hooks survive alongside ours.
6. No production code merges from this spike; probe artifacts live in the scratchpad.

## Test / evidence plan

- **This spike cannot use the e2e harness.** `e2e/harness.ts` mocks the Tauri IPC layer
  entirely — it never spawns a PTY, never runs `claude`, and therefore cannot observe a hook
  firing. Evidence must come from a **manual run against a real spawned agent**, with the
  captured artifacts pasted into the Decision section.
- Use `github.com/irishabh96/test-repo` as the target repository — near-empty and safe to
  spawn agents against.
- If the chosen route is A, the follow-on F1 work gets a Rust unit test on the command
  assembly (does `interpolate_command` output carry the flag for every preset and for a
  user-customised template?). Note that as a hand-off item.

## Out of scope

Implementing the socket, the shim, or the state model (all F1) · handling non-Claude agents
(`codex`, `copilot`, `gemini`, `opencode` — see `src/lib/types.ts:23`; they keep heuristics)
· any UI.

## Decision

**Decision (2026-08-27, S2 spike agent): route A — `claude --settings <file>`.**

Verified against the shipping CLI on this machine: **`2.1.247 (Claude Code)`**
(`/Users/rishabh/.local/bin/claude` → `~/.local/share/claude/versions/2.1.247`, arm64
Mach-O). All evidence below is observed from real runs in the scratchpad
(`…/scratchpad/s2/`), not docs recall; docs (via the claude-code-guide agent) were used only
to cross-check, and where they disagreed with observation, observation is recorded.

### Chosen mechanics

- `--settings <file-or-json>` exists in 2.1.247 and loads **additional** settings
  (help text: "load additional settings"; docs: precedence *managed > `--settings` >
  `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`*,
  additive merge, 2 MiB cap). It accepts a file path or an inline JSON string — phasr should
  use a **file path**: inline JSON inside a command string typed into a PTY is shell-quoting
  hell, and a single static file works for every session because the session identity rides
  in the environment, not the file.
- **Hooks from multiple sources all run.** Verified: a project `.claude/settings.json` hook
  and a `--settings` hook registered on the same event both fired on one `UserPromptSubmit`.
  Ours *add to*, never replace, the user's hooks. (This user's `~/.claude/settings.json`
  currently has `hooks: {}`, so there was no real-config collision to observe; the merge was
  proven with a throwaway project-level file.)
- The settings file lives in **phasr's own app-data dir**, written once at startup — the
  user's repo, worktree, and `~/.claude` are untouched. ⚠️ macOS app-data is
  `~/Library/Application Support/…` — the path contains a space, so the appended flag **must
  be double-quoted** in the command template.

### Routes B and C

- **B (settings env var) — dead.** No such variable exists: `strings` over the 2.1.247
  binary shows only `CLAUDE_CODE_MANAGED_SETTINGS_PATH` (overrides the *enterprise managed
  policy* path — wrong tier, and it would collide with a real managed config),
  `CLAUDE_CODE_REMOTE_SETTINGS_PATH`/`_POLL_MS`/`_MOCK` (remote-settings internals), and
  `CLAUDE_CODE_DISABLE_HOME_SETTINGS_SEED`. Docs confirm: no env var loads an extra settings
  file.
- **C (write `.claude/settings.local.json` into the worktree) — not needed.** A satisfies
  all four decision criteria, so the mutate-user-space fallback was never exercised.

### Env injection point + variable name

Per the architect's #PATH_DECISION: extend **`terminal_env(shell) → terminal_env(shell,
session)`** (`src-tauri/src/pty/shell.rs:73`; single call site `pty/handle.rs:172`; test
`shell.rs:233`). Variable name: **`PHASR_SESSION_TOKEN`**, value = unguessable per-session
token minted at spawn (Q2 corollary in `specs/f1-agent-status-hooks-spec.md` — token, never
the task id).

**Inheritance verified end-to-end:** the token was set on the spawning shell and read back
by the hook subprocess in **every one of the ~25 hook invocations across 6 runs**, through
the chain shell → PTY (`script`) → `claude` → `sh` hook:

```
=== event=UserPromptSubmit ts=20:50:55 ===
env PHASR_SESSION_TOKEN=tok_s2_probe_8f3a
```

Docs add: hooks also receive `CLAUDE_PROJECT_DIR`, run without a controlling terminal, and
`OTEL_*` vars are stripped — none of which affects the token.

### Events that fire: `-p` (print) vs interactive

| Event | `-p` mode | Interactive | Notes |
|---|---|---|---|
| `SessionStart` | **no** (observed twice; docs claim yes — observation wins) | yes | `source: "startup"`, `model` |
| `UserPromptSubmit` | yes | yes | |
| `PreToolUse` / `PostToolUse` | yes | yes | fired under both `default` and `bypassPermissions` |
| `PermissionRequest` | n/a (nothing prompts) | yes (default mode only) | never fires under `--dangerously-skip-permissions` — nothing needs permission |
| `Notification` | **no** (docs + observed: no notifications without a human) | yes | `idle_prompt` fired 60 s after `Stop`, incl. under phasr's default bypass template; `permission_prompt` fired ~6 s after `PermissionRequest` |
| `Stop` | yes | yes | |
| `SubagentStop` | not observed (no subagent in the cheap runs) | yes | fired when a utility subagent ran |
| `SessionEnd` | yes (`reason: "other"`) | yes (`reason: "prompt_input_exit"` on `/exit`) | |

Auto-approved commands (e.g. `echo`) run in default mode **without** any
`PermissionRequest`/`Notification` — a permission event only exists when a dialog actually
appears.

### Captured payload shapes (scratch session, nothing sensitive)

Common fields on every event: `session_id`, `transcript_path`, `cwd`, `hook_event_name`,
plus `prompt_id` and `permission_mode` (`"default"` / `"bypassPermissions"`) on
turn-scoped events. Distinctive fields, observed verbatim:

```json
// UserPromptSubmit
{"…common…","permission_mode":"default","prompt":"say hi"}

// PreToolUse
{"…common…","tool_name":"Write","tool_input":{"file_path":"…/marker.txt","content":"ok"},
 "tool_use_id":"toolu_018cpnCvNAvkJw7sgk6nV2ZJ"}

// PostToolUse — PreToolUse fields plus:
{"tool_response":{"type":"create","filePath":"…/marker.txt","content":"ok",
  "structuredPatch":[],"originalFile":null,"userModified":false},"duration_ms":4}

// PermissionRequest
{"…common…","tool_name":"Bash",
 "tool_input":{"command":"touch s2perm.txt","description":"Create an empty file named s2perm.txt"},
 "permission_suggestions":[{"type":"addDirectories","directories":["…/s2/repo"],
   "destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}]}

// Notification (idle) — note: NO permission_mode, NO background info, NO last message
{"…common…","message":"Claude is waiting for your input","notification_type":"idle_prompt"}

// Notification (permission)
{"…common…","message":"Claude needs your permission","notification_type":"permission_prompt"}

// Stop
{"…common…","stop_hook_active":false,
 "last_assistant_message":"Done — the output is `s2probe`.",
 "background_tasks":[],"session_crons":[]}

// SubagentStop — Stop fields plus:
{"agent_id":"aa9506c517e8d902c","agent_type":"",
 "agent_transcript_path":"…/subagents/agent-aa9506c517e8d902c.jsonl"}

// SessionStart
{"…common…","source":"startup","model":"claude-haiku-4-5-20251001"}

// SessionEnd
{"…common…","reason":"prompt_input_exit"}   // "other" in -p mode
```

**Background-task field census** (F1's tri-state semantics depend on this): only `Stop` and
`SubagentStop` carry `background_tasks` — and it is an **array, not a count** (observed
`[]`; element shape unobserved — parse permissively, count = `len`). `Notification`
(`idle_prompt` and `permission_prompt`), `SessionStart`, `SessionEnd`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, and `PermissionRequest` all **omit** it. The docs do not
mention the field at all; 2.1.247 demonstrably sends it. `notification_type` **is** a payload
field (docs claim type is matcher-only — wrong for 2.1.247), so the shim can forward every
`Notification` and let Rust filter.

### User settings preserved?

**Yes.** `--settings` merges (both hooks fired in the merge test); nothing is written to the
user's repo, worktree, `~/.claude`, or project `.claude/`. The user's own hooks — if they
ever add any — run alongside phasr's.

### Consequences for F1

1. **Transport design survives intact.** The shim reads stdin JSON + `PHASR_SESSION_TOKEN`
   from env and writes one socket frame — exactly as specced.
2. **`Stop` must stash *two* things, not one:** the `background_tasks` count **and**
   `last_assistant_message`. The `idle_prompt` payload carries *neither* (see census), so
   both the working/idle disambiguation *and* the idle-row detail line are readbacks from
   the last `Stop`. (`background_tasks` is an array — store `len`.)
3. **`SessionStart` cannot be the registration signal**: it does not fire in `-p` mode on
   2.1.247. Session identity comes from the token alone; treat `SessionStart` as optional
   enrichment (it does carry `model`).
4. **`-p` sessions never emit `Notification`** — they cannot go hook-idle; they end
   (`SessionEnd`, `reason: "other"`). The heuristic fallback covers the gap; this is fine
   because `-p` runs are one-shot.
5. **Under phasr's default template (`--dangerously-skip-permissions`) the "waiting" state
   is unreachable** — `PermissionRequest`/`permission_prompt` require a real dialog. The
   state is still worth implementing (default-mode/plan-mode sessions reach it), but the
   default phasr experience is working ↔ idle.
6. **"Waiting" detail line**: build from `PermissionRequest.tool_name` + `tool_input`
   (e.g. `Allow Bash: touch s2perm.txt`); `permission_suggestions` can be ignored.
7. **Shim must be write-and-exit fast**: `SessionEnd` hooks share a ~1.5 s budget (docs).
   No retries, no blocking connect.
8. **Command assembly** (hand-off test item from the evidence plan): append
   `--settings "<app-data>/hooks/phasr-hooks.json"` — **quoted** (macOS app-data contains a
   space) — at spawn time for `Agent::Claude` only. Note the plan's pointer to seeded
   templates in `migrations/0004_*` is stale: since migration 0010 agent commands are
   hardcoded in `domain/agent.rs` (`Agent::command()`), and workspaces carry a historical
   `command` snapshot column — appending post-interpolation at spawn covers both the enum
   command and legacy snapshots. F1 adds the Rust unit test that every assembled Claude
   command carries the quoted flag.
9. One **static** settings file serves all sessions (identity is env-borne) — write it once
   at app startup, no per-session temp files to clean up.

Probe artifacts (hook script, settings file, logs, typescripts) live in the session
scratchpad under `s2/`; nothing from this spike merges into production code.
