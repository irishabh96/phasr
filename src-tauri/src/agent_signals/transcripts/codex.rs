//! Codex rollouts: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`.
//!
//! Format notes (verified on codex-cli 0.165 rollouts):
//! - Line 1 is `{"type":"session_meta","payload":{"id","cwd",…}}`; a file is
//!   this task's when `payload.cwd` is the task's cwd.
//! - `{"type":"event_msg","payload":{"type":"token_count","info":{
//!   "total_token_usage":{input_tokens, cached_input_tokens,
//!   cache_write_input_tokens, output_tokens, …}}}}` is a running total for
//!   the session, so only the LAST one per file counts. Its `input_tokens`
//!   INCLUDES the cached part (OpenAI convention); it's split here so
//!   `TaskUsage.input_tokens` means uncached input for every agent.
//! - The model is on `turn_context.payload.model`.
//! - A resumed session can be a new file carrying the same session id; per
//!   id only the file with the largest total counts.
//! - Day directories are local dates, so the scan starts a day early.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Duration, Local, NaiveDate, Utc};
use serde_json::Value;

use crate::agent_signals::pricing;
use crate::agent_signals::state::short_path;
use crate::domain::usage::{TaskUsage, UsageSource};

use super::{
    cwd_variants, mtime, parse_ts, read_new_lines, AgentFileEdit, AgentSummary, LineCursor,
    NewLines, SummarySource, TokenCounts, TranscriptTarget,
};

#[derive(Debug, Default, Clone)]
struct RolloutFile {
    cursor: LineCursor,
    session_id: String,
    /// (tokens, total) from the last token_count line.
    last_total: Option<(TokenCounts, i64)>,
    model: Option<String>,
}

pub struct CodexReader {
    target: TranscriptTarget,
    sessions_root: PathBuf,
    /// Every rollout looked at: `Some(session id)` = ours, `None` = not.
    classified: HashMap<PathBuf, Option<String>>,
    files: HashMap<PathBuf, RolloutFile>,
    last_model: Option<String>,
    summary: Option<(String, DateTime<Utc>)>,
    edits: Vec<AgentFileEdit>,
    newest: Option<(std::time::SystemTime, PathBuf)>,
    cwds: Vec<PathBuf>,
    cwd_str: String,
}

impl CodexReader {
    pub fn new(target: TranscriptTarget, sessions_root: PathBuf) -> Self {
        let cwds = cwd_variants(&target.cwd);
        let cwd_str = target.cwd.to_string_lossy().into_owned();
        Self {
            target,
            sessions_root,
            classified: HashMap::new(),
            files: HashMap::new(),
            last_model: None,
            summary: None,
            edits: Vec::new(),
            newest: None,
            cwds,
            cwd_str,
        }
    }

    pub fn has_sessions(&self) -> bool {
        !self.files.is_empty()
    }

    fn day_dirs(&self) -> Vec<PathBuf> {
        let today = Local::now().date_naive();
        let start: NaiveDate = self
            .target
            .since
            .map(|s| s.with_timezone(&Local).date_naive())
            .unwrap_or(today)
            - Duration::days(1);
        let mut out = Vec::new();
        let mut day = start;
        // Bounded: a task older than a year only scans its last year.
        let floor = today - Duration::days(366);
        if day < floor {
            day = floor;
        }
        while day <= today + Duration::days(1) {
            out.push(
                self.sessions_root
                    .join(day.format("%Y").to_string())
                    .join(day.format("%m").to_string())
                    .join(day.format("%d").to_string()),
            );
            day += Duration::days(1);
        }
        out
    }

    fn cwd_matches(&self, cwd: &str) -> bool {
        let candidate = Path::new(cwd);
        let canonical = candidate.canonicalize().ok();
        self.cwds
            .iter()
            .any(|c| c == candidate || canonical.as_deref() == Some(c.as_path()))
    }

    fn discover(&mut self) {
        for dir in self.day_dirs() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_none_or(|e| e != "jsonl")
                    || self.classified.contains_key(&path)
                {
                    continue;
                }
                let Some(meta) = first_line(&path) else {
                    // Header not fully written yet: look again next time.
                    continue;
                };
                let ours = self.classify(&meta);
                if let Some(id) = &ours {
                    self.files.insert(
                        path.clone(),
                        RolloutFile {
                            session_id: id.clone(),
                            ..Default::default()
                        },
                    );
                }
                self.classified.insert(path, ours);
            }
        }
    }

    fn classify(&self, meta: &Value) -> Option<String> {
        if meta.get("type").and_then(Value::as_str) != Some("session_meta") {
            return None;
        }
        let payload = meta.get("payload")?;
        let cwd = payload.get("cwd").and_then(Value::as_str)?;
        if !self.cwd_matches(cwd) {
            return None;
        }
        if self.target.shared_cwd {
            // The user's own checkout: only sessions started with the task.
            let started = parse_ts(payload).or_else(|| parse_ts(meta))?;
            let since = self.target.since?;
            if started < since - Duration::seconds(5) {
                return None;
            }
        }
        Some(
            payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        )
    }

    pub fn refresh(&mut self) {
        self.discover();
        let paths: Vec<PathBuf> = self.files.keys().cloned().collect();
        for path in paths {
            let Some(file) = self.files.get(&path) else {
                continue;
            };
            let mut cursor = file.cursor.clone();
            match read_new_lines(&path, &mut cursor) {
                Ok(NewLines::Lines(lines)) => {
                    if !lines.is_empty() {
                        if let Some(m) = mtime(&path) {
                            if self.newest.as_ref().is_none_or(|(t, _)| m >= *t) {
                                self.newest = Some((m, path.clone()));
                            }
                        }
                    }
                    for line in &lines {
                        self.ingest(&path, line);
                    }
                    if let Some(file) = self.files.get_mut(&path) {
                        file.cursor = cursor;
                    }
                }
                Ok(NewLines::Truncated) => {
                    // Rewritten: re-read this file from the top.
                    if let Some(file) = self.files.get_mut(&path) {
                        let id = file.session_id.clone();
                        *file = RolloutFile {
                            session_id: id,
                            ..Default::default()
                        };
                    }
                }
                Err(_) => {}
            }
        }
    }

    fn ingest(&mut self, path: &Path, line: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let at = parse_ts(&v).unwrap_or_else(Utc::now);
        let payload = v.get("payload").cloned().unwrap_or(Value::Null);
        let ptype = payload.get("type").and_then(Value::as_str);
        match (v.get("type").and_then(Value::as_str), ptype) {
            (Some("event_msg"), Some("token_count")) => {
                let Some(total) = payload.pointer("/info/total_token_usage") else {
                    return;
                };
                let int = |k: &str| total.get(k).and_then(Value::as_i64).unwrap_or(0);
                let cached = int("cached_input_tokens");
                let tokens = TokenCounts {
                    input: (int("input_tokens") - cached).max(0),
                    output: int("output_tokens"),
                    cache_read: cached,
                    cache_write_5m: int("cache_write_input_tokens"),
                    cache_write_1h: 0,
                };
                let sum = int("input_tokens") + int("output_tokens");
                if let Some(file) = self.files.get_mut(path) {
                    file.last_total = Some((tokens, sum));
                }
            }
            (Some("turn_context"), _) => {
                if let Some(model) = payload.get("model").and_then(Value::as_str) {
                    if let Some(file) = self.files.get_mut(path) {
                        file.model = Some(model.to_string());
                    }
                    self.last_model = Some(model.to_string());
                }
            }
            (Some("event_msg"), Some("task_complete")) => {
                if let Some(text) = payload.get("last_agent_message").and_then(Value::as_str) {
                    self.set_summary(text, at);
                }
            }
            (Some("event_msg"), Some("agent_message")) => {
                if let Some(text) = payload.get("message").and_then(Value::as_str) {
                    self.set_summary(text, at);
                }
            }
            (Some("response_item"), Some("message"))
                if payload.get("role").and_then(Value::as_str) == Some("assistant") =>
            {
                let text: Vec<&str> = payload
                    .get("content")
                    .and_then(Value::as_array)
                    .map(|blocks| {
                        blocks
                            .iter()
                            .filter(|b| b.get("type").and_then(Value::as_str) == Some("output_text"))
                            .filter_map(|b| b.get("text").and_then(Value::as_str))
                            .collect()
                    })
                    .unwrap_or_default();
                self.set_summary(&text.join("\n"), at);
            }
            (Some("response_item"), Some("custom_tool_call" | "function_call")) => {
                let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
                if !name.contains("apply_patch") {
                    return;
                }
                let body = payload
                    .get("input")
                    .or_else(|| payload.get("arguments"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                for path in patch_paths(body) {
                    self.edits.push(AgentFileEdit {
                        path: short_path(&path, &self.cwd_str),
                        at,
                        tool: "apply_patch".into(),
                    });
                }
            }
            _ => {}
        }
    }

    fn set_summary(&mut self, text: &str, at: DateTime<Utc>) {
        let text = text.trim();
        if !text.is_empty() && self.summary.as_ref().is_none_or(|(_, prev)| at >= *prev) {
            self.summary = Some((text.to_string(), at));
        }
    }

    pub fn usage(&self, now: DateTime<Utc>) -> Option<TaskUsage> {
        // Per session id, the file with the largest running total.
        let mut best: HashMap<&str, (&TokenCounts, i64, Option<&str>)> = HashMap::new();
        for file in self.files.values() {
            let Some((tokens, sum)) = &file.last_total else {
                continue;
            };
            let entry = best
                .entry(file.session_id.as_str())
                .or_insert((tokens, *sum, file.model.as_deref()));
            if *sum > entry.1 {
                *entry = (tokens, *sum, file.model.as_deref());
            }
        }
        if best.is_empty() {
            return None;
        }
        let mut totals = TokenCounts::default();
        let mut cost: Option<i64> = Some(0);
        for (tokens, _, model) in best.values() {
            totals.add(tokens);
            let session_cost = model.and_then(|m| pricing::cost_micros(m, tokens));
            cost = match (cost, session_cost) {
                (Some(a), Some(b)) => Some(a + b),
                _ => None,
            };
        }
        Some(TaskUsage {
            source: UsageSource::Codex,
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

/// The first line of a rollout, if complete (a header mid-write isn't).
fn first_line(path: &Path) -> Option<Value> {
    use std::io::{BufRead, BufReader, Read};
    let file = std::fs::File::open(path).ok()?;
    let mut line = String::new();
    // session_meta can carry long instructions; cap the read.
    BufReader::new(file.take(512 * 1024))
        .read_line(&mut line)
        .ok()?;
    if !line.ends_with('\n') {
        return None;
    }
    serde_json::from_str(line.trim_end()).ok()
}

/// File paths named in an apply_patch body.
fn patch_paths(body: &str) -> Vec<String> {
    body.lines()
        .filter_map(|l| {
            let l = l.trim();
            ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
                .iter()
                .find_map(|prefix| l.strip_prefix(prefix))
                .map(|p| p.trim().to_string())
        })
        .filter(|p| !p.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Agent;
    use serde_json::json;

    fn day_dir(root: &Path) -> PathBuf {
        let today = Local::now().date_naive();
        let dir = root
            .join(today.format("%Y").to_string())
            .join(today.format("%m").to_string())
            .join(today.format("%d").to_string());
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn meta(id: &str, cwd: &str) -> String {
        json!({"timestamp": Utc::now().to_rfc3339(), "type": "session_meta",
               "payload": {"id": id, "timestamp": Utc::now().to_rfc3339(), "cwd": cwd, "originator": "codex-tui"}})
        .to_string()
    }

    fn token_count(input: i64, cached: i64, output: i64) -> String {
        json!({"timestamp": "2026-11-09T10:00:00Z", "type": "event_msg", "payload": {"type": "token_count",
            "info": {"total_token_usage": {"input_tokens": input, "cached_input_tokens": cached,
                "cache_write_input_tokens": 0, "output_tokens": output, "reasoning_output_tokens": 0,
                "total_tokens": input + output}, "last_token_usage": {"input_tokens": 1}}}})
        .to_string()
    }

    fn target(cwd: &str) -> TranscriptTarget {
        TranscriptTarget {
            agent: Agent::Codex,
            cwd: PathBuf::from(cwd),
            since: Some(Utc::now() - chrono::Duration::hours(1)),
            session_ids: vec![],
            shared_cwd: false,
        }
    }

    #[test]
    fn last_token_count_wins_and_other_cwds_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        let day = day_dir(&root);
        let mine = [
            meta("s1", "/w/task"),
            json!({"type":"turn_context","payload":{"model":"gpt-5","cwd":"/w/task"}}).to_string(),
            token_count(1000, 800, 50),
            json!({"timestamp":"2026-11-09T10:00:01Z","type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch\n*** Update File: /w/task/src/lib.rs\n@@\n*** End Patch"}}).to_string(),
            token_count(5000, 4000, 300),
            json!({"timestamp":"2026-11-09T10:00:02Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"Patched lib.rs."}}).to_string(),
        ];
        std::fs::write(day.join("rollout-a.jsonl"), mine.join("\n") + "\n").unwrap();
        let other = [meta("s2", "/elsewhere"), token_count(9_999_999, 0, 9_999_999)];
        std::fs::write(day.join("rollout-b.jsonl"), other.join("\n") + "\n").unwrap();

        let mut reader = CodexReader::new(target("/w/task"), root);
        reader.refresh();
        let usage = reader.usage(Utc::now()).unwrap();
        assert_eq!(usage.source, UsageSource::Codex);
        // Last running total only, with cached input split out.
        assert_eq!(usage.input_tokens, 1000);
        assert_eq!(usage.cache_read_tokens, 4000);
        assert_eq!(usage.output_tokens, 300);
        assert_eq!(usage.model.as_deref(), Some("gpt-5"));
        // 1.25×1000 + 10×300 + 0.125×4000
        assert_eq!(usage.cost_usd_micros, Some(1250 + 3000 + 500));
        assert_eq!(reader.summary().unwrap().text, "Patched lib.rs.");
        assert_eq!(reader.edits()[0].path, "src/lib.rs");
        assert!(reader.has_sessions());
    }

    #[test]
    fn resumed_session_files_are_not_double_counted_and_unknown_models_are_unpriced() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        let day = day_dir(&root);
        let model = json!({"type":"turn_context","payload":{"model":"gpt-6-astra"}}).to_string();
        std::fs::write(
            day.join("rollout-1.jsonl"),
            [meta("same", "/w/t"), model.clone(), token_count(100, 0, 10)].join("\n") + "\n",
        )
        .unwrap();
        std::fs::write(
            day.join("rollout-2.jsonl"),
            [meta("same", "/w/t"), model, token_count(300, 0, 30)].join("\n") + "\n",
        )
        .unwrap();
        let mut reader = CodexReader::new(target("/w/t"), root);
        reader.refresh();
        let usage = reader.usage(Utc::now()).unwrap();
        assert_eq!(usage.input_tokens, 300);
        assert_eq!(usage.output_tokens, 30);
        assert_eq!(usage.cost_usd_micros, None);
    }

    #[test]
    fn incremental_and_header_mid_write() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        let day = day_dir(&root);
        let path = day.join("rollout-x.jsonl");
        // Header not yet terminated: not classified, retried later.
        std::fs::write(&path, meta("s", "/w/x")).unwrap();
        let mut reader = CodexReader::new(target("/w/x"), root);
        reader.refresh();
        assert!(reader.usage(Utc::now()).is_none());
        std::fs::write(&path, meta("s", "/w/x") + "\n" + &token_count(10, 0, 1) + "\n").unwrap();
        reader.refresh();
        assert_eq!(reader.usage(Utc::now()).unwrap().output_tokens, 1);
    }

    #[test]
    fn patch_paths_parse() {
        assert_eq!(
            patch_paths("*** Begin Patch\n*** Add File: a.txt\n+x\n*** Delete File: b.txt\n*** End Patch"),
            vec!["a.txt".to_string(), "b.txt".to_string()]
        );
    }
}
