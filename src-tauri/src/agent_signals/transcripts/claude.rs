//! Claude Code transcripts: `~/.claude/projects/<encoded cwd>/<session>.jsonl`
//! plus subagent transcripts in `<session>/subagents/*.jsonl`.
//!
//! Format notes (verified on Claude Code 2.1.319 transcripts):
//! - The project dir is the cwd with every non-alphanumeric char replaced
//!   by `-` (`/Users/me/.phasr/worktrees/<id>` →
//!   `-Users-me--phasr-worktrees-<id>`); names over 200 chars are cut and
//!   suffixed with a hash we can't reproduce, so those are found by prefix.
//! - Claude writes one `"type":"assistant"` line PER CONTENT BLOCK, each
//!   repeating the same `message.id` and the same `message.usage`. Summing
//!   lines double/triple-counts; usage is kept per message id (latest wins).
//! - `usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens` split
//!   cache writes by TTL (priced differently); older lines only have
//!   `cache_creation_input_tokens`.
//! - A `"type":"cost-state"` line is appended when a session ends, carrying
//!   Claude's own `totalCostUSD` for it. When present (and no assistant
//!   message came after it, i.e. not resumed since) it's used for that
//!   session instead of the price table.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::agent_signals::pricing;
use crate::agent_signals::state::short_path;
use crate::domain::usage::{TaskUsage, UsageSource};

use super::{
    cwd_variants, mtime, parse_ts, read_new_lines, AgentFileEdit, AgentSummary, LineCursor,
    NewLines, SummarySource, TokenCounts, TranscriptTarget,
};

const MAX_DIR_NAME: usize = 200;
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// Claude's project-dir name for `cwd` (without its >200-char hash suffix).
pub fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

#[derive(Debug, Clone)]
struct FileState {
    cursor: LineCursor,
    session: String,
    /// A main-session transcript (not a subagent's).
    top_level: bool,
}

#[derive(Debug, Clone)]
struct MessageUsage {
    session: String,
    model: String,
    tokens: TokenCounts,
}

#[derive(Debug, Clone, Default)]
struct SessionCost {
    /// (`totalCostUSD`, `hasUnknownModelCost`) from the last `cost-state`.
    recorded: Option<(f64, bool)>,
    /// An assistant message arrived after that `cost-state` (resumed).
    stale: bool,
}

pub struct ClaudeReader {
    target: TranscriptTarget,
    projects_root: PathBuf,
    files: HashMap<PathBuf, FileState>,
    messages: HashMap<String, MessageUsage>,
    sessions: HashMap<String, SessionCost>,
    last_model: Option<String>,
    summary: Option<(String, DateTime<Utc>)>,
    edits: Vec<AgentFileEdit>,
    newest: Option<(std::time::SystemTime, PathBuf)>,
    cwd_str: String,
}

impl ClaudeReader {
    pub fn new(target: TranscriptTarget, projects_root: PathBuf) -> Self {
        let cwd_str = target.cwd.to_string_lossy().into_owned();
        Self {
            target,
            projects_root,
            files: HashMap::new(),
            messages: HashMap::new(),
            sessions: HashMap::new(),
            last_model: None,
            summary: None,
            edits: Vec::new(),
            newest: None,
            cwd_str,
        }
    }

    pub fn add_session_ids(&mut self, ids: &[String]) {
        for id in ids {
            if !self.target.session_ids.contains(id) {
                self.target.session_ids.push(id.clone());
            }
        }
    }

    pub fn has_sessions(&self) -> bool {
        self.files.values().any(|f| f.top_level)
    }

    fn reset(&mut self) {
        let target = self.target.clone();
        let root = self.projects_root.clone();
        *self = Self::new(target, root);
    }

    /// The project dirs this cwd maps to (as-is and canonical).
    fn project_dirs(&self) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();
        for cwd in cwd_variants(&self.target.cwd) {
            let encoded = encode_project_dir(&cwd.to_string_lossy());
            if encoded.len() <= MAX_DIR_NAME {
                out.push(self.projects_root.join(encoded));
            } else if let Ok(entries) = std::fs::read_dir(&self.projects_root) {
                let prefix = format!("{}-", &encoded[..MAX_DIR_NAME]);
                out.extend(
                    entries
                        .flatten()
                        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
                        .map(|e| e.path()),
                );
            }
        }
        out.dedup();
        out
    }

    fn wants_session(&self, session: &str, path: &Path) -> bool {
        if !self.target.shared_cwd {
            return true;
        }
        if self.target.session_ids.iter().any(|s| s == session) {
            return true;
        }
        // Shared checkout: only sessions touched since this task started.
        match (self.target.since, mtime(path)) {
            (Some(since), Some(modified)) => DateTime::<Utc>::from(modified) >= since,
            _ => false,
        }
    }

    fn discover(&mut self) {
        for dir in self.project_dirs() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "jsonl") {
                    let session = path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    self.track(path, session, true);
                } else if path.is_dir() {
                    let session = entry.file_name().to_string_lossy().into_owned();
                    let Ok(subs) = std::fs::read_dir(path.join("subagents")) else {
                        continue;
                    };
                    for sub in subs.flatten() {
                        let sub = sub.path();
                        if sub.extension().is_some_and(|e| e == "jsonl") {
                            self.track(sub, session.clone(), false);
                        }
                    }
                }
            }
        }
    }

    fn track(&mut self, path: PathBuf, session: String, top_level: bool) {
        if self.files.contains_key(&path) || !self.wants_session(&session, &path) {
            return;
        }
        self.files.insert(
            path,
            FileState {
                cursor: LineCursor::default(),
                session,
                top_level,
            },
        );
    }

    pub fn refresh(&mut self) {
        self.discover();
        let paths: Vec<PathBuf> = self.files.keys().cloned().collect();
        for path in paths {
            let Some(state) = self.files.get_mut(&path) else {
                continue;
            };
            let mut cursor = state.cursor.clone();
            let (session, top_level) = (state.session.clone(), state.top_level);
            match read_new_lines(&path, &mut cursor) {
                Ok(NewLines::Lines(lines)) => {
                    if let Some(state) = self.files.get_mut(&path) {
                        state.cursor = cursor;
                    }
                    if !lines.is_empty() {
                        if let Some(m) = mtime(&path) {
                            if self.newest.as_ref().is_none_or(|(t, _)| m >= *t) && top_level {
                                self.newest = Some((m, path.clone()));
                            }
                        }
                    }
                    for line in lines {
                        self.ingest(&line, &session, top_level);
                    }
                }
                Ok(NewLines::Truncated) => {
                    // A rewritten transcript: start over from scratch.
                    self.reset();
                    self.discover();
                    return self.refresh_after_reset();
                }
                Err(_) => {}
            }
        }
    }

    /// One plain pass after a reset (no recursion into another reset).
    fn refresh_after_reset(&mut self) {
        let paths: Vec<PathBuf> = self.files.keys().cloned().collect();
        for path in paths {
            let Some(state) = self.files.get(&path).cloned() else {
                continue;
            };
            let mut cursor = state.cursor;
            if let Ok(NewLines::Lines(lines)) = read_new_lines(&path, &mut cursor) {
                if let Some(s) = self.files.get_mut(&path) {
                    s.cursor = cursor;
                }
                for line in lines {
                    self.ingest(&line, &state.session, state.top_level);
                }
            }
        }
    }

    fn ingest(&mut self, line: &str, file_session: &str, top_level: bool) {
        // Cheap pre-filter: most lines are attachments/snapshots.
        if !line.contains("\"assistant\"") && !line.contains("\"cost-state\"") {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        match v.get("type").and_then(Value::as_str) {
            Some("assistant") => self.ingest_assistant(&v, file_session, top_level),
            Some("cost-state") => {
                let session = v
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or(file_session)
                    .to_string();
                if let Some(total) = v.get("totalCostUSD").and_then(Value::as_f64) {
                    let unknown = v
                        .get("hasUnknownModelCost")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    self.sessions.insert(
                        session,
                        SessionCost {
                            recorded: Some((total, unknown)),
                            stale: false,
                        },
                    );
                }
            }
            _ => {}
        }
    }

    fn ingest_assistant(&mut self, v: &Value, session: &str, top_level: bool) {
        let Some(message) = v.get("message") else {
            return;
        };
        let at = parse_ts(v).unwrap_or_else(Utc::now);
        let model = message
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if let Some(usage) = message.get("usage") {
            let id = message
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| v.get("uuid").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            if !id.is_empty() {
                self.messages.insert(
                    id,
                    MessageUsage {
                        session: session.to_string(),
                        model: model.clone(),
                        tokens: tokens_from_usage(usage),
                    },
                );
                if let Some(cost) = self.sessions.get_mut(session) {
                    cost.stale = true;
                }
            }
        }
        if !model.is_empty() && model != SYNTHETIC_MODEL {
            self.last_model = Some(model);
        }
        let sidechain = v.get("isSidechain").and_then(Value::as_bool).unwrap_or(false);
        let Some(content) = message.get("content").and_then(Value::as_array) else {
            return;
        };
        for block in content {
            match block.get("type").and_then(Value::as_str) {
                Some("text") if top_level && !sidechain => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        let text = text.trim();
                        if !text.is_empty() {
                            self.summary = Some((text.to_string(), at));
                        }
                    }
                }
                Some("tool_use") => {
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                    if matches!(name, "Edit" | "Write" | "MultiEdit" | "NotebookEdit") {
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        let path = input
                            .get("file_path")
                            .or_else(|| input.get("notebook_path"))
                            .and_then(Value::as_str);
                        if let Some(path) = path {
                            self.edits.push(AgentFileEdit {
                                path: short_path(path, &self.cwd_str),
                                at,
                                tool: name.to_string(),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }

    pub fn usage(&self, now: DateTime<Utc>) -> Option<TaskUsage> {
        if self.messages.is_empty() {
            return None;
        }
        let mut totals = TokenCounts::default();
        // session → model → tokens
        let mut by_session: HashMap<&str, HashMap<&str, TokenCounts>> = HashMap::new();
        for m in self.messages.values() {
            totals.add(&m.tokens);
            by_session
                .entry(m.session.as_str())
                .or_default()
                .entry(m.model.as_str())
                .or_default()
                .add(&m.tokens);
        }
        let mut cost: Option<i64> = Some(0);
        let sessions: HashSet<&str> = by_session.keys().copied().collect();
        for session in sessions {
            let recorded = self
                .sessions
                .get(session)
                .filter(|c| !c.stale)
                .and_then(|c| c.recorded)
                .filter(|(_, unknown)| !unknown);
            let session_cost = match recorded {
                Some((usd, _)) => Some((usd * 1_000_000.0).round() as i64),
                None => by_session[session]
                    .iter()
                    .filter(|(_, tokens)| !tokens.is_zero())
                    .try_fold(0i64, |acc, (model, tokens)| {
                        pricing::cost_micros(model, tokens).map(|c| acc + c)
                    }),
            };
            cost = match (cost, session_cost) {
                (Some(a), Some(b)) => Some(a + b),
                _ => None,
            };
        }
        Some(TaskUsage {
            source: UsageSource::Claude,
            model: self.last_model.clone(),
            input_tokens: totals.input,
            output_tokens: totals.output,
            cache_read_tokens: totals.cache_read,
            cache_write_tokens: totals.cache_write(),
            cost_usd_micros: cost,
            updated_at: now,
            transcript_path: self
                .newest
                .as_ref()
                .map(|(_, p)| p.to_string_lossy().into_owned()),
        })
    }

    pub fn summary(&self) -> Option<AgentSummary> {
        self.summary.as_ref().map(|(text, at)| AgentSummary {
            text: text.clone(),
            at: *at,
            source: SummarySource::Transcript,
        })
    }

    pub fn edits(&self) -> &[AgentFileEdit] {
        &self.edits
    }
}

fn int(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn tokens_from_usage(usage: &Value) -> TokenCounts {
    let (w5, w1) = match usage.get("cache_creation") {
        Some(split) if split.is_object() => (
            int(split, "ephemeral_5m_input_tokens"),
            int(split, "ephemeral_1h_input_tokens"),
        ),
        _ => (int(usage, "cache_creation_input_tokens"), 0),
    };
    TokenCounts {
        input: int(usage, "input_tokens"),
        output: int(usage, "output_tokens"),
        cache_read: int(usage, "cache_read_input_tokens"),
        cache_write_5m: w5,
        cache_write_1h: w1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Agent;
    use std::io::Write;

    fn target(cwd: &Path) -> TranscriptTarget {
        TranscriptTarget {
            agent: Agent::Claude,
            cwd: cwd.to_path_buf(),
            since: None,
            session_ids: vec![],
            shared_cwd: false,
        }
    }

    /// One content block of an assistant message, the way Claude writes it:
    /// every block of a message repeats the id and the usage.
    fn assistant(id: &str, model: &str, ts: &str, block: Value, output: i64) -> String {
        serde_json::json!({
            "type": "assistant", "isSidechain": false, "timestamp": ts,
            "message": {
                "id": id, "model": model, "role": "assistant", "content": [block],
                "usage": {
                    "input_tokens": 2, "output_tokens": output,
                    "cache_read_input_tokens": 100, "cache_creation_input_tokens": 40,
                    "cache_creation": {"ephemeral_5m_input_tokens": 10, "ephemeral_1h_input_tokens": 30}
                }
            }
        })
        .to_string()
    }

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("projects");
        let cwd = PathBuf::from("/Users/me/.phasr/worktrees/task-1");
        let project = root.join(encode_project_dir(&cwd.to_string_lossy()));
        std::fs::create_dir_all(&project).unwrap();
        (dir, root, project)
    }

    #[test]
    fn path_encoding_matches_claude() {
        // Observed on this machine: ~/.claude/projects/-Users-rishabh--phasr-worktrees-<uuid>
        assert_eq!(
            encode_project_dir("/Users/rishabh/.phasr/worktrees/4263a9e8-8ddf"),
            "-Users-rishabh--phasr-worktrees-4263a9e8-8ddf"
        );
        assert_eq!(
            encode_project_dir("/Users/me/Library/Application Support/x_y"),
            "-Users-me-Library-Application-Support-x-y"
        );
    }

    #[test]
    fn usage_is_deduped_by_message_id_and_summary_and_edits_read() {
        let (_d, root, project) = setup();
        let lines = [
            assistant("msg_1", "claude-sonnet-5", "2026-11-09T10:00:00Z", serde_json::json!({"type":"thinking","thinking":""}), 50),
            assistant("msg_1", "claude-sonnet-5", "2026-11-09T10:00:01Z", serde_json::json!({"type":"tool_use","name":"Edit","input":{"file_path":"/Users/me/.phasr/worktrees/task-1/src/a.ts"}}), 50),
            assistant("msg_2", "claude-sonnet-5", "2026-11-09T10:00:05Z", serde_json::json!({"type":"text","text":"All done."}), 7),
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#.to_string(),
        ];
        std::fs::write(project.join("sess-a.jsonl"), lines.join("\n") + "\n").unwrap();

        let mut reader = ClaudeReader::new(target(Path::new("/Users/me/.phasr/worktrees/task-1")), root);
        reader.refresh();
        let usage = reader.usage(Utc::now()).unwrap();
        // Two messages, not three lines.
        assert_eq!(usage.input_tokens, 4);
        assert_eq!(usage.output_tokens, 57);
        assert_eq!(usage.cache_read_tokens, 200);
        assert_eq!(usage.cache_write_tokens, 80);
        assert_eq!(usage.model.as_deref(), Some("claude-sonnet-5"));
        // $2/$10 MTok, read 0.2, write 5m 2.5, 1h 4 → µ$
        let expected = 2.0 * 4.0 + 10.0 * 57.0 + 0.2 * 200.0 + 2.5 * 20.0 + 4.0 * 60.0;
        assert_eq!(usage.cost_usd_micros, Some(expected as i64));
        assert_eq!(reader.summary().unwrap().text, "All done.");
        assert_eq!(reader.edits()[0].path, "src/a.ts");
        assert!(reader.has_sessions());
    }

    #[test]
    fn incremental_refresh_and_unknown_model_cost() {
        let (_d, root, project) = setup();
        let path = project.join("sess-b.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "{}", assistant("m1", "claude-sonnet-5", "2026-11-09T10:00:00Z", serde_json::json!({"type":"text","text":"one"}), 1)).unwrap();
        let mut reader = ClaudeReader::new(target(Path::new("/Users/me/.phasr/worktrees/task-1")), root);
        reader.refresh();
        assert_eq!(reader.usage(Utc::now()).unwrap().output_tokens, 1);
        assert!(reader.usage(Utc::now()).unwrap().cost_usd_micros.is_some());

        writeln!(f, "{}", assistant("m2", "claude-opus-5-5", "2026-11-09T10:01:00Z", serde_json::json!({"type":"text","text":"two"}), 2)).unwrap();
        reader.refresh();
        let usage = reader.usage(Utc::now()).unwrap();
        assert_eq!(usage.output_tokens, 3);
        // An unpriced model in the mix → no cost at all, not a partial one.
        assert_eq!(usage.cost_usd_micros, None);
        assert_eq!(reader.summary().unwrap().text, "two");
    }

    #[test]
    fn recorded_session_cost_wins_until_the_session_resumes() {
        let (_d, root, project) = setup();
        let path = project.join("sess-c.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "{}", assistant("m1", "claude-opus-5-5", "2026-11-09T10:00:00Z", serde_json::json!({"type":"text","text":"x"}), 1)).unwrap();
        writeln!(f, r#"{{"type":"cost-state","sessionId":"sess-c","totalCostUSD":0.25,"hasUnknownModelCost":false}}"#).unwrap();
        let mut reader = ClaudeReader::new(target(Path::new("/Users/me/.phasr/worktrees/task-1")), root);
        reader.refresh();
        assert_eq!(reader.usage(Utc::now()).unwrap().cost_usd_micros, Some(250_000));
        // Resumed: a newer message makes the recorded total stale.
        writeln!(f, "{}", assistant("m2", "claude-opus-5-5", "2026-11-09T11:00:00Z", serde_json::json!({"type":"text","text":"y"}), 1)).unwrap();
        reader.refresh();
        assert_eq!(reader.usage(Utc::now()).unwrap().cost_usd_micros, None);
    }

    #[test]
    fn subagent_usage_counts_but_not_toward_the_summary() {
        let (_d, root, project) = setup();
        std::fs::write(
            project.join("sess-d.jsonl"),
            assistant("m1", "claude-sonnet-5", "2026-11-09T10:00:00Z", serde_json::json!({"type":"text","text":"main"}), 1) + "\n",
        )
        .unwrap();
        let subs = project.join("sess-d").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        std::fs::write(
            subs.join("agent-x.jsonl"),
            assistant("m9", "claude-sonnet-5", "2026-11-09T10:05:00Z", serde_json::json!({"type":"text","text":"sub"}), 5) + "\n",
        )
        .unwrap();
        let mut reader = ClaudeReader::new(target(Path::new("/Users/me/.phasr/worktrees/task-1")), root);
        reader.refresh();
        assert_eq!(reader.usage(Utc::now()).unwrap().output_tokens, 6);
        assert_eq!(reader.summary().unwrap().text, "main");
    }

    #[test]
    fn shared_cwd_reads_only_this_tasks_sessions() {
        let (_d, root, project) = setup();
        std::fs::write(
            project.join("users-own.jsonl"),
            assistant("u1", "claude-sonnet-5", "2026-01-01T00:00:00Z", serde_json::json!({"type":"text","text":"old"}), 100) + "\n",
        )
        .unwrap();
        std::fs::write(
            project.join("task-sess.jsonl"),
            assistant("t1", "claude-sonnet-5", "2026-11-09T10:00:00Z", serde_json::json!({"type":"text","text":"mine"}), 1) + "\n",
        )
        .unwrap();
        let mut t = target(Path::new("/Users/me/.phasr/worktrees/task-1"));
        t.shared_cwd = true;
        // Both files are fresh on disk; only the session id discriminates.
        t.since = Some(Utc::now() + chrono::Duration::hours(1));
        t.session_ids = vec!["task-sess".into()];
        let mut reader = ClaudeReader::new(t, root);
        reader.refresh();
        assert_eq!(reader.usage(Utc::now()).unwrap().output_tokens, 1);
    }

    #[test]
    fn no_transcript_means_no_usage() {
        let (_d, root, _project) = setup();
        let mut reader = ClaudeReader::new(target(Path::new("/nowhere")), root);
        reader.refresh();
        assert!(reader.usage(Utc::now()).is_none());
        assert!(reader.summary().is_none());
        assert!(!reader.has_sessions());
    }
}
