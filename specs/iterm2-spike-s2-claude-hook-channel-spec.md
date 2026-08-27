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

_To be appended by the implementing agent. Format:_

```
**Decision (YYYY-MM-DD, <agent>): route A | B | C | BLOCKED**

Env injection point + variable name: …
Evidence hooks fired: …
Captured payload shapes: …
User settings preserved? …
Consequences for F1: …
```
