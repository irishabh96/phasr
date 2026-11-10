# Claude headless stream protocol (probed on `claude` 2.1.322)

Probed 2026-11-11 in a throwaway git repo. The fixtures in this directory are
the CLI's stdout lines exactly as written: one JSON object per line, with
personal paths, MCP server names and thinking signatures scrubbed. Lines
starting `#>` are what the host wrote on stdin at that point. Lines starting
`#raw` are non-JSON stdout lines; none occurred.

| Fixture | Run |
|---|---|
| `turns_text_thinking_tools.ndjson` | Opus, the user's own settings. Five turns: Bash (auto-allowed by the user's rules), thinking, a backgrounded `sleep 30`, and an autonomous turn when that background task finished. |
| `permissions_deny_interrupt.ndjson` | Haiku, `--setting-sources project`, `--permission-prompt-tool stdio`. Turns: allow-for-session, the same command again (no prompt), deny, interrupt while a permission was pending, interrupt mid-stream, then a normal turn. |
| `no_host_prompts_autodeny.ndjson` | The spec's command **without** `--permission-prompt-tool stdio`: every prompt was denied automatically. |
| `resume.ndjson` | `--resume <id>` of the permissions session in a new process. |
| `queued_messages.ndjson` | Two user messages written back to back, before the first turn ran. |

## Command line

```
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --permission-prompt-tool stdio \
  --permission-mode <mode> (--session-id <uuid> | --resume <uuid>)
```

- **`--permission-prompts host` is not enough.** It's the default, and on its
  own every prompt is denied: the CLI emits `system/permission_denied` and a
  tool_result with `permission_decision.source: "config"`, with no control
  request. **`--permission-prompt-tool stdio`** is what makes the CLI ask the
  host over stdout (see `no_host_prompts_autodeny.ndjson`).
- `--permission-mode default` is accepted. It isn't in `--help`'s list
  (`acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`),
  but `init` reports `"permissionMode":"default"`. Phasr's built-in Claude
  templates already carry the right flag per mode (nothing for ask-edits,
  `--permission-mode acceptEdits`, `--dangerously-skip-permissions`), so
  the stream launch adds its flags after the binary and keeps the
  template's own.
- No `initialize` control request is needed. The CLI waits for the first
  stdin line before it prints anything.
- The user's own `~/.claude/settings.json` allow rules apply: the Opus run's
  `echo hi` never prompted (`permission_decision.source: "config"`).

## stdin (host → CLI)

```jsonc
// a user message
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
// interrupt the current turn
{"type":"control_request","request_id":"<any unique id>","request":{"subtype":"interrupt"}}
// answer a permission request: allow once
{"type":"control_response","response":{"subtype":"success","request_id":"<the request's id>",
  "response":{"behavior":"allow","updatedInput":<the request's input>}}}
// allow for this session (Phasr's "allow for this task")
  "response":{"behavior":"allow","updatedInput":…,"updatedPermissions":[
    {"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch a.txt"}],
     "behavior":"allow","destination":"session"}]}
// deny
  "response":{"behavior":"deny","message":"The user denied this in Phasr."}
```

- Messages written while a turn runs are **queued**. Each one runs as its own
  turn with its own `init` … `result`, in order (`queued_messages.ndjson`).
- `updatedInput` is required on allow. Echo the request's `input`.

## stdout (CLI → host)

Every turn starts with **`system/init`**, not only the first one, carrying
`session_id`, `cwd`, `model`, `permissionMode` and `claude_code_version`. With
`--session-id X` or `--resume X`, `session_id` is `X`.

Partial messages are `stream_event` lines wrapping the Anthropic SSE events,
with top-level `session_id`, `parent_tool_use_id` (non-null inside a
subagent) and `api_message_id`:

- `message_start`;
- then per content block: `content_block_start` (`text` | `thinking` |
  `tool_use` with `id` and `name`) → `content_block_delta`s (`text_delta`,
  `thinking_delta`, `signature_delta`, `input_json_delta`) →
  `content_block_stop`;
- then `message_delta` / `message_stop`.

A complete **`assistant`** line follows each content block, carrying ONE
content block, with the same `message.id` as the stream's `api_message_id`.
It arrives just before that block's `content_block_stop`. An interrupted
block still gets its `assistant` line, with the partial text and
`"aborted": true`.

**Thinking text is empty.** With 2.1.322 and Opus 5.5 or Haiku 5.5, thinking
blocks stream only `thinking_delta` with `""` plus a `signature_delta`, and
the `assistant` thinking block has `"thinking": ""`. There's also
`system/thinking_tokens` with an estimate. So a `thinking` item can show
"Thought for Ns" but has no text.

Tool calls and results:

- **tool_use** is in the `assistant` line:
  `{"type":"tool_use","id":"toolu_…","name":"Bash","input":{…}}`.
- **tool_result** is in a `user` line:
  `message.content[] = {"type":"tool_result","tool_use_id","content","is_error"}`.
  - `content` is a string, or an array of `{type:"text",text}` parts.
  - The line also carries `tool_use_result` (structured output, e.g.
    `{stdout, stderr, interrupted}` for Bash) and
    `tool_result_meta[] = {id, permission_decision:{decision:"accept"|"reject", source}, non_execution_kind?}`.
- **Denied** tools (by the host, by config, or cancelled by an interrupt)
  come back as `is_error: true`. They also have
  `permission_decision.decision: "reject"` and/or
  `non_execution_kind: "user-rejected"`.
- **Backgrounded Bash** (`run_in_background: true`, which the CLI chose for
  `sleep 30`) returns a tool_result at once. It's followed by
  `system/task_started`, later `system/task_notification` /
  `task_updated`, and then an **autonomous turn** (a new `init` … `result`)
  with no user message.

The **permission request**:

```json
{"type":"control_request","request_id":"<uuid>","request":{
  "subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash",
  "input":{"command":"touch a.txt","description":"…"},"description":"…",
  "permission_suggestions":[
    {"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch a.txt"}],"behavior":"allow","destination":"localSettings"},
    {"type":"addDirectories","directories":["/work/repo"],"destination":"session"},
    {"type":"setMode","mode":"acceptEdits","destination":"session"}],
  "blocked_path":"/work/repo/a.txt","tool_use_id":"toolu_…"}}
```

- **Session-scoped allow is supported.** Replying with the `addRules`
  suggestion and `destination` rewritten to `"session"` stopped the CLI from
  asking about the same command again in that process. Phasr sends only the
  `addRules` suggestions this way, never `setMode`, which would switch the
  whole session to accept-edits. So `canAllowForTask` is true exactly when
  the request offers an `addRules` suggestion. The rule lasts for the CLI
  process, so it's gone after a resume.
- **Interrupt while a request is pending:** the CLI sends
  `{"type":"control_cancel_request","request_id":"<that request>"}`, then a
  tool_result rejecting the tool, then the interrupt's `control_response`
  (`{"subtype":"success","request_id":…,"response":{"still_queued":[]}}`).
- **Interrupt mid-stream:** the interrupt's `control_response`, then the
  partial `assistant` block (`"aborted": true`), then a `user` text line
  `[Request interrupted by user]`, then `result`.

The **`result`** line:

```jsonc
{"type":"result","subtype":"success"|"error_during_execution"|…,"is_error":false,
 "duration_ms":3777,"duration_api_ms":2356,"num_turns":2,"result":"<final text>",
 "stop_reason":"end_turn","terminal_reason":"completed"|"aborted_streaming",
 "session_id":"…","total_cost_usd":0.160918,
 "usage":{"input_tokens":4,"output_tokens":97,"cache_read_input_tokens":37530,
          "cache_creation_input_tokens":18932,…},
 "modelUsage":{"claude-opus-5-5":{"costUSD":…,…}},
 "model_usage_since_last_result":{"claude-opus-5-5":{"inputTokens":…,"costUSD":…}},
 "permission_denials":[{"tool_name","tool_use_id","tool_input"}],
 "queued_turn_count":0,"result_index":0,"errors":[…]}
```

- `usage` covers **this turn** only, summed over its API calls.
- `total_cost_usd` and `modelUsage` are cumulative for the **session**, and
  they carry over a `--resume` in a new process.
- The turn's cost is the sum of `model_usage_since_last_result[*].costUSD`.
- An interrupted turn is `subtype: "error_during_execution"`,
  `is_error: true`, `terminal_reason: "aborted_streaming"`, with zero usage
  and an empty `model_usage_since_last_result`. Its partial output is never
  billed in a later result either.

Noise Phasr ignores:

- `system/status`;
- `system/thinking_tokens`;
- `rate_limit_event`;
- `system/background_tasks_changed`, `task_started`, `task_updated` and
  `task_notification`;
- `control_response` acks.

## Resume

`claude -p … --resume <uuid>` in a new process continues the conversation
(the model remembered the earlier turns). Its `init` reports the same
`session_id`, and history is **not** replayed on stdout.

## Exit

Closing stdin lets the current turn and any queued ones finish, then the
process exits 0. That includes waiting for a backgrounded command's
notification turn.
