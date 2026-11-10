//! Phasr's normalized transcript: the `TranscriptItem`s the UI renders
//! (spec §4), the per-task JSONL they persist to, and the tool-call title
//! formatter. Raw CLI events never leave `agent_stream`.

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_signals::state::short_path;

/// A tool's `output` is cut to this many bytes (its tail: a command's
/// last lines and errors are what the UI shows), with `outputTruncated`.
pub const MAX_TOOL_OUTPUT: usize = 64 * 1024;
/// `get_transcript` returns at most this many items (the newest), so a
/// months-long task can't make one IPC call ship hundreds of megabytes.
pub const MAX_ITEMS: usize = 5_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ToolStatus {
    Running,
    Done,
    Error,
    Denied,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SystemLevel {
    Info,
    Error,
}

/// One row of the transcript. The wire shape is spec §4 exactly:
/// `kind`-tagged, camelCase fields, optional fields omitted when absent.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum TranscriptItem {
    User {
        id: String,
        ts: String,
        text: String,
    },
    Assistant {
        id: String,
        ts: String,
        text: String,
        streaming: bool,
    },
    Thinking {
        id: String,
        ts: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
    },
    Tool {
        /// The tool_use id.
        id: String,
        ts: String,
        tool: String,
        input: Value,
        title: String,
        status: ToolStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        output_truncated: Option<bool>,
    },
    Result {
        id: String,
        ts: String,
        duration_ms: u64,
        cost_usd: Option<f64>,
        is_error: bool,
    },
    System {
        id: String,
        ts: String,
        level: SystemLevel,
        text: String,
    },
}

impl TranscriptItem {
    pub fn id(&self) -> &str {
        match self {
            Self::User { id, .. }
            | Self::Assistant { id, .. }
            | Self::Thinking { id, .. }
            | Self::Tool { id, .. }
            | Self::Result { id, .. }
            | Self::System { id, .. } => id,
        }
    }

    pub fn system(level: SystemLevel, text: impl Into<String>, ts: String) -> Self {
        Self::System {
            id: new_id(),
            ts,
            level,
            text: text.into(),
        }
    }

    /// The item as it reads once nothing will ever update it again: no
    /// longer streaming, and a tool whose result can't come any more (its
    /// process is gone) marked failed.
    pub fn settled(mut self) -> Self {
        match &mut self {
            Self::Assistant { streaming, .. } => *streaming = false,
            Self::Tool { status, .. } if *status == ToolStatus::Running => {
                *status = ToolStatus::Error
            }
            _ => {}
        }
        self
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TranscriptOp {
    Append,
    Update,
}

/// `phasr://transcript`'s payload.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptEvent {
    pub task_id: String,
    pub op: TranscriptOp,
    pub item: TranscriptItem,
}

pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub fn now_ts() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The last `max` bytes of `text`, cut on a char boundary, and whether
/// anything was cut.
pub fn truncate_tail(text: &str, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (text[start..].to_string(), true)
}

fn str_input<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// First line, at most `max` chars, ellipsised when cut.
fn clip(text: &str, max: usize) -> String {
    let first = text.lines().next().unwrap_or("").trim();
    let more = text.trim().lines().count() > 1;
    if first.chars().count() > max {
        format!("{}…", first.chars().take(max.saturating_sub(1)).collect::<String>())
    } else if more {
        format!("{first} …")
    } else {
        first.to_string()
    }
}

/// The one-line title of a tool call ("Editing src/a.ts", "Running pnpm
/// test"), paths shortened against the task's `cwd`.
pub fn tool_title(tool: &str, input: &Value, cwd: &str) -> String {
    let path = || {
        str_input(input, "file_path")
            .or_else(|| str_input(input, "notebook_path"))
            .or_else(|| str_input(input, "path"))
            .map(|p| short_path(p, cwd))
    };
    let quoted = |key: &str| str_input(input, key).map(|p| format!("\"{}\"", clip(p, 60)));
    match tool {
        "Read" => path().map_or("Reading a file".into(), |p| format!("Reading {p}")),
        "Edit" | "MultiEdit" | "NotebookEdit" => {
            path().map_or("Editing a file".into(), |p| format!("Editing {p}"))
        }
        "Write" => path().map_or("Writing a file".into(), |p| format!("Writing {p}")),
        "Bash" => str_input(input, "command")
            .map_or("Running a command".into(), |c| format!("Running {}", clip(c, 80))),
        "Grep" => match (quoted("pattern"), path()) {
            (Some(p), Some(dir)) => format!("Searching {p} in {dir}"),
            (Some(p), None) => format!("Searching {p}"),
            _ => "Searching".into(),
        },
        "Glob" => quoted("pattern").map_or("Finding files".into(), |p| format!("Finding {p}")),
        "WebFetch" => str_input(input, "url")
            .map_or("Fetching a page".into(), |u| format!("Fetching {}", clip(u, 80))),
        "WebSearch" => {
            quoted("query").map_or("Searching the web".into(), |q| format!("Searching the web for {q}"))
        }
        "Task" | "Agent" => str_input(input, "description")
            .map_or("Running a subagent".into(), |d| format!("Running a subagent: {}", clip(d, 60))),
        "TodoWrite" => "Updating the plan".into(),
        other => match other.strip_prefix("mcp__") {
            Some(rest) => format!("Using {}", rest.replace("__", " ")),
            None => format!("Using {other}"),
        },
    }
}

/// One line of a task's transcript file.
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    op: TranscriptOp,
    item: TranscriptItem,
}

/// `<log dir>/<task id>.transcript.jsonl`: every appended item and every
/// FINAL update, one JSON record per line. Streaming deltas aren't written
/// (the update that ends the stream carries the whole text).
#[derive(Debug, Clone)]
pub struct TranscriptStore {
    dir: PathBuf,
}

impl TranscriptStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn path(&self, task_id: &str) -> PathBuf {
        self.dir.join(format!("{task_id}.transcript.jsonl"))
    }

    /// Append one record. Best-effort: a full disk loses history, never the
    /// live session.
    pub fn append(&self, task_id: &str, op: TranscriptOp, item: &TranscriptItem) {
        let line = match serde_json::to_string(&Record {
            op,
            item: item.clone(),
        }) {
            Ok(line) => line,
            Err(err) => {
                eprintln!("[transcript] {task_id}: can't encode an item: {err}");
                return;
            }
        };
        let written = std::fs::create_dir_all(&self.dir).and_then(|_| {
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.path(task_id))?;
            file.write_all(format!("{line}\n").as_bytes())
        });
        if let Err(err) = written {
            eprintln!("[transcript] {task_id}: can't write the transcript: {err}");
        }
    }

    /// The transcript with every update folded into its item, in append
    /// order — the newest `MAX_ITEMS` of it, behind a note when older ones
    /// were left out. A torn last line (a crash mid-write) or any other
    /// unreadable line is skipped.
    pub fn load(&self, task_id: &str) -> Vec<TranscriptItem> {
        fold(&self.path(task_id))
    }
}

fn fold(path: &Path) -> Vec<TranscriptItem> {
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut order: Vec<String> = Vec::new();
    let mut items: HashMap<String, TranscriptItem> = HashMap::new();
    for line in std::io::BufReader::new(file).split(b'\n') {
        let Ok(line) = line else { break };
        let Ok(record) = serde_json::from_slice::<Record>(&line) else {
            continue;
        };
        let id = record.item.id().to_string();
        match (record.op, items.contains_key(&id)) {
            (_, true) => {
                items.insert(id, record.item);
            }
            // An update for an item never appended (its append was lost):
            // it still belongs in the transcript.
            (_, false) => {
                order.push(id.clone());
                items.insert(id, record.item);
            }
        }
    }
    let skipped = order.len().saturating_sub(MAX_ITEMS);
    let mut out = Vec::with_capacity(order.len() - skipped + 1);
    if skipped > 0 {
        out.push(TranscriptItem::System {
            id: "phasr-earlier".into(),
            ts: items
                .get(&order[skipped])
                .map(|i| item_ts(i).to_string())
                .unwrap_or_default(),
            level: SystemLevel::Info,
            text: format!("{skipped} earlier items aren't shown."),
        });
    }
    out.extend(order.into_iter().skip(skipped).filter_map(|id| items.remove(&id)));
    out
}

fn item_ts(item: &TranscriptItem) -> &str {
    match item {
        TranscriptItem::User { ts, .. }
        | TranscriptItem::Assistant { ts, .. }
        | TranscriptItem::Thinking { ts, .. }
        | TranscriptItem::Tool { ts, .. }
        | TranscriptItem::Result { ts, .. }
        | TranscriptItem::System { ts, .. } => ts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(id: &str, status: ToolStatus, output: Option<&str>) -> TranscriptItem {
        TranscriptItem::Tool {
            id: id.into(),
            ts: "2026-11-11T00:00:00.000Z".into(),
            tool: "Bash".into(),
            input: json!({"command": "pnpm test"}),
            title: "Running pnpm test".into(),
            status,
            output: output.map(str::to_string),
            output_truncated: output.map(|_| false),
        }
    }

    /// The exact §4 wire shape: `kind` tag, camelCase, absent optionals
    /// omitted, `costUsd` always present.
    #[test]
    fn items_serialize_to_the_spec_shape() {
        let v = serde_json::to_value(tool("toolu_1", ToolStatus::Running, None)).unwrap();
        assert_eq!(
            v,
            json!({"kind": "tool", "id": "toolu_1", "ts": "2026-11-11T00:00:00.000Z",
                   "tool": "Bash", "input": {"command": "pnpm test"},
                   "title": "Running pnpm test", "status": "running"})
        );
        let v = serde_json::to_value(tool("t", ToolStatus::Denied, Some("x"))).unwrap();
        assert_eq!(v["status"], "denied");
        assert_eq!(v["output"], "x");
        assert_eq!(v["outputTruncated"], false);

        let result = TranscriptItem::Result {
            id: "r".into(),
            ts: "t".into(),
            duration_ms: 23_000,
            cost_usd: None,
            is_error: false,
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"kind": "result", "id": "r", "ts": "t", "durationMs": 23000,
                   "costUsd": null, "isError": false})
        );
        let thinking = TranscriptItem::Thinking {
            id: "th".into(),
            ts: "t".into(),
            text: String::new(),
            duration_ms: Some(4000),
        };
        assert_eq!(serde_json::to_value(thinking).unwrap()["durationMs"], 4000);
        let system = TranscriptItem::system(SystemLevel::Error, "boom", "t".into());
        let v = serde_json::to_value(system).unwrap();
        assert_eq!((v["kind"].as_str(), v["level"].as_str()), (Some("system"), Some("error")));
        let assistant = TranscriptItem::Assistant {
            id: "a".into(),
            ts: "t".into(),
            text: "hi".into(),
            streaming: true,
        };
        assert_eq!(
            serde_json::to_value(&assistant).unwrap(),
            json!({"kind": "assistant", "id": "a", "ts": "t", "text": "hi", "streaming": true})
        );
        let event = TranscriptEvent {
            task_id: "task".into(),
            op: TranscriptOp::Update,
            item: assistant,
        };
        let v = serde_json::to_value(event).unwrap();
        assert_eq!((v["taskId"].as_str(), v["op"].as_str()), (Some("task"), Some("update")));
    }

    #[test]
    fn titles_per_tool_and_a_generic_fallback() {
        let cwd = "/work/tree";
        let t = |tool: &str, input: Value| tool_title(tool, &input, cwd);
        assert_eq!(t("Read", json!({"file_path": "/work/tree/src/a.ts"})), "Reading src/a.ts");
        assert_eq!(t("Edit", json!({"file_path": "/elsewhere/b.rs"})), "Editing /elsewhere/b.rs");
        assert_eq!(t("MultiEdit", json!({"file_path": "/work/tree/c"})), "Editing c");
        assert_eq!(t("Write", json!({"file_path": "/work/tree/new.md"})), "Writing new.md");
        assert_eq!(t("Bash", json!({"command": "pnpm test src/auth\necho done"})), "Running pnpm test src/auth …");
        assert_eq!(t("Bash", json!({})), "Running a command");
        assert_eq!(t("Grep", json!({"pattern": "TODO", "path": "/work/tree/src"})), "Searching \"TODO\" in src");
        assert_eq!(t("Grep", json!({"pattern": "x"})), "Searching \"x\"");
        assert_eq!(t("Glob", json!({"pattern": "**/*.ts"})), "Finding \"**/*.ts\"");
        assert_eq!(t("WebFetch", json!({"url": "https://example.com"})), "Fetching https://example.com");
        assert_eq!(t("WebSearch", json!({"query": "tauri 2"})), "Searching the web for \"tauri 2\"");
        assert_eq!(t("Task", json!({"description": "Find callers"})), "Running a subagent: Find callers");
        assert_eq!(t("mcp__github__create_issue", json!({})), "Using github create_issue");
        assert_eq!(t("Skill", json!({})), "Using Skill");
        let long = "x".repeat(200);
        assert_eq!(t("Bash", json!({"command": long})).chars().count(), "Running ".len() + 80);
    }

    #[test]
    fn output_keeps_its_tail_on_a_char_boundary() {
        assert_eq!(truncate_tail("short", 10), ("short".into(), false));
        let (tail, cut) = truncate_tail("aé€b", 4);
        assert!(cut);
        assert_eq!(tail, "€b", "never splits a char: the é is dropped whole");
        let (tail, cut) = truncate_tail(&"line\n".repeat(20_000), MAX_TOOL_OUTPUT);
        assert!(cut && tail.len() <= MAX_TOOL_OUTPUT);
    }

    /// Appends and updates fold into one item per id, in append order; a
    /// torn line is skipped; a task with no file has an empty transcript.
    #[test]
    fn the_jsonl_round_trips_with_updates_folded() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().join("logs"));
        assert!(store.load("t").is_empty());
        let user = TranscriptItem::User {
            id: "u1".into(),
            ts: "t".into(),
            text: "run the tests".into(),
        };
        store.append("t", TranscriptOp::Append, &user);
        store.append("t", TranscriptOp::Append, &tool("toolu_1", ToolStatus::Running, None));
        store.append("t", TranscriptOp::Update, &tool("toolu_1", ToolStatus::Done, Some("ok")));
        // A crash mid-write leaves half a record.
        std::fs::OpenOptions::new()
            .append(true)
            .open(store.path("t"))
            .unwrap()
            .write_all(b"{\"op\":\"append\",\"item\":{\"kind\":\"us")
            .unwrap();
        let folded = store.load("t");
        assert_eq!(folded, vec![user, tool("toolu_1", ToolStatus::Done, Some("ok"))]);
    }

    #[test]
    fn a_huge_transcript_returns_its_newest_items_behind_a_note() {
        let dir = tempfile::tempdir().unwrap();
        let store = TranscriptStore::new(dir.path().to_path_buf());
        for i in 0..MAX_ITEMS + 3 {
            let item = TranscriptItem::User {
                id: format!("u{i}"),
                ts: format!("t{i}"),
                text: "x".into(),
            };
            store.append("t", TranscriptOp::Append, &item);
        }
        let folded = store.load("t");
        assert_eq!(folded.len(), MAX_ITEMS + 1);
        match &folded[0] {
            TranscriptItem::System { text, ts, .. } => {
                assert_eq!(text, "3 earlier items aren't shown.");
                assert_eq!(ts, "t3");
            }
            other => panic!("expected the note, got {other:?}"),
        }
        assert_eq!(folded[1].id(), "u3");
        assert_eq!(folded.last().unwrap().id(), format!("u{}", MAX_ITEMS + 2));
    }

    #[test]
    fn settled_items_stop_streaming_and_orphaned_tools_fail() {
        let a = TranscriptItem::Assistant {
            id: "a".into(),
            ts: "t".into(),
            text: "half".into(),
            streaming: true,
        };
        assert!(matches!(a.settled(), TranscriptItem::Assistant { streaming: false, .. }));
        assert!(matches!(
            tool("x", ToolStatus::Running, None).settled(),
            TranscriptItem::Tool { status: ToolStatus::Error, .. }
        ));
        assert!(matches!(
            tool("x", ToolStatus::Denied, None).settled(),
            TranscriptItem::Tool { status: ToolStatus::Denied, .. }
        ));
    }
}
