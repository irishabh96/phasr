//! CLI stream events → `TranscriptItem`s and the side effects the session
//! acts on (session id, turn start/end, tool activity, permission requests,
//! usage). Pure: no I/O, the clock passed in, so the fixtures under
//! `fixtures/` drive it directly.
//!
//! Shapes are the ones probed on `claude` 2.1.322 (`fixtures/PROTOCOL.md`).
//! Anything unknown is ignored rather than surfaced: the CLI adds event
//! types freely, and the transcript is for the conversation, not the wire.
//!
//! Memory stays bounded by what is OPEN — a streaming block, a running
//! tool, a background command, a subagent — never by the transcript's
//! length: finished items are handed out and forgotten (bar the last few
//! background commands, whose output can still be read).
//!
//! Subagents: every line a subagent produces carries the `parent_tool_use_id`
//! of the `Agent` call that started it. Its items get that as `parent_id`
//! and nest under the call, whose `subagent` info counts its steps.
//!
//! Background commands: a `Bash` call returns at once with a
//! `backgroundTaskId`; `system/task_*` events carry the command's own
//! lifecycle (keyed by the CLI's task id), and the model reads its output
//! with `Read` on the task's output file. Those reads attach to the
//! command's item rather than becoming lines of their own.

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use super::transcript::{
    clip, new_id, tool_title, truncate_tail, BackgroundStatus, SubagentInfo, SystemLevel,
    ToolStatus, TranscriptItem, TranscriptOp, MAX_TOOL_OUTPUT,
};

/// The CLI's marker for a turn the user interrupted.
const INTERRUPTED_MARKER: &str = "[Request interrupted by user]";
/// Finished background commands remembered so a later read of their
/// output still lands on their item (the model often reads it in the turn
/// the completion starts).
const FINISHED_SHELLS_KEPT: usize = 16;
/// Where a background Bash's tool_result says its output goes.
const OUTPUT_FILE_MARKER: &str = "Output is being written to: ";

/// Something the session must do after a line.
#[derive(Debug, Clone, PartialEq)]
pub enum Output {
    /// Emit (and, unless `delta`, persist) a transcript change. `delta` =
    /// a streaming text/thinking update: coalesced to ≤ 30 Hz, never
    /// written (the block's final update carries the whole text).
    Item {
        op: TranscriptOp,
        item: TranscriptItem,
        delta: bool,
    },
    /// The CLI's session id (every turn's `init`).
    Session(String),
    /// A turn began (also one the CLI started on its own, e.g. after a
    /// background command finished).
    TurnStarted,
    ToolStarted { tool: String, input: Value },
    ToolFinished { tool: String },
    Permission(PermissionRequest),
    PermissionCancelled { request_id: String },
    /// A control request Phasr doesn't implement: answer it with an error
    /// so the CLI doesn't wait forever.
    UnsupportedControl { request_id: String },
    TurnEnded(TurnEnd),
    /// A background command finished: read the tail of its output file
    /// into its item (`Normalizer::background_output`).
    BackgroundEnded {
        id: String,
        output_file: Option<String>,
    },
    /// The CLI's own guess at the user's next message
    /// (`{"type":"prompt_suggestion","suggestion":"open a draft PR"}`),
    /// sent a second or so after a turn's `result` when the command
    /// passes `--prompt-suggestions` (PROTOCOL.md, "Prompt suggestions").
    NativeSuggestion(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct PermissionRequest {
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    pub tool_use_id: Option<String>,
    pub suggestions: Vec<Value>,
}

/// One turn's own usage (`result.usage` is per turn; `total_cost_usd` is
/// per SESSION, across resumes, so it's never used as a turn's cost).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnUsage {
    pub model: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// `None` when the CLI didn't price the turn.
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnEnd {
    pub usage: TurnUsage,
    /// The turn's last assistant text (the card's "last message").
    pub last_text: Option<String>,
    pub is_error: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BlockKind {
    Text,
    Thinking,
}

struct OpenBlock {
    kind: BlockKind,
    text: String,
    ts: String,
    started: DateTime<Utc>,
    /// Its complete `assistant` line already arrived (text is final; a
    /// thinking block still waits for its stop to know its duration).
    completed: bool,
    /// The subagent call it belongs to.
    parent: Option<String>,
}

/// A backgrounded command, once its call returned.
struct Shell {
    /// Its item's current state (the tool line it shows on).
    item: TranscriptItem,
    /// The CLI's id for it (`task_*` events, `stop_task`).
    task_id: String,
    output_file: Option<String>,
    /// Phasr asked the CLI to stop it: however the CLI then reports the
    /// end (between turns it says "completed"), it was killed.
    stop_requested: bool,
}

impl Shell {
    fn status(&self) -> Option<BackgroundStatus> {
        match &self.item {
            TranscriptItem::Tool {
                background_status, ..
            } => *background_status,
            _ => None,
        }
    }

    fn running(&self) -> bool {
        self.status() == Some(BackgroundStatus::Running)
    }
}

/// Parse one stdout line. `None` for blank lines and anything that isn't a
/// JSON object (a stray log line, a torn write).
pub fn parse_line(line: &[u8]) -> Option<Value> {
    let trimmed = line.trim_ascii();
    if trimmed.first() != Some(&b'{') {
        return None;
    }
    serde_json::from_slice::<Value>(trimmed)
        .ok()
        .filter(Value::is_object)
}

fn ts(now: DateTime<Utc>) -> String {
    now.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn int(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// Text of a tool_result's `content`: a string, or text parts.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| match s(p, "type") {
                Some("text") => s(p, "text").map(str::to_string),
                Some("image") => Some("[image]".into()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A `Read` result as the file's own text: the tool numbers every line
/// (`"     1\tdone"`), and says so in a reminder when the file is empty.
fn read_tool_text(text: &str) -> String {
    if text.trim_start().starts_with("<system-reminder>") {
        return String::new();
    }
    text.lines()
        .map(|line| {
            let digits = line.trim_start();
            match digits.find('\t') {
                Some(at) if at > 0 && digits[..at].bytes().all(|b| b.is_ascii_digit()) => {
                    &digits[at + 1..]
                }
                _ => line,
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The output file a background Bash's tool_result names
/// ("… Output is being written to: /tmp/…/tasks/b1.output. You will …").
fn output_file_of(text: &str) -> Option<String> {
    let rest = &text[text.find(OUTPUT_FILE_MARKER)? + OUTPUT_FILE_MARKER.len()..];
    let end = rest.find(".output")? + ".output".len();
    Some(rest[..end].to_string())
}

/// A subagent's report without the CLI's bookkeeping tag in front
/// (`<tools-used-before-summary>Bash, Read</tools-used-before-summary>`).
fn subagent_report(text: &str) -> String {
    const CLOSE: &str = "</tools-used-before-summary>";
    let text = text.trim();
    match (text.starts_with("<tools-used-before-summary>"), text.find(CLOSE)) {
        (true, Some(at)) => text[at + CLOSE.len()..].trim().to_string(),
        _ => text.to_string(),
    }
}

fn non_empty<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    s(v, key).map(str::trim).filter(|t| !t.is_empty())
}

/// A subagent call: `Agent` (2.1.322), `Task` in older CLIs. Only one that
/// carries a prompt — newer CLIs also have task-list tools.
fn is_subagent_call(tool: &str, input: &Value) -> bool {
    tool == "Agent" || (tool == "Task" && input.get("prompt").is_some())
}

pub struct Normalizer {
    /// The task's cwd, for short paths in tool titles.
    cwd: String,
    open: HashMap<String, OpenBlock>,
    /// `(message id, block index) → item id`, for deltas and stops.
    blocks: HashMap<(String, u64), String>,
    /// Per message, its started blocks in order, so each complete
    /// `assistant` line (one block, no index) finds the block it completes.
    unmatched: HashMap<String, VecDeque<(BlockKind, String)>>,
    /// Running tools by tool_use id.
    tools: HashMap<String, TranscriptItem>,
    /// tool_use ids the host denied (their results are `denied`).
    denied: HashSet<String>,
    /// Background commands by tool_use id: the running ones, and the last
    /// `FINISHED_SHELLS_KEPT` finished ones (`finished`, oldest first).
    shells: HashMap<String, Shell>,
    finished: VecDeque<String>,
    /// The CLI's task ids (shells and subagents) → their tool_use ids.
    tasks: HashMap<String, String>,
    /// Calls reading a background command's output → (that command's
    /// tool_use id, the reading tool).
    reads: HashMap<String, (String, String)>,
    /// Subagent calls whose subagent is still at work (`task_started`, no
    /// `task_notification` yet).
    working_agents: HashSet<String>,
    /// Subagent calls that returned while their subagent works on (run in
    /// the background): their item, still counting steps.
    agents: HashMap<String, TranscriptItem>,
    /// Tool calls seen so far per open subagent call.
    nested_calls: HashMap<String, u32>,
    last_text: Option<String>,
    interrupted: bool,
    model: Option<String>,
}

impl Normalizer {
    pub fn new(cwd: impl Into<String>) -> Self {
        Self {
            cwd: cwd.into(),
            open: HashMap::new(),
            blocks: HashMap::new(),
            unmatched: HashMap::new(),
            tools: HashMap::new(),
            denied: HashSet::new(),
            shells: HashMap::new(),
            finished: VecDeque::new(),
            tasks: HashMap::new(),
            reads: HashMap::new(),
            working_agents: HashSet::new(),
            agents: HashMap::new(),
            nested_calls: HashMap::new(),
            last_text: None,
            interrupted: false,
            model: None,
        }
    }

    /// Whether any running background command has an output file to tail.
    pub fn tails_background(&self) -> bool {
        self.shells
            .values()
            .any(|s| s.running() && s.output_file.is_some())
    }

    /// Background commands still running, with the output file each
    /// writes to (when the CLI named it): what the session tails.
    pub fn background_files(&self) -> Vec<(String, String)> {
        self.shells
            .iter()
            .filter(|(_, shell)| shell.running())
            .filter_map(|(id, shell)| Some((id.clone(), shell.output_file.clone()?)))
            .collect()
    }

    /// The command's output as read from its file (the tail, `truncated`
    /// when the file is longer). An update when it changed; `live` = the
    /// command still runs: a streaming update (coalesced, not persisted).
    pub fn background_output(
        &mut self,
        id: &str,
        text: &str,
        truncated: bool,
        live: bool,
    ) -> Option<Output> {
        let shell = self.shells.get_mut(id)?;
        let (tail, cut) = truncate_tail(text, MAX_TOOL_OUTPUT);
        let TranscriptItem::Tool {
            output,
            output_truncated,
            ..
        } = &mut shell.item
        else {
            return None;
        };
        if output.as_deref() == Some(tail.as_str()) {
            return None;
        }
        *output = Some(tail);
        *output_truncated = Some(cut || truncated);
        Some(Output::Item {
            op: TranscriptOp::Update,
            item: shell.item.clone(),
            delta: live,
        })
    }

    /// The host is stopping the background command `id`: the CLI's task id
    /// to send `stop_task` for. `None` when it isn't running (any more).
    pub fn stop_background(&mut self, id: &str) -> Option<String> {
        let shell = self.shells.get_mut(id).filter(|s| s.running())?;
        shell.stop_requested = true;
        Some(shell.task_id.clone())
    }

    /// A tool item still being updated, wherever it's kept.
    fn item_mut(&mut self, id: &str) -> Option<&mut TranscriptItem> {
        if self.tools.contains_key(id) {
            return self.tools.get_mut(id);
        }
        if self.agents.contains_key(id) {
            return self.agents.get_mut(id);
        }
        self.shells.get_mut(id).map(|s| &mut s.item)
    }

    /// The user's message, as sent to the CLI (which doesn't echo it).
    pub fn user_sent(&mut self, text: &str, now: DateTime<Utc>) -> Output {
        Output::Item {
            op: TranscriptOp::Append,
            item: TranscriptItem::User {
                id: new_id(),
                ts: ts(now),
                text: text.to_string(),
                parent_id: None,
            },
            delta: false,
        }
    }

    /// The host denied `tool_use_id`'s permission request.
    pub fn note_denied(&mut self, tool_use_id: &str) {
        self.denied.insert(tool_use_id.to_string());
    }

    /// The items still open (streaming text, running tools, background
    /// commands, working subagents) as they read now — what a transcript
    /// read must overlay on the persisted file.
    pub fn open_items(&self) -> Vec<TranscriptItem> {
        let mut out: Vec<TranscriptItem> = self
            .open
            .iter()
            .map(|(id, block)| self.block_item(id, block, None))
            .collect();
        out.extend(self.tools.values().cloned());
        out.extend(self.agents.values().cloned());
        out.extend(self.shells.values().filter(|s| s.running()).map(|s| s.item.clone()));
        out
    }

    /// The process is gone: close everything that was still open. Its
    /// background commands went with its process group.
    pub fn settle(&mut self, now: DateTime<Utc>) -> Vec<Output> {
        let mut out = self.close_blocks(now);
        let mut items: Vec<TranscriptItem> = self.tools.drain().map(|(_, t)| t).collect();
        items.extend(self.agents.drain().map(|(_, t)| t));
        items.extend(
            self.shells
                .drain()
                .filter(|(_, s)| s.running())
                .map(|(_, s)| s.item),
        );
        items.sort_by(|a, b| a.id().cmp(b.id()));
        out.extend(items.into_iter().map(|t| update(t.settled())));
        self.finished.clear();
        self.tasks.clear();
        self.reads.clear();
        self.working_agents.clear();
        self.nested_calls.clear();
        out
    }

    pub fn feed(&mut self, event: &Value, now: DateTime<Utc>) -> Vec<Output> {
        // Inside a subagent: the `Agent` call it belongs to.
        let parent = s(event, "parent_tool_use_id").map(str::to_string);
        match s(event, "type") {
            Some("stream_event") => self.stream_event(event, parent, now),
            Some("assistant") => self.assistant(event, parent, now),
            Some("user") => self.user(event, parent.as_deref(), now),
            Some("result") => self.result(event, now),
            Some("system") => self.system(event, now),
            Some("control_request") => self.control_request(event),
            Some("control_cancel_request") => s(event, "request_id")
                .map(|id| {
                    vec![Output::PermissionCancelled {
                        request_id: id.to_string(),
                    }]
                })
                .unwrap_or_default(),
            Some("prompt_suggestion") => s(event, "suggestion")
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(|t| vec![Output::NativeSuggestion(t.to_string())])
                .unwrap_or_default(),
            // control_response (acks), rate_limit_event, anything new.
            _ => Vec::new(),
        }
    }

    fn block_item(&self, id: &str, block: &OpenBlock, duration_ms: Option<u64>) -> TranscriptItem {
        match block.kind {
            BlockKind::Text => TranscriptItem::Assistant {
                id: id.to_string(),
                ts: block.ts.clone(),
                text: block.text.clone(),
                streaming: !block.completed,
                parent_id: block.parent.clone(),
            },
            BlockKind::Thinking => TranscriptItem::Thinking {
                id: id.to_string(),
                ts: block.ts.clone(),
                text: block.text.clone(),
                duration_ms,
                parent_id: block.parent.clone(),
            },
        }
    }

    fn stream_event(
        &mut self,
        event: &Value,
        parent: Option<String>,
        now: DateTime<Utc>,
    ) -> Vec<Output> {
        let Some(inner) = event.get("event") else {
            return Vec::new();
        };
        let msg = s(event, "api_message_id").unwrap_or_default().to_string();
        let index = inner.get("index").and_then(Value::as_u64);
        match (s(inner, "type"), index) {
            (Some("content_block_start"), Some(index)) => {
                let block = inner.get("content_block").unwrap_or(&Value::Null);
                let (kind, text) = match s(block, "type") {
                    Some("text") => (BlockKind::Text, s(block, "text")),
                    Some("thinking") => (BlockKind::Thinking, s(block, "thinking")),
                    // tool_use is shown from its complete `assistant` line,
                    // which carries the whole input.
                    _ => return Vec::new(),
                };
                let id = format!("{msg}:{index}");
                let open = OpenBlock {
                    kind,
                    text: text.unwrap_or_default().to_string(),
                    ts: ts(now),
                    started: now,
                    completed: false,
                    parent,
                };
                let item = self.block_item(&id, &open, None);
                self.open.insert(id.clone(), open);
                self.blocks.insert((msg.clone(), index), id.clone());
                self.unmatched.entry(msg).or_default().push_back((kind, id));
                vec![Output::Item {
                    op: TranscriptOp::Append,
                    item,
                    delta: false,
                }]
            }
            (Some("content_block_delta"), Some(index)) => {
                let delta = inner.get("delta").unwrap_or(&Value::Null);
                let piece = match s(delta, "type") {
                    Some("text_delta") => s(delta, "text"),
                    Some("thinking_delta") => s(delta, "thinking"),
                    _ => None,
                };
                let Some(piece) = piece.filter(|p| !p.is_empty()) else {
                    return Vec::new();
                };
                let Some(id) = self.blocks.get(&(msg, index)).cloned() else {
                    return Vec::new();
                };
                let Some(block) = self.open.get_mut(&id) else {
                    return Vec::new();
                };
                if block.completed {
                    return Vec::new();
                }
                block.text.push_str(piece);
                let item = self.block_item(&id, &self.open[&id], None);
                vec![Output::Item {
                    op: TranscriptOp::Update,
                    item,
                    delta: true,
                }]
            }
            (Some("content_block_stop"), Some(index)) => {
                let Some(id) = self.blocks.remove(&(msg, index)) else {
                    return Vec::new();
                };
                self.close(&id, now).into_iter().collect()
            }
            _ => Vec::new(),
        }
    }

    /// Finish one open block: its final update, and off the open list.
    fn close(&mut self, id: &str, now: DateTime<Utc>) -> Option<Output> {
        let mut block = self.open.remove(id)?;
        block.completed = true;
        let duration = (block.kind == BlockKind::Thinking)
            .then(|| (now - block.started).num_milliseconds().max(0) as u64);
        // A subagent's words aren't the task's "last message".
        if block.kind == BlockKind::Text && block.parent.is_none() && !block.text.trim().is_empty() {
            self.last_text = Some(block.text.clone());
        }
        Some(update(self.block_item(id, &block, duration)))
    }

    fn close_blocks(&mut self, now: DateTime<Utc>) -> Vec<Output> {
        let mut ids: Vec<(DateTime<Utc>, String)> =
            self.open.iter().map(|(id, b)| (b.started, id.clone())).collect();
        ids.sort();
        self.blocks.clear();
        self.unmatched.clear();
        ids.into_iter()
            .filter_map(|(_, id)| self.close(&id, now))
            .collect()
    }

    fn assistant(&mut self, event: &Value, parent: Option<String>, now: DateTime<Utc>) -> Vec<Output> {
        let message = event.get("message").unwrap_or(&Value::Null);
        let msg = s(message, "id").unwrap_or_default().to_string();
        if parent.is_none() {
            if let Some(model) = s(message, "model") {
                self.model = Some(model.to_string());
            }
        }
        let Some(content) = message.get("content").and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for block in content {
            match s(block, "type") {
                Some("text") => {
                    let text = s(block, "text").unwrap_or_default();
                    out.extend(self.complete_block(&msg, BlockKind::Text, text, parent.clone(), now));
                }
                Some("thinking") => {
                    let text = s(block, "thinking").unwrap_or_default();
                    out.extend(self.complete_block(&msg, BlockKind::Thinking, text, parent.clone(), now));
                }
                Some("tool_use") => out.extend(self.tool_use(block, parent.clone(), now)),
                _ => {}
            }
        }
        out
    }

    /// A complete block from an `assistant` line: the authoritative text of
    /// the streamed block it completes, or a new item when nothing streamed
    /// (partial messages off, or a block the stream never opened).
    fn complete_block(
        &mut self,
        msg: &str,
        kind: BlockKind,
        text: &str,
        parent: Option<String>,
        now: DateTime<Utc>,
    ) -> Option<Output> {
        let streamed = self.unmatched.get_mut(msg).and_then(|queue| {
            let at = queue.iter().position(|(k, _)| *k == kind)?;
            queue.remove(at).map(|(_, id)| id)
        });
        if let Some(id) = streamed.filter(|id| self.open.contains_key(id)) {
            let block = self.open.get_mut(&id)?;
            if !text.is_empty() {
                block.text = text.to_string();
            }
            return match kind {
                // Final now; the block's stop is then a no-op.
                BlockKind::Text => {
                    self.blocks.retain(|_, v| *v != id);
                    self.close(&id, now)
                }
                // Its duration is known at its stop (which follows).
                BlockKind::Thinking => None,
            };
        }
        // Subagents don't stream (2.1.322): their blocks arrive here whole.
        match kind {
            BlockKind::Text if !text.trim().is_empty() => {
                if parent.is_none() {
                    self.last_text = Some(text.to_string());
                }
                Some(append(TranscriptItem::Assistant {
                    id: new_id(),
                    ts: ts(now),
                    text: text.to_string(),
                    streaming: false,
                    parent_id: parent,
                }))
            }
            BlockKind::Thinking if !text.trim().is_empty() => Some(append(TranscriptItem::Thinking {
                id: new_id(),
                ts: ts(now),
                text: text.to_string(),
                duration_ms: None,
                parent_id: parent,
            })),
            _ => None,
        }
    }

    fn tool_use(&mut self, block: &Value, parent: Option<String>, now: DateTime<Utc>) -> Vec<Output> {
        let (Some(id), Some(tool)) = (s(block, "id"), s(block, "name")) else {
            return Vec::new();
        };
        if self.tools.contains_key(id) || self.reads.contains_key(id) {
            return Vec::new();
        }
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        let started = Output::ToolStarted {
            tool: tool.to_string(),
            input: input.clone(),
        };
        // Reading a background command's output: it lands on that
        // command's line, not on a line of its own.
        if let Some(shell) = self.read_target(tool, &input) {
            self.reads.insert(id.to_string(), (shell, tool.to_string()));
            return vec![started];
        }
        let title = match self.stop_target(tool, &input) {
            Some(command) => format!("Stopping {}", clip(&command, 80)),
            None => tool_title(tool, &input, &self.cwd),
        };
        let mut item = TranscriptItem::tool(id, ts(now), tool, input.clone(), title.clone(), parent.clone());
        if let TranscriptItem::Tool {
            background,
            subagent,
            ..
        } = &mut item
        {
            if tool == "Bash" && input.get("run_in_background").and_then(Value::as_bool) == Some(true) {
                *background = Some(true);
            }
            if is_subagent_call(tool, &input) {
                *subagent = Some(SubagentInfo {
                    agent_type: non_empty(&input, "subagent_type")
                        .unwrap_or("general-purpose")
                        .to_string(),
                    description: non_empty(&input, "description").unwrap_or_default().to_string(),
                    steps: 0,
                    latest: None,
                });
            }
        }
        self.tools.insert(id.to_string(), item.clone());
        let mut out = vec![append(item)];
        // A subagent's step: its call counts it and shows it as the latest.
        // (`task_progress` counts the same calls, often first: steps are
        // the larger of the two counts, never their sum.)
        if let Some(parent) = &parent {
            let calls = self.nested_calls.entry(parent.clone()).or_default();
            *calls += 1;
            let calls = *calls;
            out.extend(self.subagent_progress(parent, Some(calls), Some(title)));
        }
        out.push(started);
        out
    }

    /// `parent`'s subagent did something: at least `steps` steps so far,
    /// and what it's doing now. A streaming update: only the call's final
    /// state is persisted.
    fn subagent_progress(
        &mut self,
        parent: &str,
        steps: Option<u32>,
        latest: Option<String>,
    ) -> Option<Output> {
        let item = self.item_mut(parent)?;
        let TranscriptItem::Tool {
            subagent: Some(info),
            ..
        } = &mut *item
        else {
            return None;
        };
        let before = info.clone();
        if let Some(steps) = steps {
            info.steps = info.steps.max(steps);
        }
        if let Some(latest) = latest {
            info.latest = Some(latest);
        }
        if *info == before {
            return None;
        }
        Some(Output::Item {
            op: TranscriptOp::Update,
            item: item.clone(),
            delta: true,
        })
    }

    /// The background command whose output a `Read` (of its output file)
    /// or a `BashOutput` (older CLIs) reads.
    fn read_target(&self, tool: &str, input: &Value) -> Option<String> {
        match tool {
            "Read" => {
                let path = non_empty(input, "file_path")?;
                self.shells
                    .iter()
                    .find(|(_, shell)| {
                        shell.output_file.as_deref() == Some(path)
                            || path.ends_with(&format!("/tasks/{}.output", shell.task_id))
                    })
                    .map(|(id, _)| id.clone())
            }
            "BashOutput" => {
                let task = non_empty(input, "bash_id").or_else(|| non_empty(input, "shell_id"))?;
                self.tasks.get(task).filter(|id| self.shells.contains_key(*id)).cloned()
            }
            _ => None,
        }
    }

    /// The command a `TaskStop` / `KillShell` call stops, when it's one of
    /// ours.
    fn stop_target(&self, tool: &str, input: &Value) -> Option<String> {
        if !matches!(tool, "TaskStop" | "KillShell" | "KillBash") {
            return None;
        }
        let task = non_empty(input, "task_id")
            .or_else(|| non_empty(input, "shell_id"))
            .or_else(|| non_empty(input, "bash_id"))?;
        let shell = self.shells.get(self.tasks.get(task)?)?;
        match &shell.item {
            TranscriptItem::Tool { input, .. } => non_empty(input, "command").map(str::to_string),
            _ => None,
        }
    }

    fn user(&mut self, event: &Value, parent: Option<&str>, now: DateTime<Utc>) -> Vec<Output> {
        let message = event.get("message").unwrap_or(&Value::Null);
        let content = match message.get("content") {
            Some(Value::Array(parts)) => parts.clone(),
            Some(Value::String(text)) => vec![serde_json::json!({"type": "text", "text": text})],
            _ => return Vec::new(),
        };
        let meta = event
            .get("tool_result_meta")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let structured = event.get("tool_use_result").unwrap_or(&Value::Null);
        let mut out = Vec::new();
        for part in &content {
            match s(part, "type") {
                Some("tool_result") => {
                    let Some(id) = s(part, "tool_use_id") else {
                        continue;
                    };
                    let rejected = meta.iter().filter(|m| s(m, "id") == Some(id)).any(|m| {
                        m.get("permission_decision").and_then(|d| s(d, "decision")) == Some("reject")
                            || s(m, "non_execution_kind") == Some("user-rejected")
                    });
                    let denied = self.denied.remove(id) || rejected;
                    let is_error = part.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    let text = result_text(part.get("content"));
                    if let Some((shell, tool)) = self.reads.remove(id) {
                        if !denied && !is_error {
                            out.extend(self.background_output(&shell, &read_tool_text(&text), false, false));
                        }
                        out.push(Output::ToolFinished { tool });
                        continue;
                    }
                    let Some(item) = self.tools.remove(id) else {
                        continue;
                    };
                    let status = if denied {
                        ToolStatus::Denied
                    } else if is_error {
                        ToolStatus::Error
                    } else {
                        ToolStatus::Done
                    };
                    let task = s(structured, "backgroundTaskId")
                        .map(str::to_string)
                        .or_else(|| self.task_of(id));
                    out.extend(self.tool_finished(item, status, &text, structured, task));
                }
                // A subagent's prompt (the call's input already has it).
                Some("text") if parent.is_some() => {}
                Some("text")
                    if !self.interrupted
                        && s(part, "text").is_some_and(|t| t.contains(INTERRUPTED_MARKER)) =>
                {
                    self.interrupted = true;
                    out.push(append(TranscriptItem::system(
                        SystemLevel::Info,
                        "Interrupted",
                        ts(now),
                    )));
                }
                _ => {}
            }
        }
        out
    }

    /// The CLI task id a tool_use started, if `task_started` named one.
    fn task_of(&self, tool_use_id: &str) -> Option<String> {
        self.tasks
            .iter()
            .find(|(_, id)| id.as_str() == tool_use_id)
            .map(|(task, _)| task.clone())
    }

    /// A tool call's result: its final state. A command that went to the
    /// background (`task`) is `done` as a call but runs on: it shows no
    /// output yet (the result is only "running in background…") and is
    /// tracked until its task ends. A subagent call shows its report.
    fn tool_finished(
        &mut self,
        mut item: TranscriptItem,
        status: ToolStatus,
        text: &str,
        structured: &Value,
        task: Option<String>,
    ) -> Vec<Output> {
        let (id, tool, backgrounded, running) = {
            let TranscriptItem::Tool {
                id,
                tool,
                status: item_status,
                output,
                output_truncated,
                background,
                background_status,
                subagent,
                ..
            } = &mut item
            else {
                return Vec::new();
            };
            *item_status = status;
            let backgrounded = task.filter(|_| status == ToolStatus::Done && tool == "Bash");
            let mut shown = text.to_string();
            if let Some(info) = subagent.as_mut() {
                if let Some(steps) = structured.get("totalToolUseCount").and_then(Value::as_u64) {
                    info.steps = info.steps.max(steps as u32);
                }
                // The report itself, not the hand-back frame around it.
                let report = subagent_report(&result_text(structured.get("content")));
                if !report.is_empty() {
                    shown = report;
                }
            }
            if backgrounded.is_some() {
                *background = Some(true);
                background_status.get_or_insert(BackgroundStatus::Running);
                *output = None;
                *output_truncated = None;
            } else {
                let (tail, cut) = truncate_tail(&shown, MAX_TOOL_OUTPUT);
                *output = Some(tail);
                *output_truncated = Some(cut);
            }
            let running = *background_status == Some(BackgroundStatus::Running);
            (id.clone(), tool.clone(), backgrounded, running)
        };
        let mut out = vec![update(item.clone())];
        if let Some(task_id) = backgrounded {
            self.tasks.insert(task_id.clone(), id.clone());
            self.shells.insert(
                id.clone(),
                Shell {
                    item,
                    task_id,
                    output_file: output_file_of(text),
                    stop_requested: false,
                },
            );
            if !running {
                self.remember_finished(&id);
            }
        } else if self.working_agents.contains(&id) {
            // The call returned but its subagent works on (backgrounded).
            self.agents.insert(id, item);
        } else {
            self.nested_calls.remove(&id);
        }
        out.push(Output::ToolFinished { tool });
        out
    }

    /// Keep the last few finished commands; forget older ones.
    fn remember_finished(&mut self, id: &str) {
        self.finished.retain(|f| f != id);
        self.finished.push_back(id.to_string());
        while self.finished.len() > FINISHED_SHELLS_KEPT {
            if let Some(old) = self.finished.pop_front() {
                if let Some(shell) = self.shells.remove(&old) {
                    self.tasks.remove(&shell.task_id);
                }
            }
        }
    }

    /// `task_started`: a background command or a subagent began.
    fn task_started(&mut self, event: &Value) -> Vec<Output> {
        let (Some(task), Some(tool_use)) = (s(event, "task_id"), s(event, "tool_use_id")) else {
            return Vec::new();
        };
        self.tasks.insert(task.to_string(), tool_use.to_string());
        match s(event, "task_type") {
            Some("local_agent") => {
                self.working_agents.insert(tool_use.to_string());
                Vec::new()
            }
            Some("local_bash") if event.get("is_backgrounded").and_then(Value::as_bool) == Some(true) => {
                self.mark_backgrounded(tool_use)
            }
            _ => Vec::new(),
        }
    }

    /// A running Bash call is (now) a background command.
    fn mark_backgrounded(&mut self, tool_use: &str) -> Vec<Output> {
        let Some(item) = self.tools.get_mut(tool_use) else {
            return Vec::new();
        };
        let TranscriptItem::Tool {
            background,
            background_status,
            ..
        } = &mut *item
        else {
            return Vec::new();
        };
        if background_status.is_some() {
            return Vec::new();
        }
        *background = Some(true);
        *background_status = Some(BackgroundStatus::Running);
        vec![update(item.clone())]
    }

    /// A task ended (`task_updated` with a final status, or
    /// `task_notification`; whichever comes first counts).
    fn task_ended(&mut self, event: &Value, status: &str) -> Vec<Output> {
        let tool_use = s(event, "tool_use_id")
            .map(str::to_string)
            .or_else(|| s(event, "task_id").and_then(|t| self.tasks.get(t).cloned()));
        let Some(tool_use) = tool_use else {
            return Vec::new();
        };
        let output_file = s(event, "output_file").map(str::to_string);
        if self.working_agents.remove(&tool_use) {
            self.nested_calls.remove(&tool_use);
            let steps = event
                .get("usage")
                .and_then(|u| u.get("tool_uses"))
                .and_then(Value::as_u64)
                .map(|n| n as u32);
            let mut out: Vec<Output> = self
                .subagent_progress(&tool_use, steps, None)
                .into_iter()
                .collect();
            // A backgrounded subagent's call is final only now.
            if let Some(item) = self.agents.remove(&tool_use) {
                out = vec![update(item)];
            }
            return out;
        }
        let end = |stop_requested: bool| {
            if stop_requested || matches!(status, "killed" | "stopped") {
                BackgroundStatus::Killed
            } else if status == "failed" {
                BackgroundStatus::Failed
            } else {
                BackgroundStatus::Done
            }
        };
        let Some(shell) = self.shells.get_mut(&tool_use) else {
            // Ended before its call even returned: the call's result then
            // finds it already over.
            if let Some(TranscriptItem::Tool {
                background_status: status @ Some(BackgroundStatus::Running),
                ..
            }) = self.tools.get_mut(&tool_use)
            {
                *status = Some(end(false));
            }
            return Vec::new();
        };
        if output_file.is_some() && shell.output_file.is_none() {
            shell.output_file = output_file;
        }
        if !shell.running() {
            return Vec::new();
        }
        let end = end(shell.stop_requested);
        if let TranscriptItem::Tool {
            background_status, ..
        } = &mut shell.item
        {
            *background_status = Some(end);
        }
        let out = vec![
            update(shell.item.clone()),
            Output::BackgroundEnded {
                id: tool_use.clone(),
                output_file: shell.output_file.clone(),
            },
        ];
        self.remember_finished(&tool_use);
        out
    }

    fn system(&mut self, event: &Value, now: DateTime<Utc>) -> Vec<Output> {
        match s(event, "subtype") {
            Some("init") => {
                if let Some(model) = s(event, "model") {
                    self.model = Some(model.to_string());
                }
                let mut out = Vec::new();
                if let Some(id) = s(event, "session_id") {
                    out.push(Output::Session(id.to_string()));
                }
                out.push(Output::TurnStarted);
                out
            }
            Some(sub) if sub.contains("error") => {
                let text = s(event, "message")
                    .or_else(|| s(event, "error"))
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("Claude reported an error ({sub})"));
                vec![append(TranscriptItem::system(SystemLevel::Error, text, ts(now)))]
            }
            Some("task_started") => self.task_started(event),
            Some("task_progress") => {
                let Some(tool_use) = s(event, "tool_use_id") else {
                    return Vec::new();
                };
                let steps = event
                    .get("usage")
                    .and_then(|u| u.get("tool_uses"))
                    .and_then(Value::as_u64)
                    .map(|n| n as u32);
                // `summary` is the CLI's own one-line status, when it has
                // one; its `description` repeats the raw tool input, which
                // the nested call's title already says better.
                let latest = non_empty(event, "summary").map(|t| clip(t, 120));
                self.subagent_progress(tool_use, steps, latest).into_iter().collect()
            }
            Some("task_updated") => {
                let patch = event.get("patch").unwrap_or(&Value::Null);
                if patch.get("is_backgrounded").and_then(Value::as_bool) == Some(true) {
                    if let Some(tool_use) = s(event, "task_id").and_then(|t| self.tasks.get(t)).cloned() {
                        return self.mark_backgrounded(&tool_use);
                    }
                }
                match s(patch, "status") {
                    Some(status @ ("completed" | "failed" | "killed")) => self.task_ended(event, status),
                    _ => Vec::new(),
                }
            }
            Some("task_notification") => {
                let status = s(event, "status").unwrap_or("completed");
                self.task_ended(event, status)
            }
            // status, thinking_tokens, permission_denied (its tool_result
            // says the same), background_tasks_changed, hooks, …
            _ => Vec::new(),
        }
    }

    fn control_request(&mut self, event: &Value) -> Vec<Output> {
        let Some(request_id) = s(event, "request_id") else {
            return Vec::new();
        };
        let request = event.get("request").unwrap_or(&Value::Null);
        if s(request, "subtype") != Some("can_use_tool") {
            return vec![Output::UnsupportedControl {
                request_id: request_id.to_string(),
            }];
        }
        vec![Output::Permission(PermissionRequest {
            request_id: request_id.to_string(),
            tool_name: s(request, "tool_name").unwrap_or("a tool").to_string(),
            input: request.get("input").cloned().unwrap_or(Value::Null),
            tool_use_id: s(request, "tool_use_id").map(str::to_string),
            suggestions: request
                .get("permission_suggestions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        })]
    }

    fn result(&mut self, event: &Value, now: DateTime<Utc>) -> Vec<Output> {
        let mut out = self.close_blocks(now);
        let interrupted = self.interrupted
            || s(event, "terminal_reason").is_some_and(|r| r.starts_with("aborted"));
        let reported_error = event.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        // An interrupt is the user's doing, not a failure.
        let is_error = reported_error && !interrupted;
        if is_error {
            let errors: Vec<&str> = event
                .get("errors")
                .and_then(Value::as_array)
                .map(|e| e.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let text = if !errors.is_empty() {
                errors.join("\n")
            } else if let Some(result) = s(event, "result").filter(|r| !r.trim().is_empty()) {
                result.to_string()
            } else {
                format!(
                    "The turn failed ({})",
                    s(event, "subtype").unwrap_or("error")
                )
            };
            out.push(append(TranscriptItem::system(SystemLevel::Error, text, ts(now))));
        }
        let usage = self.turn_usage(event);
        out.push(append(TranscriptItem::Result {
            id: new_id(),
            ts: ts(now),
            duration_ms: event.get("duration_ms").and_then(Value::as_u64).unwrap_or(0),
            cost_usd: usage.cost_usd,
            is_error,
            parent_id: None,
        }));
        out.push(Output::TurnEnded(TurnEnd {
            usage,
            last_text: self.last_text.take(),
            is_error,
        }));
        self.interrupted = false;
        self.denied.clear();
        // A read's result always comes within its turn.
        self.reads.clear();
        out
    }

    fn turn_usage(&self, event: &Value) -> TurnUsage {
        let usage = event.get("usage").unwrap_or(&Value::Null);
        let since = event
            .get("model_usage_since_last_result")
            .and_then(Value::as_object);
        let model = since
            .and_then(|m| m.keys().next().cloned())
            .or_else(|| {
                event
                    .get("modelUsage")
                    .and_then(Value::as_object)
                    .and_then(|m| m.keys().next().cloned())
            })
            .or_else(|| self.model.clone());
        TurnUsage {
            model,
            input_tokens: int(usage, "input_tokens"),
            output_tokens: int(usage, "output_tokens"),
            cache_read_tokens: int(usage, "cache_read_input_tokens"),
            cache_write_tokens: int(usage, "cache_creation_input_tokens"),
            cost_usd: since.map(|m| {
                m.values()
                    .filter_map(|v| v.get("costUSD").and_then(Value::as_f64))
                    .sum()
            }),
        }
    }
}

fn append(item: TranscriptItem) -> Output {
    Output::Item {
        op: TranscriptOp::Append,
        item,
        delta: false,
    }
}

fn update(item: TranscriptItem) -> Output {
    Output::Item {
        op: TranscriptOp::Update,
        item,
        delta: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A host replaying a fixture: CLI lines go through the normalizer; the
    /// `#>` lines are what the host wrote, so a user message becomes a user
    /// item and a deny marks its tool. Collects the folded transcript (by
    /// id, in append order) and every side output.
    struct Replay {
        n: Normalizer,
        order: Vec<String>,
        items: HashMap<String, TranscriptItem>,
        side: Vec<Output>,
        deltas: usize,
        /// request_id → tool_use_id, to apply the host's denies.
        requests: HashMap<String, String>,
        /// Background commands the host stopped (tool_use ids).
        stopped: Vec<String>,
    }

    impl Replay {
        fn new() -> Self {
            Self {
                n: Normalizer::new("/work/repo"),
                order: Vec::new(),
                items: HashMap::new(),
                side: Vec::new(),
                deltas: 0,
                requests: HashMap::new(),
                stopped: Vec::new(),
            }
        }

        fn apply(&mut self, outputs: Vec<Output>) {
            for out in outputs {
                match out {
                    Output::Item { op, item, delta } => {
                        if delta {
                            self.deltas += 1;
                        }
                        let id = item.id().to_string();
                        match op {
                            TranscriptOp::Append => {
                                assert!(!self.items.contains_key(&id), "appended twice: {id}");
                                self.order.push(id.clone());
                            }
                            TranscriptOp::Update => {
                                assert!(self.items.contains_key(&id), "update before append: {id}")
                            }
                        }
                        self.items.insert(id, item);
                    }
                    Output::Permission(req) => {
                        if let Some(t) = &req.tool_use_id {
                            self.requests.insert(req.request_id.clone(), t.clone());
                        }
                        self.side.push(Output::Permission(req));
                    }
                    other => self.side.push(other),
                }
            }
        }

        fn run(fixture: &str) -> Self {
            let mut r = Self::new();
            let now = Utc::now();
            for line in fixture.lines() {
                if let Some(sent) = line.strip_prefix("#> ") {
                    let v: Value = serde_json::from_str(sent).unwrap();
                    match s(&v, "type") {
                        Some("user") => {
                            let text = v["message"]["content"][0]["text"].as_str().unwrap();
                            let out = r.n.user_sent(text, now);
                            r.apply(vec![out]);
                        }
                        Some("control_response")
                            if v["response"]["response"]["behavior"] == "deny" =>
                        {
                            let req = v["response"]["request_id"].as_str().unwrap();
                            let tool = r.requests[req].clone();
                            r.n.note_denied(&tool);
                        }
                        // The host stopped a background command: Phasr
                        // asks by the command's tool_use id.
                        Some("control_request") if v["request"]["subtype"] == "stop_task" => {
                            let task = v["request"]["task_id"].as_str().unwrap();
                            let tool = r.n.tasks[task].clone();
                            assert_eq!(r.n.stop_background(&tool).as_deref(), Some(task));
                            r.stopped.push(tool);
                        }
                        _ => {}
                    }
                    continue;
                }
                let v = parse_line(line.as_bytes()).expect("fixture lines are JSON");
                let out = r.n.feed(&v, now);
                r.apply(out);
            }
            r
        }

        fn transcript(&self) -> Vec<&TranscriptItem> {
            self.order.iter().map(|id| &self.items[id]).collect()
        }

        /// The main conversation's kinds (`None`), or one subagent's.
        fn kinds_under(&self, parent: Option<&str>) -> Vec<String> {
            self.transcript()
                .into_iter()
                .filter(|i| i.parent_id() == parent)
                .map(kind)
                .collect()
        }

        fn tool(&self, id: &str) -> &TranscriptItem {
            &self.items[id]
        }

        fn kinds(&self) -> Vec<String> {
            self.transcript().into_iter().map(kind).collect()
        }

        fn turn_ends(&self) -> Vec<&TurnEnd> {
            self.side
                .iter()
                .filter_map(|o| match o {
                    Output::TurnEnded(t) => Some(t),
                    _ => None,
                })
                .collect()
        }
    }

    fn kind(i: &TranscriptItem) -> String {
        match i {
            TranscriptItem::User { .. } => "user".to_string(),
            TranscriptItem::Assistant { .. } => "assistant".into(),
            TranscriptItem::Thinking { .. } => "thinking".into(),
            TranscriptItem::Tool { tool, status, .. } => format!("tool:{tool}:{status:?}"),
            TranscriptItem::Result { is_error, .. } => format!("result:{is_error}"),
            TranscriptItem::System { level, text, .. } => format!("system:{level:?}:{text}"),
        }
    }

    fn assistant_texts(r: &Replay) -> Vec<(String, bool)> {
        r.transcript()
            .iter()
            .filter_map(|i| match i {
                TranscriptItem::Assistant { text, streaming, .. } => Some((text.clone(), *streaming)),
                _ => None,
            })
            .collect()
    }

    /// Opus run: Bash tool calls, streamed text, thinking, a backgrounded
    /// command, and the autonomous turn that followed it.
    #[test]
    fn a_real_session_normalizes_to_the_transcript() {
        let r = Replay::run(include_str!("fixtures/turns_text_thinking_tools.ndjson"));
        assert_eq!(
            r.kinds(),
            vec![
                "user", "tool:Bash:Done", "assistant", "result:false",
                "user", "tool:Bash:Done", "thinking", "assistant", "result:false",
                "user", "tool:Bash:Done", "assistant", "result:false",
                "user", "thinking", "tool:Bash:Done", "thinking", "assistant", "result:false",
                "user", "assistant", "result:false",
                // The background `sleep 30` finished: Claude's own turn.
                "assistant", "result:false",
            ]
        );
        assert!(r.deltas > 0, "partial deltas stream");
        let texts = assistant_texts(&r);
        assert_eq!(texts[0], ("I ran `echo hi` and it printed `hi`. Done.".into(), false));
        assert!(texts.iter().all(|(_, streaming)| !streaming));
        match r.transcript()[1] {
            TranscriptItem::Tool { title, output, output_truncated, input, .. } => {
                assert_eq!(title, "Running echo hi");
                assert_eq!(output.as_deref(), Some("hi"));
                assert_eq!(*output_truncated, Some(false));
                assert_eq!(input["command"], "echo hi");
            }
            other => panic!("{other:?}"),
        }
        match r.transcript()[6] {
            TranscriptItem::Thinking { text, duration_ms, .. } => {
                assert_eq!(text, "", "2.1.322 streams thinking without text");
                assert!(duration_ms.is_some());
            }
            other => panic!("{other:?}"),
        }
        match r.transcript()[3] {
            TranscriptItem::Result { duration_ms, cost_usd, .. } => {
                assert_eq!(*duration_ms, 3777);
                assert_eq!(*cost_usd, Some(0.160918));
            }
            other => panic!("{other:?}"),
        }

        let sessions: HashSet<&str> = r
            .side
            .iter()
            .filter_map(|o| match o {
                Output::Session(id) => Some(id.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(sessions, HashSet::from(["18973063-efa9-4584-9f03-bd619e5c4e80"]));
        let ends = r.turn_ends();
        assert_eq!(ends.len(), 6);
        assert_eq!(
            ends[0].usage,
            TurnUsage {
                model: Some("claude-opus-5-5".into()),
                input_tokens: 4,
                output_tokens: 97,
                cache_read_tokens: 37530,
                cache_write_tokens: 18932,
                cost_usd: Some(0.160918),
            }
        );
        // Per turn, not the session's running total.
        assert!((ends[1].usage.cost_usd.unwrap() - 0.0213438).abs() < 1e-9);
        assert_eq!(ends[0].last_text.as_deref(), Some("I ran `echo hi` and it printed `hi`. Done."));
        assert!(ends.iter().all(|e| !e.is_error));
        let started = r.side.iter().filter(|o| **o == Output::TurnStarted).count();
        assert_eq!(started, 6);
        assert!(r.n.open_items().is_empty(), "nothing left open after the last result");
    }

    /// Haiku run with host prompts: allow-for-session, no prompt the second
    /// time, a deny, an interrupt while a prompt was pending (the CLI
    /// cancels it), an interrupt mid-stream, and a normal turn after.
    #[test]
    fn permissions_denies_and_interrupts() {
        let r = Replay::run(include_str!("fixtures/permissions_deny_interrupt.ndjson"));
        let kinds = r.kinds();
        assert_eq!(
            kinds,
            vec![
                "user", "tool:Bash:Done", "thinking", "assistant", "result:false",
                "user", "tool:Bash:Done", "assistant", "result:false",
                "user", "tool:Bash:Denied", "thinking", "assistant", "result:false",
                "user", "tool:Bash:Denied", "system:Info:Interrupted", "result:false",
                "user", "thinking", "assistant", "system:Info:Interrupted", "result:false",
                "user", "assistant", "result:false",
            ],
            "{kinds:#?}"
        );
        let permissions: Vec<&PermissionRequest> = r
            .side
            .iter()
            .filter_map(|o| match o {
                Output::Permission(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(permissions.len(), 3, "turn 2 ran on the session rule");
        assert_eq!(permissions[0].tool_name, "Bash");
        assert_eq!(permissions[0].input["command"], "touch a.txt");
        assert_eq!(permissions[0].tool_use_id.as_deref(), Some("toolu_01KcBhFM2f2Ao3ckKmXC2Dkt"));
        assert_eq!(permissions[0].suggestions.len(), 3);
        let cancelled: Vec<&Output> = r
            .side
            .iter()
            .filter(|o| matches!(o, Output::PermissionCancelled { .. }))
            .collect();
        assert_eq!(
            cancelled,
            vec![&Output::PermissionCancelled {
                request_id: permissions[2].request_id.clone()
            }]
        );
        // The interrupted stream keeps what it had, finalized.
        let texts = assistant_texts(&r);
        let story = texts.iter().find(|(t, _)| t.starts_with("The Lamp at Gannet Point")).unwrap();
        assert!(story.0.ends_with("a flicker appeared far") && !story.1, "{story:?}");
        let ends = r.turn_ends();
        assert_eq!(ends.len(), 6);
        assert!(ends.iter().all(|e| !e.is_error), "an interrupt isn't an error");
        assert_eq!(ends[3].usage.cost_usd, Some(0.0));
    }

    /// Without `--permission-prompt-tool stdio` every prompt is denied by
    /// the CLI itself (`source: config`): those tools read as denied.
    #[test]
    fn prompts_nobody_answered_read_as_denied() {
        let r = Replay::run(include_str!("fixtures/no_host_prompts_autodeny.ndjson"));
        let denied = r
            .transcript()
            .iter()
            .filter(|i| matches!(i, TranscriptItem::Tool { status: ToolStatus::Denied, .. }))
            .count();
        assert_eq!(denied, 4);
        assert!(!r.side.iter().any(|o| matches!(o, Output::Permission(_))));
    }

    #[test]
    fn resume_and_queued_messages() {
        let r = Replay::run(include_str!("fixtures/resume.ndjson"));
        assert_eq!(r.kinds(), vec!["user", "assistant", "result:false"]);
        assert!(r
            .side
            .contains(&Output::Session("7350341e-f7ae-4d3a-8fb8-95f7e09ab595".into())));

        let r = Replay::run(include_str!("fixtures/queued_messages.ndjson"));
        assert_eq!(
            r.kinds(),
            vec!["user", "user", "assistant", "result:false", "assistant", "result:false"]
        );
        let texts: Vec<String> = assistant_texts(&r).into_iter().map(|(t, _)| t).collect();
        assert_eq!(texts, vec!["first", "second"]);
    }

    /// `--prompt-suggestions` (Haiku, two turns): the CLI's guess arrives
    /// after the second turn's `result` (none after the first: it waits
    /// for two assistant messages) and adds nothing to the transcript.
    #[test]
    fn a_native_prompt_suggestion_is_a_side_output() {
        let r = Replay::run(include_str!("fixtures/prompt_suggestion.ndjson"));
        assert_eq!(
            r.kinds(),
            vec!["user", "assistant", "result:false", "user", "assistant", "result:false"]
        );
        let natives: Vec<&Output> =
            r.side.iter().filter(|o| matches!(o, Output::NativeSuggestion(_))).collect();
        assert_eq!(natives, vec![&Output::NativeSuggestion("open a draft PR".into())]);
        let after_last_turn = r.side.iter().rposition(|o| matches!(o, Output::TurnEnded(_))).unwrap();
        assert!(matches!(r.side.last(), Some(Output::NativeSuggestion(_))));
        assert!(r.side.len() > after_last_turn + 1);

        let now = Utc::now();
        let mut n = Normalizer::new("/w");
        assert!(n.feed(&serde_json::json!({"type": "prompt_suggestion", "suggestion": "  "}), now).is_empty());
    }

    #[test]
    fn garbage_and_unknown_events_are_ignored() {
        assert_eq!(parse_line(b""), None);
        assert_eq!(parse_line(b"   \r"), None);
        assert_eq!(parse_line(b"npm WARN something"), None);
        assert_eq!(parse_line(b"{\"type\":\"assist"), None, "a torn line");
        assert_eq!(parse_line(b"[1,2]"), None);
        assert!(parse_line(b"  {\"type\":\"x\"}\r").is_some());
        let mut n = Normalizer::new("/w");
        let now = Utc::now();
        assert!(n.feed(&json!({"type": "brand_new_event", "x": 1}), now).is_empty());
        assert!(n.feed(&json!({"type": "system", "subtype": "status"}), now).is_empty());
        assert!(n.feed(&json!({"type": "stream_event"}), now).is_empty());
        assert!(n.feed(&json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "nope"}]}}), now).is_empty());
        // A subagent's words nest under its call, and aren't the task's
        // last message.
        let out = n.feed(&json!({"type": "assistant", "parent_tool_use_id": "toolu_task",
                          "message": {"id": "m", "content": [{"type": "text", "text": "sub"}]}}), now);
        assert!(matches!(&out[..], [Output::Item { item: TranscriptItem::Assistant { parent_id: Some(p), .. }, .. }] if p == "toolu_task"));
        assert_eq!(n.last_text, None);
        // A control request Phasr doesn't implement gets an answer.
        assert_eq!(
            n.feed(&json!({"type": "control_request", "request_id": "c1", "request": {"subtype": "mcp_message"}}), now),
            vec![Output::UnsupportedControl { request_id: "c1".into() }]
        );
        let out = n.feed(&json!({"type": "system", "subtype": "api_error", "message": "overloaded"}), now);
        assert!(matches!(&out[..], [Output::Item { item: TranscriptItem::System { level: SystemLevel::Error, text, .. }, .. }] if text == "overloaded"));
    }

    /// A failed turn (here: `--resume` of a session that doesn't exist, as
    /// the CLI reports it) is a red line plus an error result.
    #[test]
    fn a_failed_turn_says_why() {
        let mut n = Normalizer::new("/w");
        let out = n.feed(
            &json!({"type": "result", "subtype": "error_during_execution", "is_error": true,
                    "duration_ms": 0, "errors": ["No conversation found with session ID: x"],
                    "usage": {}, "modelUsage": {}}),
            Utc::now(),
        );
        assert!(matches!(&out[0], Output::Item { item: TranscriptItem::System { level: SystemLevel::Error, text, .. }, .. }
            if text == "No conversation found with session ID: x"));
        assert!(matches!(&out[1], Output::Item { item: TranscriptItem::Result { is_error: true, cost_usd: None, .. }, .. }));
        assert!(matches!(&out[2], Output::TurnEnded(TurnEnd { is_error: true, .. })));
    }

    /// Without partial messages, the complete `assistant` lines alone still
    /// produce the items; and a process that dies mid-stream settles what
    /// was open.
    #[test]
    fn complete_lines_alone_and_settling_on_exit() {
        let mut n = Normalizer::new("/w");
        let now = Utc::now();
        let out = n.feed(
            &json!({"type": "assistant", "message": {"id": "m1", "content": [{"type": "text", "text": "hello"}]}}),
            now,
        );
        assert!(matches!(&out[..], [Output::Item { op: TranscriptOp::Append, item: TranscriptItem::Assistant { streaming: false, .. }, .. }]));

        n.feed(&json!({"type": "stream_event", "api_message_id": "m2",
                       "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}}), now);
        n.feed(&json!({"type": "stream_event", "api_message_id": "m2",
                       "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "par"}}}), now);
        n.feed(&json!({"type": "assistant", "message": {"id": "m2", "content": [
            {"type": "tool_use", "id": "toolu_x", "name": "Read", "input": {"file_path": "/w/src/a.ts"}}]}}), now);
        let open = n.open_items();
        assert_eq!(open.len(), 2);
        assert!(open.iter().any(|i| matches!(i, TranscriptItem::Assistant { text, streaming: true, .. } if text == "par")));
        let settled = n.settle(now);
        assert!(settled.iter().any(|o| matches!(o, Output::Item { item: TranscriptItem::Assistant { streaming: false, .. }, .. })));
        assert!(settled.iter().any(|o| matches!(o, Output::Item { item: TranscriptItem::Tool { status: ToolStatus::Error, title, .. }, .. } if title == "Reading src/a.ts")));
        assert!(n.open_items().is_empty());
    }

    fn subagent(item: &TranscriptItem) -> &SubagentInfo {
        match item {
            TranscriptItem::Tool { subagent: Some(info), .. } => info,
            other => panic!("not a subagent call: {other:?}"),
        }
    }

    fn background(item: &TranscriptItem) -> (Option<bool>, Option<BackgroundStatus>, Option<&str>) {
        match item {
            TranscriptItem::Tool {
                background,
                background_status,
                output,
                ..
            } => (*background, *background_status, output.as_deref()),
            other => panic!("not a tool: {other:?}"),
        }
    }

    /// `--thinking-display summarized`: the thinking block streams its
    /// summary, so the item has text to expand.
    #[test]
    fn summarized_thinking_carries_its_text() {
        let r = Replay::run(include_str!("fixtures/thinking_summarized.ndjson"));
        assert_eq!(r.kinds(), vec!["user", "thinking", "assistant", "result:false"]);
        match r.transcript()[1] {
            TranscriptItem::Thinking { text, duration_ms, parent_id, .. } => {
                assert!(text.starts_with("I'm checking whether 391 factors"), "{text}");
                assert!(duration_ms.is_some());
                assert_eq!(*parent_id, None);
            }
            other => panic!("{other:?}"),
        }
        assert!(r.deltas > 0, "the summary streams in");
    }

    /// Haiku run with `--forward-subagent-text`: an `Agent` call whose
    /// subagent ran a Bash (failed), thought, spoke, read a file and
    /// reported; then a background `sleep 3; echo done` whose completion
    /// started a turn of its own that read the output file.
    #[test]
    fn a_subagent_nests_under_its_call() {
        let r = Replay::run(include_str!("fixtures/subagent_background.ndjson"));
        const AGENT: &str = "toolu_01HpErkYVdkJbNwph4HJRQ9F";
        assert_eq!(
            r.kinds_under(None),
            vec![
                "user", "thinking", "tool:Agent:Done", "thinking", "tool:Bash:Done", "thinking",
                "assistant", "result:false",
                // The background command finished: Claude's own turn. Its
                // read of the output file isn't a line of its own.
                "assistant", "result:false",
            ]
        );
        assert_eq!(
            r.kinds_under(Some(AGENT)),
            vec!["tool:Bash:Error", "thinking", "assistant", "tool:Read:Done", "assistant"]
        );
        let info = subagent(r.tool(AGENT));
        assert_eq!(info.agent_type, "general-purpose");
        assert_eq!(info.description, "List repo files and read src/a.ts");
        assert_eq!(info.steps, 2);
        assert_eq!(info.latest.as_deref(), Some("Reading src/a.ts"));
        // The call shows the subagent's report, not the hand-back frame.
        match r.tool(AGENT) {
            TranscriptItem::Tool { output: Some(output), title, .. } => {
                assert!(output.starts_with("The repo has three files"), "{output}");
                assert_eq!(title, "Running a subagent: List repo files and read src/a.ts");
            }
            other => panic!("{other:?}"),
        }
        // A subagent's words don't become the task's last message.
        let ends = r.turn_ends();
        assert!(ends[0].last_text.as_deref().is_some_and(|t| t.starts_with("The subagent finished.")));
        // Progress counted live (streaming updates of the call).
        assert!(r.deltas > 0);
        assert!(r.n.open_items().is_empty());
    }

    #[test]
    fn a_background_command_runs_on_and_its_reads_attach_to_it() {
        let r = Replay::run(include_str!("fixtures/subagent_background.ndjson"));
        const BASH: &str = "toolu_01CFvRZzseUnxeQN5BEqnyeA";
        let (bg, status, output) = background(r.tool(BASH));
        assert_eq!((bg, status), (Some(true), Some(BackgroundStatus::Done)));
        // The model's Read of the output file, line numbers stripped.
        assert_eq!(output, Some("done\n\n[exited with code 0]\n"));
        assert!(!r.transcript().iter().any(|i| matches!(i, TranscriptItem::Tool { title, .. } if title.contains(".output"))));
        let ended: Vec<&Output> = r.side.iter().filter(|o| matches!(o, Output::BackgroundEnded { .. })).collect();
        assert_eq!(
            ended,
            vec![&Output::BackgroundEnded {
                id: BASH.into(),
                output_file: Some(
                    "/tmp/claude/-work-repo/6a1d2e3f-9b5c-4d4e-8f20-3b4c5d6e7f80/tasks/bzxcwcb8c.output".into()
                ),
            }]
        );
    }

    /// Two subagents in parallel (siblings, each with its own steps), a
    /// background `sleep 60` the HOST stopped, and a `sleep 120` the model
    /// stopped with `TaskStop`.
    #[test]
    fn parallel_subagents_and_stopped_commands() {
        let r = Replay::run(include_str!("fixtures/parallel_subagents_stop.ndjson"));
        const A: &str = "toolu_01PfzaedFRFjcL48UCbXwtho";
        const B: &str = "toolu_019nvse23M5uRzRTUaJzVr2C";
        let top = r.kinds_under(None);
        assert_eq!(&top[..3], ["user", "tool:Agent:Done", "tool:Agent:Done"], "{top:#?}");
        assert_eq!(r.kinds_under(Some(A)), vec!["thinking", "tool:Read:Error", "thinking", "tool:Read:Done", "assistant"]);
        assert_eq!(r.kinds_under(Some(B)), vec!["tool:Read:Done", "assistant"]);
        assert_eq!(subagent(r.tool(A)).steps, 2);
        assert_eq!(subagent(r.tool(B)).steps, 1);
        assert_eq!(subagent(r.tool(B)).description, "Read src/b.ts");
        // A subagent's permission request names its own tool call.
        assert!(r.side.iter().any(|o| matches!(o, Output::Permission(p)
            if p.tool_use_id.as_deref() == Some("toolu_014hsUkagyjDYZ6vSiRs5ryf"))));

        assert_eq!(r.stopped, vec!["toolu_01BXtpDU5byB4Q1QAxrqSKon".to_string()]);
        assert_eq!(background(r.tool("toolu_01BXtpDU5byB4Q1QAxrqSKon")).1, Some(BackgroundStatus::Killed));
        assert_eq!(background(r.tool("toolu_012H7Ngwomqdwgg4j9Mz6FAf")).1, Some(BackgroundStatus::Killed));
        match r.tool("toolu_01BBgqsAgwkHXRBk9pE7MfCK") {
            TranscriptItem::Tool { tool, title, .. } => {
                assert_eq!((tool.as_str(), title.as_str()), ("TaskStop", "Stopping sleep 120"));
            }
            other => panic!("{other:?}"),
        }
        assert!(r.n.background_files().is_empty());
    }

    /// Stopped by the host between turns, the CLI reports the command
    /// "completed" (and starts a turn about it): it still reads as killed.
    #[test]
    fn a_command_the_host_stopped_reads_killed_whatever_the_cli_says() {
        let r = Replay::run(include_str!("fixtures/background_stop_between_turns.ndjson"));
        assert_eq!(r.stopped, vec!["toolu_01V8VzRuLPx2EbDfkZdWb9bX".to_string()]);
        assert_eq!(
            r.kinds(),
            vec!["user", "tool:Bash:Done", "assistant", "result:false", "assistant", "result:false"]
        );
        assert_eq!(background(r.tool("toolu_01V8VzRuLPx2EbDfkZdWb9bX")).1, Some(BackgroundStatus::Killed));
    }

    /// The session's side of a background command: it tails the output
    /// file while it runs (streaming updates), can stop it, and the
    /// process exiting kills what was still running.
    #[test]
    fn background_output_tailing_stopping_and_settling() {
        let mut n = Normalizer::new("/w");
        let now = Utc::now();
        n.feed(&json!({"type": "assistant", "message": {"id": "m", "content": [
            {"type": "tool_use", "id": "toolu_bg", "name": "Bash",
             "input": {"command": "pnpm dev", "run_in_background": true}}]}}), now);
        assert_eq!(n.stop_background("toolu_bg"), None, "not started yet");
        let out = n.feed(&json!({"type": "system", "subtype": "task_started", "task_id": "b1",
            "tool_use_id": "toolu_bg", "is_backgrounded": true, "task_type": "local_bash"}), now);
        assert!(matches!(&out[..], [Output::Item { item: TranscriptItem::Tool { background_status: Some(BackgroundStatus::Running), .. }, .. }]));
        n.feed(&json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_bg",
            "content": "Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b1.output. You will be notified when it completes."}]},
            "tool_use_result": {"backgroundTaskId": "b1"}}), now);
        assert!(n.tails_background());
        assert_eq!(n.background_files(), vec![("toolu_bg".to_string(), "/tmp/x/tasks/b1.output".to_string())]);
        let live = n.background_output("toolu_bg", "ready on :1420\n", false, true);
        assert!(matches!(live, Some(Output::Item { delta: true, item: TranscriptItem::Tool { output: Some(ref o), .. }, .. }) if o == "ready on :1420\n"));
        assert_eq!(n.background_output("toolu_bg", "ready on :1420\n", false, true), None, "unchanged");
        assert_eq!(n.open_items().len(), 1, "a running command is open");

        assert_eq!(n.stop_background("toolu_bg").as_deref(), Some("b1"));
        let settled = n.settle(now);
        assert!(matches!(&settled[..], [Output::Item { item: TranscriptItem::Tool { background_status: Some(BackgroundStatus::Killed), .. }, .. }]));
        assert_eq!(n.stop_background("toolu_bg"), None);
        assert!(!n.tails_background());
    }

    #[test]
    fn read_output_and_output_file_parsing() {
        assert_eq!(read_tool_text("     1\tdone\n     2\t\n     3\t[exited with code 0]\n"), "done\n\n[exited with code 0]");
        assert_eq!(read_tool_text("<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"), "");
        assert_eq!(read_tool_text("no numbers\there"), "no numbers\there");
        assert_eq!(
            output_file_of("Command running in background with ID: b. Output is being written to: /tmp/a b/tasks/b.output. You will be notified").as_deref(),
            Some("/tmp/a b/tasks/b.output")
        );
        assert_eq!(output_file_of("something else"), None);
        assert!(is_subagent_call("Agent", &json!({})));
        assert!(is_subagent_call("Task", &json!({"prompt": "x"})));
        assert!(!is_subagent_call("Task", &json!({"subject": "a todo"})));
    }
}
