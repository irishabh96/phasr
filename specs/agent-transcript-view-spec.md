# Agent transcript view: one input, structured conversation

**Status:** approved (2026-11-11) · **Branch:** `feature/redesign-v2` (PR #37)
**Reverses:** decision D3 in `ui-mission-control-polish-spec.md` ("keep the terminal").

## 1. Problem

A Claude task shows two inputs:
- Claude Code's own `❯` prompt box, drawn inside the terminal;
- Phasr's composer below it.

Phasr can't remove the first, because the agent's TUI draws it. Hiding terminal rows would be fragile: the input area resizes, pickers and permission dialogs render there, and the TUI would still take keystrokes.

## 2. Solution

Run Claude **headless** and render the conversation in Phasr. The composer is then the only input.

```
claude -p \
  --input-format stream-json --output-format stream-json \
  --verbose --include-partial-messages \
  --permission-prompts host \
  --permission-mode <mode from the task> \
  --session-id <uuid>            # new task;  --resume <uuid> when resuming
  --settings <phasr settings>    # existing hooks/settings file, if still needed
```

- **Messages in:** one JSON line per user message on stdin.
- **Events out:** JSON lines on stdout. These cover:
  - init with the session id;
  - assistant messages, including partial deltas;
  - tool_use and tool_result;
  - usage;
  - the final `result`.
- **Approvals:** `--permission-prompts host` means "the SDK host answers permission prompts". The CLI sends a control request on stdout, and Phasr replies with a control response on stdin.

The exact wire format must be confirmed by probing the installed CLI before building on it (§6, B0).

Scope:
- **Phase 1:** Claude only. Codex, Gemini, Copilot and OpenCode stay on the terminal.
- **Per-task view:** each Claude task has a `transcript | terminal` view.
  - New Claude tasks default to **transcript**.
  - Existing tasks keep **terminal** until switched.
  - Switching keeps the same Claude session: transcript → terminal stops the stream process and runs `claude --resume <session>` in the PTY, and the reverse does the opposite.

## 3. What the user sees (A-Workspace)

- **Agent pane:** the transcript. It matches the A-Workspace artboard (`artifact-v2/project/A-Workspace.dc.html`, the "Transcript" block):
  - mono 12.5 px on the pane background;
  - a muted timestamp column, 56 px wide;
  - inline blocks for tool output and diffs.
- **Items:**
  - **User messages:** the text, plus attachments when present.
  - **Assistant text:** markdown rendered, streaming as it arrives.
  - **Thinking:** a collapsed "Thought for 4s" line that expands.
  - **Tool calls:** one line per call, with a running spinner, ✓ or ✗:
    - `Reading src/auth/redirect.ts`;
    - `Editing src/auth/redirect.ts`, with an inline −/+ diff block from the tool input (Edit / MultiEdit / Write);
    - `Running pnpm test src/auth`, with the output tail collapsed (the last ~12 lines, expandable);
    - `Searching "…"` / `Fetching <url>` and so on, through a generic formatter.
  - **Turn result:** a quiet line with duration and cost, e.g. "Done in 23s · $0.04".
  - **Errors:** a red system line.
- **Approval:** the existing `ApprovalCard`, docked above the composer. It's fed by the control request, with exact tool and input instead of screen-scraped text. Allow once and Deny map to the control response. "Allow for this task" is offered only if the protocol supports a session-scoped rule; otherwise it's hidden.
- **Composer:** the only input.
  - ⌘↵ sends.
  - Attachments become the block appended to the message, as today.
  - Chips stay.
  - While a turn runs, the send button becomes **Stop** (interrupt the turn) and the composer stays usable to queue a message.
- **Pane menu:** a "View as terminal" / "View as transcript" toggle on the agent tab's menu.
- **Virtualised:** the transcript is virtualised past 200 items. It auto-scrolls while pinned to the bottom, with a "Jump to latest" pill when you've scrolled up.

## 4. Contract (backend → frontend)

These are Phasr's own normalized types. Raw CLI events never reach the UI.

```ts
type TranscriptItem =
  | { kind: "user"; id: string; ts: string; text: string }
  | { kind: "assistant"; id: string; ts: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; ts: string; text: string; durationMs?: number }
  | { kind: "tool"; id: string /* tool_use id */; ts: string; tool: string;
      input: unknown; title: string /* "Editing src/a.ts" */;
      status: "running" | "done" | "error" | "denied";
      output?: string; outputTruncated?: boolean }
  | { kind: "result"; id: string; ts: string; durationMs: number; costUsd: number | null; isError: boolean }
  | { kind: "system"; id: string; ts: string; level: "info" | "error"; text: string };

// event "phasr://transcript"
type TranscriptEvent = { taskId: string; op: "append" | "update"; item: TranscriptItem };
```

| Command | Purpose |
|---|---|
| `get_transcript(taskId) -> TranscriptItem[]` | The full transcript, from a persisted JSONL per task under the app's log dir. Survives restarts. |
| `set_agent_view(taskId, view: "transcript" \| "terminal") -> Workspace` | Switches the view and the process, keeping the session. |
| `send_message_to_task` (unchanged signature) | Routes to stream stdin when the task is in transcript view. The existing needs-you refusal and sanitising still apply. |
| `interrupt_task(taskId)` | Interrupts the current turn (control request or SIGINT), without killing the session. |
| `respond_to_attention` (unchanged) | Answers the pending control request by attention id. The stale-id guard still applies. |

- **New field:** `Workspace.agentView: "transcript" | "terminal" | null`. It's local-only, stored per machine (`app_meta` or a local column, never synced), and null means terminal.
- **Agent state** (`working` / `idle` / `needs-you` / `exited`) and usage come from the stream rather than hooks or transcript files when in transcript view: exact tokens and cost from `result` and usage.
- The board, sidebar, notifications and approvals all keep working unchanged.

## 5. Out of scope (phase 1)

- Codex and other agents: Codex has a JSON mode; that's phase 2.
- Claude slash commands and interactive pickers in transcript view: use "View as terminal" for those.
- Editing or regenerating earlier messages.
- Images in assistant output.

## 6. Plan

- **B0: probe (backend, first).** In a temp git repo, run the command in §2 with a tiny prompt that needs a Bash approval (`echo hi`). Record the exact stdout/stdin JSON shapes:
  - init;
  - partial deltas;
  - assistant;
  - tool_use and tool_result;
  - the control request for permissions and its response format (allow, deny, and any session-scoped "always allow" option);
  - interrupt;
  - result;
  - resume.

  Save fixtures under `src-tauri/src/agent_stream/fixtures/`. This uses a few cents of the user's Claude usage.
- **B1: backend.**
  - A new module `agent_stream`: process spawn (pipes, process group, cwd = worktree, env as today), an NDJSON reader, a normalizer to `TranscriptItem`, a JSONL persister, the event bridge, the control-request → attention mapping, `send`/`interrupt`/`stop`, and view switching.
  - The commands in §4.
  - Wire start, resume and stop for Claude tasks whose view is transcript.
  - Tests: fixture-driven normalizer tests, plus a fake `claude` script for process tests.
- **F1: frontend.**
  - The `Transcript` component, with the item renderers per §3 and virtualisation.
  - Pane wiring: the agent pane renders `Transcript` instead of `Terminal` when `agentView === "transcript"`.
  - The composer's Stop and queue behaviour.
  - The toggle.
  - Harness support (a fake transcript backend) and e2e journeys.
- B1 and F1 build in parallel against §4. Merge them, then a full suite run and a real-app check.

## 7. Acceptance

- A new Claude task shows exactly one input: the composer.
- The transcript renders a real session:
  - text streaming;
  - tool lines with status;
  - edit diffs inline;
  - command output collapsible;
  - result lines.
- A Bash approval shows the card with the exact command. Allow and Deny work, as do the notification buttons and ⌘Y/⌘⌫.
- Quit and reopen: the transcript is restored, and the next message resumes the same session.
- View as terminal shows the same conversation in Claude's TUI, and switching back works.
- No regressions in terminal-view tasks or other agents. Full suites stay green.
