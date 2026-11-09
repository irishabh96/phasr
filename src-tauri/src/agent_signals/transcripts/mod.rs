//! Incremental readers over the agents' own session transcripts: token
//! usage, the last assistant message (summary), and the files it edited.
//!
//! Each reader remembers a byte offset per file and only parses what was
//! appended since the last refresh, so a 5s refresh cadence on a multi-MB
//! transcript costs a few KB of parsing. A file that shrank (rewritten)
//! resets the reader.

pub mod claude;
pub mod codex;

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::domain::usage::TaskUsage;
use crate::domain::Agent;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct TokenCounts {
    /// Uncached input.
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write_5m: i64,
    pub cache_write_1h: i64,
}

impl TokenCounts {
    pub fn add(&mut self, other: &TokenCounts) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write_5m += other.cache_write_5m;
        self.cache_write_1h += other.cache_write_1h;
    }

    pub fn cache_write(&self) -> i64 {
        self.cache_write_5m + self.cache_write_1h
    }

    pub fn is_zero(&self) -> bool {
        *self == TokenCounts::default()
    }
}

/// Where a task's transcripts are and which of them are its own.
#[derive(Debug, Clone, PartialEq)]
pub struct TranscriptTarget {
    pub agent: Agent,
    pub cwd: PathBuf,
    /// Ignore sessions older than this. Worktree tasks use the row's
    /// `created_at` (their cwd is theirs alone); in-place tasks use the
    /// claim's `started_at`, since the repo checkout is shared with every
    /// session the user ever ran there.
    pub since: Option<DateTime<Utc>>,
    /// Session ids known to be this task's (from hooks / the DB).
    pub session_ids: Vec<String>,
    /// The cwd is the user's repo checkout (in-place task), not a worktree.
    pub shared_cwd: bool,
}

/// Roots of the agents' state dirs; overridable for tests and honouring
/// `CLAUDE_CONFIG_DIR` / `CODEX_HOME` like the CLIs do.
#[derive(Debug, Clone)]
pub struct TranscriptRoots {
    pub claude_projects: PathBuf,
    pub codex_sessions: PathBuf,
}

impl TranscriptRoots {
    pub fn from_env() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"));
        Self {
            claude_projects: claude.join("projects"),
            codex_sessions: codex_home().join("sessions"),
        }
    }
}

pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".codex")
        })
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SummarySource {
    /// The agent's transcript file.
    Transcript,
    /// The last Stop / turn-complete hook (before a transcript is readable).
    Hook,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub text: String,
    pub at: DateTime<Utc>,
    pub source: SummarySource,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentFileEdit {
    /// Relative to the task's worktree when inside it, else absolute.
    pub path: String,
    pub at: DateTime<Utc>,
    /// `Edit` | `Write` | `MultiEdit` | `NotebookEdit` | `apply_patch`.
    pub tool: String,
}

pub enum TranscriptReader {
    Claude(claude::ClaudeReader),
    Codex(codex::CodexReader),
}

impl TranscriptReader {
    /// `None` for agents whose transcripts phasr can't read.
    pub fn new(target: TranscriptTarget, roots: &TranscriptRoots) -> Option<Self> {
        match target.agent {
            Agent::Claude => Some(Self::Claude(claude::ClaudeReader::new(
                target,
                roots.claude_projects.clone(),
            ))),
            Agent::Codex => Some(Self::Codex(codex::CodexReader::new(
                target,
                roots.codex_sessions.clone(),
            ))),
            _ => None,
        }
    }

    /// Merge newly learned session ids without losing parsed state.
    pub fn add_session_ids(&mut self, ids: &[String]) {
        match self {
            Self::Claude(r) => r.add_session_ids(ids),
            Self::Codex(_) => {}
        }
    }

    pub fn refresh(&mut self) {
        match self {
            Self::Claude(r) => r.refresh(),
            Self::Codex(r) => r.refresh(),
        }
    }

    pub fn usage(&self, now: DateTime<Utc>) -> Option<TaskUsage> {
        match self {
            Self::Claude(r) => r.usage(now),
            Self::Codex(r) => r.usage(now),
        }
    }

    pub fn summary(&self) -> Option<AgentSummary> {
        match self {
            Self::Claude(r) => r.summary(),
            Self::Codex(r) => r.summary(),
        }
    }

    /// One entry per path (its latest edit), newest first.
    pub fn file_edits(&self) -> Vec<AgentFileEdit> {
        let all = match self {
            Self::Claude(r) => r.edits(),
            Self::Codex(r) => r.edits(),
        };
        latest_per_path(all)
    }

    /// Whether any session for this cwd exists — resume needs one.
    /// Whether any of the task's sessions exist. Discovery only (file
    /// names / Codex's first line) — a resume decision must not parse every
    /// transcript in full, which `refresh` would.
    pub fn has_sessions(&mut self) -> bool {
        match self {
            Self::Claude(r) => r.discover(),
            Self::Codex(r) => r.discover(),
        }
        match self {
            Self::Claude(r) => r.has_sessions(),
            Self::Codex(r) => r.has_sessions(),
        }
    }
}

fn latest_per_path(edits: &[AgentFileEdit]) -> Vec<AgentFileEdit> {
    let mut latest: HashMap<&str, &AgentFileEdit> = HashMap::new();
    for edit in edits {
        match latest.get(edit.path.as_str()) {
            Some(prev) if prev.at > edit.at => {}
            _ => {
                latest.insert(edit.path.as_str(), edit);
            }
        }
    }
    let mut out: Vec<AgentFileEdit> = latest.into_values().cloned().collect();
    out.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.path.cmp(&b.path)));
    out
}

/// Byte offset into one transcript file.
#[derive(Debug, Default, Clone)]
pub struct LineCursor {
    offset: u64,
}

pub enum NewLines {
    Lines(Vec<String>),
    /// The file is shorter than what was already read: it was rewritten.
    Truncated,
}

/// Complete lines appended since the cursor; a trailing partial line (the
/// agent mid-write) is left for next time.
pub fn read_new_lines(path: &Path, cursor: &mut LineCursor) -> std::io::Result<NewLines> {
    let mut file = std::fs::File::open(path)?;
    let len = file.metadata()?.len();
    if len < cursor.offset {
        return Ok(NewLines::Truncated);
    }
    if len == cursor.offset {
        return Ok(NewLines::Lines(Vec::new()));
    }
    file.seek(SeekFrom::Start(cursor.offset))?;
    let mut buf = Vec::with_capacity((len - cursor.offset) as usize);
    file.take(len - cursor.offset).read_to_end(&mut buf)?;
    let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n') else {
        return Ok(NewLines::Lines(Vec::new()));
    };
    let complete = &buf[..=last_nl];
    cursor.offset += complete.len() as u64;
    Ok(NewLines::Lines(
        complete
            .split(|b| *b == b'\n')
            .filter(|l| !l.is_empty())
            .map(|l| String::from_utf8_lossy(l).into_owned())
            .collect(),
    ))
}

pub fn parse_ts(v: &serde_json::Value) -> Option<DateTime<Utc>> {
    v.get("timestamp")
        .and_then(serde_json::Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
}

pub fn mtime(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// `cwd` as given and canonicalized (macOS `/var` → `/private/var`): the
/// CLIs record whichever their `getcwd` returned.
pub fn cwd_variants(cwd: &Path) -> Vec<PathBuf> {
    let mut out = vec![cwd.to_path_buf()];
    if let Ok(canonical) = cwd.canonicalize() {
        if canonical != cwd {
            out.push(canonical);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn read_new_lines_is_incremental_and_skips_partial_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.jsonl");
        let mut f = std::fs::File::create(&path).unwrap();
        write!(f, "a\nb\nparti").unwrap();
        let mut cursor = LineCursor::default();
        let NewLines::Lines(lines) = read_new_lines(&path, &mut cursor).unwrap() else {
            panic!()
        };
        assert_eq!(lines, vec!["a", "b"]);
        write!(f, "al\nc\n").unwrap();
        let NewLines::Lines(lines) = read_new_lines(&path, &mut cursor).unwrap() else {
            panic!()
        };
        assert_eq!(lines, vec!["partial", "c"]);
        std::fs::write(&path, "x\n").unwrap();
        assert!(matches!(
            read_new_lines(&path, &mut cursor).unwrap(),
            NewLines::Truncated
        ));
    }

    #[test]
    fn latest_edit_per_path_newest_first() {
        let t = |s: i64| DateTime::from_timestamp(s, 0).unwrap();
        let e = |p: &str, at: i64| AgentFileEdit {
            path: p.into(),
            at: t(at),
            tool: "Edit".into(),
        };
        let out = latest_per_path(&[e("a", 1), e("b", 2), e("a", 3)]);
        assert_eq!(out, vec![e("a", 3), e("b", 2)]);
    }
}
