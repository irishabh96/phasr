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
//! tool — never by the transcript's length: finished items are handed out
//! and forgotten.

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

use super::transcript::{
    new_id, tool_title, truncate_tail, SystemLevel, ToolStatus, TranscriptItem, TranscriptOp,
    MAX_TOOL_OUTPUT,
};

/// The CLI's marker for a turn the user interrupted.
const INTERRUPTED_MARKER: &str = "[Request interrupted by user]";

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
            last_text: None,
            interrupted: false,
            model: None,
        }
    }

    /// The user's message, as sent to the CLI (which doesn't echo it).
    pub fn user_sent(&mut self, text: &str, now: DateTime<Utc>) -> Output {
        Output::Item {
            op: TranscriptOp::Append,
            item: TranscriptItem::User {
                id: new_id(),
                ts: ts(now),
                text: text.to_string(),
            },
            delta: false,
        }
    }

    /// The host denied `tool_use_id`'s permission request.
    pub fn note_denied(&mut self, tool_use_id: &str) {
        self.denied.insert(tool_use_id.to_string());
    }

    /// The items still open (streaming text, running tools) as they read
    /// now — what a transcript read must overlay on the persisted file.
    pub fn open_items(&self) -> Vec<TranscriptItem> {
        let mut out: Vec<TranscriptItem> = self
            .open
            .iter()
            .map(|(id, block)| self.block_item(id, block, None))
            .collect();
        out.extend(self.tools.values().cloned());
        out
    }

    /// The process is gone: close everything that was still open.
    pub fn settle(&mut self, now: DateTime<Utc>) -> Vec<Output> {
        let mut out = self.close_blocks(now);
        let mut tools: Vec<TranscriptItem> = self.tools.drain().map(|(_, t)| t).collect();
        tools.sort_by(|a, b| a.id().cmp(b.id()));
        out.extend(tools.into_iter().map(|t| update(t.settled())));
        out
    }

    pub fn feed(&mut self, event: &Value, now: DateTime<Utc>) -> Vec<Output> {
        // Inside a subagent (Task): its stream and tool calls are the
        // subagent's own conversation; phase 1 shows the Task call only.
        if event.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
            return Vec::new();
        }
        match s(event, "type") {
            Some("stream_event") => self.stream_event(event, now),
            Some("assistant") => self.assistant(event, now),
            Some("user") => self.user(event, now),
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
            },
            BlockKind::Thinking => TranscriptItem::Thinking {
                id: id.to_string(),
                ts: block.ts.clone(),
                text: block.text.clone(),
                duration_ms,
            },
        }
    }

    fn stream_event(&mut self, event: &Value, now: DateTime<Utc>) -> Vec<Output> {
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
        if block.kind == BlockKind::Text && !block.text.trim().is_empty() {
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

    fn assistant(&mut self, event: &Value, now: DateTime<Utc>) -> Vec<Output> {
        let message = event.get("message").unwrap_or(&Value::Null);
        let msg = s(message, "id").unwrap_or_default().to_string();
        if let Some(model) = s(message, "model") {
            self.model = Some(model.to_string());
        }
        let Some(content) = message.get("content").and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for block in content {
            match s(block, "type") {
                Some("text") => {
                    let text = s(block, "text").unwrap_or_default();
                    out.extend(self.complete_block(&msg, BlockKind::Text, text, now));
                }
                Some("thinking") => {
                    let text = s(block, "thinking").unwrap_or_default();
                    out.extend(self.complete_block(&msg, BlockKind::Thinking, text, now));
                }
                Some("tool_use") => out.extend(self.tool_use(block, now)),
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
        match kind {
            BlockKind::Text if !text.trim().is_empty() => {
                self.last_text = Some(text.to_string());
                Some(Output::Item {
                    op: TranscriptOp::Append,
                    item: TranscriptItem::Assistant {
                        id: new_id(),
                        ts: ts(now),
                        text: text.to_string(),
                        streaming: false,
                    },
                    delta: false,
                })
            }
            BlockKind::Thinking if !text.trim().is_empty() => Some(Output::Item {
                op: TranscriptOp::Append,
                item: TranscriptItem::Thinking {
                    id: new_id(),
                    ts: ts(now),
                    text: text.to_string(),
                    duration_ms: None,
                },
                delta: false,
            }),
            _ => None,
        }
    }

    fn tool_use(&mut self, block: &Value, now: DateTime<Utc>) -> Vec<Output> {
        let (Some(id), Some(tool)) = (s(block, "id"), s(block, "name")) else {
            return Vec::new();
        };
        if self.tools.contains_key(id) {
            return Vec::new();
        }
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        let item = TranscriptItem::Tool {
            id: id.to_string(),
            ts: ts(now),
            tool: tool.to_string(),
            title: tool_title(tool, &input, &self.cwd),
            input: input.clone(),
            status: ToolStatus::Running,
            output: None,
            output_truncated: None,
        };
        self.tools.insert(id.to_string(), item.clone());
        vec![
            Output::Item {
                op: TranscriptOp::Append,
                item,
                delta: false,
            },
            Output::ToolStarted {
                tool: tool.to_string(),
                input,
            },
        ]
    }

    fn user(&mut self, event: &Value, now: DateTime<Utc>) -> Vec<Output> {
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
        let mut out = Vec::new();
        for part in &content {
            match s(part, "type") {
                Some("tool_result") => {
                    let Some(id) = s(part, "tool_use_id") else {
                        continue;
                    };
                    let Some(TranscriptItem::Tool {
                        id,
                        ts,
                        tool,
                        input,
                        title,
                        ..
                    }) = self.tools.remove(id)
                    else {
                        continue;
                    };
                    let rejected = meta.iter().filter(|m| s(m, "id") == Some(id.as_str())).any(|m| {
                        m.get("permission_decision").and_then(|d| s(d, "decision")) == Some("reject")
                            || s(m, "non_execution_kind") == Some("user-rejected")
                    });
                    let denied = self.denied.remove(&id) || rejected;
                    let is_error = part.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    let status = if denied {
                        ToolStatus::Denied
                    } else if is_error {
                        ToolStatus::Error
                    } else {
                        ToolStatus::Done
                    };
                    let (output, truncated) =
                        truncate_tail(&result_text(part.get("content")), MAX_TOOL_OUTPUT);
                    out.push(update(TranscriptItem::Tool {
                        id,
                        ts,
                        tool: tool.clone(),
                        input,
                        title,
                        status,
                        output: Some(output),
                        output_truncated: Some(truncated),
                    }));
                    out.push(Output::ToolFinished { tool });
                }
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
            // status, thinking_tokens, permission_denied (its tool_result
            // says the same), background task bookkeeping, hooks, …
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
        }));
        out.push(Output::TurnEnded(TurnEnd {
            usage,
            last_text: self.last_text.take(),
            is_error,
        }));
        self.interrupted = false;
        self.denied.clear();
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

        fn kinds(&self) -> Vec<String> {
            self.transcript()
                .iter()
                .map(|i| match i {
                    TranscriptItem::User { .. } => "user".to_string(),
                    TranscriptItem::Assistant { .. } => "assistant".into(),
                    TranscriptItem::Thinking { .. } => "thinking".into(),
                    TranscriptItem::Tool { tool, status, .. } => format!("tool:{tool}:{status:?}"),
                    TranscriptItem::Result { is_error, .. } => format!("result:{is_error}"),
                    TranscriptItem::System { level, text, .. } => format!("system:{level:?}:{text}"),
                })
                .collect()
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
        // A subagent's stream isn't the main conversation.
        assert!(n
            .feed(&json!({"type": "assistant", "parent_tool_use_id": "toolu_task",
                          "message": {"id": "m", "content": [{"type": "text", "text": "sub"}]}}), now)
            .is_empty());
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
}
