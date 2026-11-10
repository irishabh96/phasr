//! Reply suggestions for a transcript-view task: the chips under the
//! composer once a turn ends (`suggest_replies`, `phasr://suggestions`).
//!
//! Two sources, merged per turn (the frontend adds its own instant
//! heuristics, `src/lib/transcript/suggest.ts`, and shows them until these
//! land):
//!
//! - **native**: the CLI's own `prompt_suggestion` line. Only a command
//!   that passes `--prompt-suggestions` gets one; Phasr doesn't add the
//!   flag (`fixtures/PROTOCOL.md`, "Prompt suggestions": it forks the
//!   session's own model, gives one 2–12 word guess, and 2.1.322 ignores
//!   the runtime pause, so the setting couldn't turn it off).
//! - **generated**: one `claude -p --model haiku` call through the user's
//!   installed CLI (their login, no API key of ours), with no tools, no
//!   session persistence and their customizations off, fed a compact
//!   summary of the turn.
//!
//! Generation only ever starts from `suggest_replies`, which the frontend
//! calls only while "Suggest replies" is on: off means no call at all. A
//! new message or turn cancels a generation in flight (process group
//! killed).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, watch};

use super::transcript::{clip, SystemLevel, ToolStatus, TranscriptItem};

pub const MAX_SUGGESTIONS: usize = 3;
/// A chip's label, in chars (the row fits three at the composer's width).
pub const MAX_LABEL: usize = 40;
/// What a chip puts in the composer, in chars.
pub const MAX_TEXT: usize = 500;
/// A Haiku call takes 2–4 s; past this the turn's moment has gone.
const GENERATE_TIMEOUT: Duration = Duration::from_secs(10);
/// `claude --help`, once per binary: a hung CLI mustn't hold a turn up.
const HELP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_USER_CHARS: usize = 1_000;
/// The END of the last message: a question or options sit there.
const MAX_ASSISTANT_CHARS: usize = 2_000;
const MAX_OUTPUT_TAIL: usize = 400;
const MAX_COMMANDS: usize = 6;
const MAX_FILES: usize = 8;
const EVENT_CAPACITY: usize = 64;

/// The system prompt of the generation call (it replaces Claude Code's own,
/// which is about using tools this call doesn't have).
const SYSTEM_PROMPT: &str = "You suggest what the USER might send next to a coding agent, \
given the latest turn of their session. Reply with ONLY a JSON array, no prose, no code fence: \
[{\"label\": \"...\", \"text\": \"...\"}]. At most 3 items, most likely first. \
label: an imperative chip label, at most 40 characters. \
text: the full message the user would send, one or two sentences, at most 300 characters. \
Be specific to this conversation: if the agent asked a question or offered options, \
turn each option into an item; if tests failed, suggest fixing them; if work is done, suggest the \
natural next step. Never generic filler (\"Continue\", \"Thanks\", \"Looks good\"). \
If nothing specific fits, reply [].";

/// Labels that say nothing about the conversation (from a model told not to).
const FILLER: &[&str] = &[
    "continue", "thanks", "thank you", "ok", "okay", "looks good", "lgtm", "great", "nice",
    "sounds good", "yes", "no",
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionSource {
    Native,
    Generated,
}

/// One chip: `label` on the chip, `text` into the composer when clicked.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub label: String,
    pub text: String,
    pub source: SuggestionSource,
}

/// `phasr://suggestions`: a turn's suggestions changed (generation finished,
/// or a native one arrived). `turn_id` is the turn's `result` item id.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SuggestionsEvent {
    pub task_id: String,
    pub turn_id: String,
    pub suggestions: Vec<Suggestion>,
}

/// What the generation call is told about the turn that just ended.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnContext {
    /// The turn's `result` item id: the cache key.
    pub turn_id: String,
    /// `None` for a turn the agent started on its own (a background
    /// command finished).
    pub user: Option<String>,
    pub assistant: Option<String>,
    pub facts: Vec<String>,
}

/// The turn that ended last, if the conversation is between turns: its
/// `result` is the last top-level one and no message was sent after it.
pub fn turn_context(items: &[TranscriptItem]) -> Option<TurnContext> {
    let is_result = |i: &TranscriptItem| matches!(i, TranscriptItem::Result { parent_id: None, .. });
    let end = items.iter().rposition(is_result)?;
    if items[end + 1..]
        .iter()
        .any(|i| matches!(i, TranscriptItem::User { parent_id: None, .. }))
    {
        return None;
    }
    let start = items[..end].iter().rposition(is_result).map_or(0, |at| at + 1);
    let turn = &items[start..end];
    let user = turn.iter().rev().find_map(|i| match i {
        TranscriptItem::User { text, parent_id: None, .. } if !text.trim().is_empty() => {
            Some(head(text.trim(), MAX_USER_CHARS))
        }
        _ => None,
    });
    let assistant = turn.iter().rev().find_map(|i| match i {
        TranscriptItem::Assistant { text, parent_id: None, .. } if !text.trim().is_empty() => {
            Some(tail(text.trim(), MAX_ASSISTANT_CHARS))
        }
        _ => None,
    });
    let failed = matches!(items[end], TranscriptItem::Result { is_error: true, .. });
    Some(TurnContext {
        turn_id: items[end].id().to_string(),
        user,
        assistant,
        facts: facts(turn, items, failed),
    })
}

fn is_edit_tool(tool: &str) -> bool {
    matches!(tool, "Edit" | "MultiEdit" | "Write" | "NotebookEdit")
}

/// A test run, by its command line (`pnpm test`, `cargo test`, `pytest`,
/// `go test ./...`, `npx vitest`, `rspec`).
pub fn is_test_command(command: &str) -> bool {
    let c = command.to_lowercase();
    ["test", "jest", "rspec", "mocha", "playwright"]
        .iter()
        .any(|w| c.contains(w))
}

/// Facts about the turn the model can't see from the text alone: what was
/// edited, what ran and how it went, whether a PR exists, how it ended.
fn facts(turn: &[TranscriptItem], all: &[TranscriptItem], failed: bool) -> Vec<String> {
    let mut edited: Vec<String> = Vec::new();
    let mut commands: Vec<String> = Vec::new();
    let mut out: Vec<String> = Vec::new();
    let mut interrupted = false;
    for item in turn {
        match item {
            TranscriptItem::Tool { tool, title, input, status, output, .. } => {
                if is_edit_tool(tool) && *status == ToolStatus::Done {
                    // "Editing src/a.ts": the path is already worktree-relative.
                    let path = title.split_once(' ').map_or(title.as_str(), |(_, p)| p).to_string();
                    if !edited.contains(&path) {
                        edited.push(path);
                    }
                }
                if tool == "Bash" {
                    let command = input.get("command").and_then(Value::as_str).unwrap_or("");
                    let command = clip(command, 120);
                    let how = match status {
                        ToolStatus::Done if item_background(item) => "started in the background",
                        ToolStatus::Done => "ok",
                        ToolStatus::Error => "FAILED",
                        ToolStatus::Denied => "denied by the user",
                        ToolStatus::Running => "still running",
                    };
                    let mut line = format!("ran `{command}`: {how}");
                    if *status == ToolStatus::Error {
                        if let Some(output) = output.as_deref().filter(|o| !o.trim().is_empty()) {
                            let (tail_text, _) = super::transcript::truncate_tail(output.trim(), MAX_OUTPUT_TAIL);
                            line.push_str(&format!("\n  output tail: {}", tail_text.replace('\n', "\n  ")));
                        }
                        if is_test_command(&command) {
                            out.push(format!("tests failed: `{command}`"));
                        }
                    }
                    commands.push(line);
                } else if *status == ToolStatus::Denied {
                    out.push(format!("the user denied: {title}"));
                }
            }
            TranscriptItem::System { level: SystemLevel::Info, text, .. } if text == "Interrupted" => {
                interrupted = true;
            }
            TranscriptItem::System { level: SystemLevel::Error, text, .. } => {
                out.push(format!("error: {}", clip(text, 200)));
            }
            _ => {}
        }
    }
    let mut facts = Vec::new();
    if !edited.is_empty() {
        let more = edited.len().saturating_sub(MAX_FILES);
        let mut list = edited.into_iter().take(MAX_FILES).collect::<Vec<_>>().join(", ");
        if more > 0 {
            list.push_str(&format!(" and {more} more"));
        }
        facts.push(format!("edited: {list}"));
    }
    let skip = commands.len().saturating_sub(MAX_COMMANDS);
    facts.extend(commands.into_iter().skip(skip));
    facts.extend(out);
    match pull_request_url(all) {
        Some(url) => facts.push(format!("a pull request exists: {url}")),
        None => facts.push("no pull request yet".into()),
    }
    if interrupted {
        facts.push("the user interrupted this turn".into());
    } else if failed {
        facts.push("the turn ended with an error".into());
    }
    facts
}

fn item_background(item: &TranscriptItem) -> bool {
    matches!(item, TranscriptItem::Tool { background: Some(true), .. })
}

/// The last GitHub PR URL any command printed in the conversation
/// (`gh pr create` prints it).
fn pull_request_url(items: &[TranscriptItem]) -> Option<String> {
    items.iter().rev().find_map(|i| match i {
        TranscriptItem::Tool { tool, output: Some(output), .. } if tool == "Bash" => output
            .split_whitespace()
            .rev()
            .find(|w| w.starts_with("https://github.com/") && w.contains("/pull/"))
            .map(str::to_string),
        _ => None,
    })
}

/// The first `max` chars, ellipsised when cut.
fn head(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max).collect::<String>())
}

/// The last `max` chars, ellipsised when cut.
fn tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    format!("…{}", text.chars().skip(count - max).collect::<String>())
}

/// The generation call's user message.
pub fn build_prompt(ctx: &TurnContext) -> String {
    let mut prompt = String::from("The latest turn of a coding session between a USER and a coding agent.\n\n");
    match &ctx.user {
        Some(user) => prompt.push_str(&format!("USER:\n{user}\n\n")),
        None => prompt.push_str("USER: (no message: the agent continued on its own)\n\n"),
    }
    match &ctx.assistant {
        Some(text) => prompt.push_str(&format!("AGENT (its last message, may be cut at the start):\n{text}\n\n")),
        None => prompt.push_str("AGENT: (no text)\n\n"),
    }
    if !ctx.facts.is_empty() {
        prompt.push_str("FACTS:\n");
        for fact in &ctx.facts {
            prompt.push_str(&format!("- {fact}\n"));
        }
    }
    prompt
}

/// A chip label: one line, no wrapping quotes or trailing period, at most
/// `MAX_LABEL` chars (cut on a word, ellipsised).
pub fn clamp_label(label: &str) -> String {
    let one_line = label.split_whitespace().collect::<Vec<_>>().join(" ");
    let quote = |c: char| c == '"' || c == '\'' || c == '`' || c.is_whitespace();
    // A leading dot is content (".env"); a trailing one is punctuation.
    let trimmed = one_line
        .trim_start_matches(quote)
        .trim_end_matches(|c: char| quote(c) || c == '.');
    if trimmed.chars().count() <= MAX_LABEL {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(MAX_LABEL - 1).collect();
    let cut = match cut.rfind(' ') {
        Some(at) if at >= MAX_LABEL / 2 => &cut[..at],
        _ => cut.as_str(),
    };
    format!("{}…", cut.trim_end_matches([',', ';', ':', ' ']))
}

fn clamp_text(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_TEXT {
        return text.to_string();
    }
    text.chars().take(MAX_TEXT).collect::<String>().trim_end().to_string()
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn same(a: &Suggestion, b: &Suggestion) -> bool {
    a.label.eq_ignore_ascii_case(&b.label) || a.text.trim().eq_ignore_ascii_case(b.text.trim())
}

/// The model's reply as suggestions: a JSON array of `{label, text}` (a
/// code fence or prose around it is tolerated). `None` when it isn't one:
/// the whole reply is dropped, never half-used. Items without text, filler
/// and duplicates are skipped; labels and texts are clamped; at most
/// `MAX_SUGGESTIONS`.
pub fn parse_suggestions(reply: &str) -> Option<Vec<Suggestion>> {
    let start = reply.find('[')?;
    let end = reply.rfind(']')?;
    if end < start {
        return None;
    }
    let items: Vec<Value> = serde_json::from_str(&reply[start..=end]).ok()?;
    let mut out: Vec<Suggestion> = Vec::new();
    for item in items {
        let text = item.get("text").and_then(Value::as_str).map(clamp_text).unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        let label = item
            .get("label")
            .and_then(Value::as_str)
            .map(clamp_label)
            .filter(|l| !l.is_empty())
            .unwrap_or_else(|| clamp_label(&text));
        if FILLER.contains(&label.to_lowercase().as_str()) {
            continue;
        }
        let suggestion = Suggestion { label, text, source: SuggestionSource::Generated };
        if out.iter().any(|o| same(o, &suggestion)) {
            continue;
        }
        out.push(suggestion);
        if out.len() == MAX_SUGGESTIONS {
            break;
        }
    }
    Some(out)
}

/// The CLI's own `prompt_suggestion` (a predicted next prompt, "open a
/// draft PR") as a chip. Its text stays as predicted; the label is
/// capitalized like every other chip.
pub fn native_suggestion(text: &str) -> Option<Suggestion> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let text = text.trim_matches(|c: char| c == '"' || c == '\'');
    if text.is_empty() {
        return None;
    }
    Some(Suggestion {
        label: clamp_label(&capitalize(text)),
        text: clamp_text(text),
        source: SuggestionSource::Native,
    })
}

/// One finished generation call.
#[derive(Debug, Clone, PartialEq)]
pub struct Generated {
    pub suggestions: Vec<Suggestion>,
    pub cost_usd: Option<f64>,
}

/// `claude -p --output-format json`'s stdout: one `result` object. `None`
/// unless it's a successful one whose text parses (`parse_suggestions`).
pub fn parse_cli_output(stdout: &str) -> Option<Generated> {
    let line = stdout.lines().rev().find(|l| !l.trim().is_empty())?;
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    let reply = v.get("result").and_then(Value::as_str)?;
    Some(Generated {
        suggestions: parse_suggestions(reply)?,
        cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
    })
}

fn has_flag(help: &str, flag: &str) -> bool {
    help.split(|c: char| c.is_whitespace() || c == ',').any(|w| w == flag)
}

/// The generation call's arguments for a CLI whose `--help` is `help`.
/// `None` when it can't promise "no tools, nothing saved" (an older CLI):
/// then nothing runs. The isolation flags (skip the user's settings,
/// CLAUDE.md, hooks, plugins and MCP servers) are added when known.
///
/// `--version` can't be the probe: 2.1.322 prints it and exits 0 whatever
/// unknown option comes with it.
pub fn generation_args(help: &str) -> Option<Vec<String>> {
    const REQUIRED: [&str; 5] = ["--tools", "--no-session-persistence", "--model", "--output-format", "--system-prompt"];
    if !REQUIRED.iter().all(|f| has_flag(help, f)) {
        return None;
    }
    let mut args: Vec<String> = ["-p", "--model", "haiku", "--output-format", "json", "--tools", "", "--no-session-persistence"]
        .into_iter()
        .map(String::from)
        .collect();
    if has_flag(help, "--setting-sources") {
        args.extend(["--setting-sources".into(), String::new()]);
    }
    for flag in ["--safe-mode", "--strict-mcp-config"] {
        if has_flag(help, flag) {
            args.push(flag.into());
        }
    }
    args.extend(["--system-prompt".into(), SYSTEM_PROMPT.into()]);
    Some(args)
}

/// `generation_args` for `program`, probed once per binary.
async fn args_for(program: &Path, env: &[(String, String)]) -> Option<Vec<String>> {
    static PROBED: LazyLock<Mutex<HashMap<PathBuf, Option<Vec<String>>>>> = LazyLock::new(Default::default);
    if let Some(args) = PROBED.lock().get(program) {
        return args.clone();
    }
    let output = crate::util::proc::run_with_timeout(
        &program.to_string_lossy(),
        &["--help"],
        None,
        env,
        HELP_TIMEOUT,
    )
    .await
    .ok()
    .filter(|o| o.status.success())?;
    let args = generation_args(&String::from_utf8_lossy(&output.stdout));
    PROBED.lock().insert(program.to_path_buf(), args.clone());
    args
}

/// Where the call runs: an empty directory of Phasr's, so no project's
/// CLAUDE.md or settings apply.
fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("phasr-suggest");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn debug(message: impl std::fmt::Display) {
    if cfg!(debug_assertions) {
        eprintln!("[suggest] {message}");
    }
}

/// Resolves once `cancel` fires or its sender is gone (the job's entry was
/// replaced or removed).
async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

/// Run one generation call: `prompt` on stdin, killed (its whole process
/// group) after `timeout` or on `cancel`. `None` for anything but a clean,
/// parseable answer.
pub async fn run_generation(
    program: &Path,
    args: &[String],
    env: &[(String, String)],
    prompt: String,
    timeout: Duration,
    mut cancel: watch::Receiver<bool>,
) -> Option<Generated> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(scratch_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear()
        // Every early return drops the child; it never outlives the call.
        .kill_on_drop(true);
    for (key, value) in env {
        cmd.env(key, value);
    }
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            debug(format!("couldn't start {}: {err}", program.display()));
            return None;
        }
    };
    let pgid = child.id();
    if let Some(mut stdin) = child.stdin.take() {
        // Its own task: a child that writes before it reads can't deadlock
        // us. Dropping the pipe is the EOF that starts the call.
        tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
        });
    }
    let kill = |why: &str| {
        debug(format!("generation {why}; killing it"));
        #[cfg(unix)]
        if let Some(pgid) = pgid {
            crate::util::proc::signal_process_group(pgid, libc::SIGKILL);
        }
    };
    tokio::select! {
        output = child.wait_with_output() => {
            let output = output.ok()?;
            if !output.status.success() {
                debug(format!("generation exited with {}", output.status));
                return None;
            }
            parse_cli_output(&String::from_utf8_lossy(&output.stdout))
        }
        _ = tokio::time::sleep(timeout) => {
            kill("timed out");
            None
        }
        _ = cancelled(&mut cancel) => {
            kill("cancelled");
            None
        }
    }
}

/// Which `claude` the generation runs.
enum Cli {
    /// The user's, on their login PATH, with the terminal's environment.
    Installed,
    /// Tests: this binary, with a minimal environment.
    #[cfg(test)]
    At(PathBuf),
}

struct Job {
    id: u64,
    done: watch::Receiver<bool>,
    /// Dropping it (the entry was reset or removed) cancels the call.
    _cancel: watch::Sender<bool>,
}

/// One task's suggestions for its latest turn.
struct Entry {
    turn_id: String,
    native: Option<Suggestion>,
    /// `Some` once generation finished (empty when it failed or found
    /// nothing): never retried for the same turn.
    generated: Option<Vec<Suggestion>>,
    job: Option<Job>,
}

impl Entry {
    fn new(turn_id: &str) -> Self {
        Self { turn_id: turn_id.to_string(), native: None, generated: None, job: None }
    }

    /// The native guess first, then the generated ones it doesn't repeat.
    fn merged(&self) -> Vec<Suggestion> {
        let mut out: Vec<Suggestion> = self.native.iter().cloned().collect();
        for g in self.generated.iter().flatten() {
            if !out.iter().any(|o| same(o, g)) {
                out.push(g.clone());
            }
        }
        out.truncate(MAX_SUGGESTIONS);
        out
    }
}

/// Every task's suggestions: cached per turn, generated single-flight.
pub struct Suggester {
    tasks: Mutex<HashMap<String, Entry>>,
    events: broadcast::Sender<SuggestionsEvent>,
    cli: Cli,
    timeout: Duration,
    next_job: AtomicU64,
}

impl Default for Suggester {
    fn default() -> Self {
        Self::new()
    }
}

impl Suggester {
    pub fn new() -> Self {
        Self::with_cli(Cli::Installed, GENERATE_TIMEOUT)
    }

    #[cfg(test)]
    fn with_program(program: PathBuf, timeout: Duration) -> Self {
        Self::with_cli(Cli::At(program), timeout)
    }

    fn with_cli(cli: Cli, timeout: Duration) -> Self {
        let (events, _rx) = broadcast::channel(EVENT_CAPACITY);
        Self { tasks: Mutex::new(HashMap::new()), events, cli, timeout, next_job: AtomicU64::new(1) }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SuggestionsEvent> {
        self.events.subscribe()
    }

    fn publish(&self, task_id: &str, entry: &Entry) {
        let _ = self.events.send(SuggestionsEvent {
            task_id: task_id.to_string(),
            turn_id: entry.turn_id.clone(),
            suggestions: entry.merged(),
        });
    }

    /// A turn ended (its `result` item is `turn_id`): what an earlier turn
    /// had is gone, and a native suggestion now belongs to this one.
    pub fn turn_ended(&self, task_id: &str, turn_id: &str) {
        let mut tasks = self.tasks.lock();
        if tasks.get(task_id).is_some_and(|e| e.turn_id == turn_id) {
            return;
        }
        tasks.insert(task_id.to_string(), Entry::new(turn_id));
    }

    /// The CLI's own suggestion for the turn that just ended.
    pub fn native(&self, task_id: &str, text: &str) {
        let Some(suggestion) = native_suggestion(text) else {
            return;
        };
        let mut tasks = self.tasks.lock();
        // Only after a turn ended: one arriving mid-turn is stale.
        let Some(entry) = tasks.get_mut(task_id) else {
            return;
        };
        entry.native = Some(suggestion);
        self.publish(task_id, entry);
    }

    /// The user sent a message or a turn started: the last turn's
    /// suggestions are moot, and a generation still running is killed.
    pub fn cancel(&self, task_id: &str) {
        self.tasks.lock().remove(task_id);
    }

    /// The suggestions for `ctx`'s turn: cached, joined while in flight, or
    /// generated now (one call per turn however many ask). `env` is added
    /// to the call's environment (the Claude API key the user set, if any).
    pub async fn suggest(self: &Arc<Self>, task_id: &str, ctx: TurnContext, env: Vec<(String, String)>) -> Vec<Suggestion> {
        let turn_id = ctx.turn_id.clone();
        let mut done = {
            let mut tasks = self.tasks.lock();
            let entry = tasks.entry(task_id.to_string()).or_insert_with(|| Entry::new(&turn_id));
            if entry.turn_id != turn_id {
                *entry = Entry::new(&turn_id);
            }
            if entry.generated.is_some() {
                return entry.merged();
            }
            match &entry.job {
                Some(job) => job.done.clone(),
                None => {
                    let (done_tx, done_rx) = watch::channel(false);
                    let (cancel_tx, cancel_rx) = watch::channel(false);
                    let id = self.next_job.fetch_add(1, Ordering::Relaxed);
                    entry.job = Some(Job { id, done: done_rx.clone(), _cancel: cancel_tx });
                    let this = self.clone();
                    let task = task_id.to_string();
                    tokio::spawn(async move {
                        let started = Instant::now();
                        let generated = this.generate(&ctx, env, cancel_rx).await;
                        if let Some(g) = &generated {
                            debug(format!(
                                "task {task}: {} suggestion(s) in {} ms, ${:.5}",
                                g.suggestions.len(),
                                started.elapsed().as_millis(),
                                g.cost_usd.unwrap_or(0.0),
                            ));
                        }
                        {
                            let mut tasks = this.tasks.lock();
                            // Unless a new turn replaced it meanwhile.
                            if let Some(entry) = tasks
                                .get_mut(&task)
                                .filter(|e| e.job.as_ref().is_some_and(|j| j.id == id))
                            {
                                entry.generated = Some(generated.map(|g| g.suggestions).unwrap_or_default());
                                entry.job = None;
                                this.publish(&task, entry);
                            }
                        }
                        let _ = done_tx.send(true);
                    });
                    done_rx
                }
            }
        };
        while !*done.borrow_and_update() {
            if done.changed().await.is_err() {
                break;
            }
        }
        self.tasks
            .lock()
            .get(task_id)
            .filter(|e| e.turn_id == turn_id)
            .map(Entry::merged)
            .unwrap_or_default()
    }

    async fn generate(
        &self,
        ctx: &TurnContext,
        extra_env: Vec<(String, String)>,
        cancel: watch::Receiver<bool>,
    ) -> Option<Generated> {
        let (program, mut env) = match &self.cli {
            Cli::Installed => {
                let path = crate::pty::login_path().await;
                let program = crate::launcher::which_in("claude", std::ffi::OsStr::new(&path))?;
                // The terminal's environment, like the task's own stream.
                let shell = crate::pty::resolve_shell();
                let mut env: Vec<(String, String)> = crate::pty::terminal_env(&shell)
                    .into_iter()
                    .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
                    .filter(|(k, _)| k != "PATH")
                    .collect();
                env.push(("PATH".into(), path));
                (program, env)
            }
            #[cfg(test)]
            Cli::At(program) => (program.clone(), vec![("PATH".into(), "/usr/bin:/bin".into())]),
        };
        env.extend(extra_env);
        let args = args_for(&program, &env).await?;
        run_generation(&program, &args, &env, build_prompt(ctx), self.timeout, cancel).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ts() -> String {
        "2026-11-11T10:00:00.000Z".into()
    }
    fn user(id: &str, text: &str) -> TranscriptItem {
        TranscriptItem::User { id: id.into(), ts: ts(), text: text.into(), parent_id: None }
    }
    fn assistant(id: &str, text: &str) -> TranscriptItem {
        TranscriptItem::Assistant { id: id.into(), ts: ts(), text: text.into(), streaming: false, parent_id: None }
    }
    fn result(id: &str, is_error: bool) -> TranscriptItem {
        TranscriptItem::Result { id: id.into(), ts: ts(), duration_ms: 1, cost_usd: None, is_error, parent_id: None }
    }
    fn tool(id: &str, tool_name: &str, input: Value, title: &str, status: ToolStatus, output: Option<&str>) -> TranscriptItem {
        let mut item = TranscriptItem::tool(id, ts(), tool_name, input, title.into(), None);
        if let TranscriptItem::Tool { status: s, output: o, .. } = &mut item {
            *s = status;
            *o = output.map(str::to_string);
        }
        item
    }

    #[test]
    fn the_context_is_the_last_ended_turn_with_its_facts() {
        let items = vec![
            user("u0", "earlier"),
            tool("b0", "Bash", json!({"command": "gh pr create --fill"}), "Running gh pr create", ToolStatus::Done,
                 Some("https://github.com/acme/app/pull/42\n")),
            result("r0", false),
            user("u1", "Add a login page"),
            tool("e1", "Edit", json!({"file_path": "/w/src/Login.tsx"}), "Editing src/Login.tsx", ToolStatus::Done, None),
            tool("e2", "Write", json!({"file_path": "/w/src/routes.ts"}), "Writing src/routes.ts", ToolStatus::Done, None),
            tool("t1", "Bash", json!({"command": "pnpm test src/auth"}), "Running pnpm test src/auth", ToolStatus::Error,
                 Some("✓ a\n✗ redirects after login\nTests: 1 failed")),
            tool("d1", "Bash", json!({"command": "rm -rf dist"}), "Running rm -rf dist", ToolStatus::Denied, None),
            assistant("a1", "Done. Want me to open a draft PR, or also handle the mobile deep-link case?"),
            result("r1", false),
        ];
        let ctx = turn_context(&items).unwrap();
        assert_eq!(ctx.turn_id, "r1");
        assert_eq!(ctx.user.as_deref(), Some("Add a login page"));
        assert!(ctx.assistant.as_deref().unwrap().ends_with("deep-link case?"));
        assert_eq!(ctx.facts[0], "edited: src/Login.tsx, src/routes.ts");
        assert!(ctx.facts[1].starts_with("ran `pnpm test src/auth`: FAILED\n  output tail: "), "{:?}", ctx.facts);
        assert!(ctx.facts[1].contains("Tests: 1 failed"));
        assert_eq!(ctx.facts[2], "ran `rm -rf dist`: denied by the user");
        assert!(ctx.facts.contains(&"tests failed: `pnpm test src/auth`".to_string()));
        // The PR from an earlier turn still counts.
        assert!(ctx.facts.contains(&"a pull request exists: https://github.com/acme/app/pull/42".to_string()));

        let prompt = build_prompt(&ctx);
        assert!(prompt.contains("USER:\nAdd a login page"));
        assert!(prompt.contains("- edited: src/Login.tsx, src/routes.ts"));
    }

    #[test]
    fn no_context_mid_turn_or_before_any_turn_ended() {
        assert_eq!(turn_context(&[user("u", "hi")]), None);
        let queued = vec![user("u", "hi"), result("r", false), user("u2", "next")];
        assert_eq!(turn_context(&queued), None);
        // An autonomous turn (no message) and how turns end.
        let items = vec![
            user("u", "hi"),
            result("r", false),
            TranscriptItem::system(SystemLevel::Info, "Interrupted", ts()),
            result("r2", false),
        ];
        let ctx = turn_context(&items).unwrap();
        assert_eq!((ctx.turn_id.as_str(), ctx.user.as_deref()), ("r2", None));
        assert!(ctx.facts.contains(&"the user interrupted this turn".to_string()));
        assert!(build_prompt(&ctx).contains("no message: the agent continued on its own"));
        let failed = turn_context(&[user("u", "hi"), result("r", true)]).unwrap();
        assert!(failed.facts.contains(&"the turn ended with an error".to_string()));
        assert!(failed.facts.contains(&"no pull request yet".to_string()));
    }

    #[test]
    fn a_long_message_keeps_its_end() {
        let long = format!("{}Want me to open a PR?", "x".repeat(5_000));
        let ctx = turn_context(&[user("u", "go"), assistant("a", &long), result("r", false)]).unwrap();
        let text = ctx.assistant.unwrap();
        assert!(text.starts_with('…') && text.ends_with("open a PR?"));
        assert_eq!(text.chars().count(), MAX_ASSISTANT_CHARS + 1);
    }

    #[test]
    fn generated_json_is_validated_and_clamped() {
        let reply = r#"Here you go:
```json
[{"label": "Open a draft PR", "text": "Open a draft PR for the login page."},
 {"label": "  \"Also handle the mobile deep-link case on iOS and Android too\".  ", "text": "Also handle deep links."},
 {"label": "Continue", "text": "Continue."},
 {"label": "open a draft pr", "text": "dupe"},
 {"label": "No text"},
 {"text": "Run the e2e suite"},
 {"label": "Fourth", "text": "never shown"}]
```"#;
        let got = parse_suggestions(reply).unwrap();
        let labels: Vec<&str> = got.iter().map(|s| s.label.as_str()).collect();
        assert_eq!(labels, ["Open a draft PR", "Also handle the mobile deep-link case…", "Run the e2e suite"]);
        assert!(got.iter().all(|s| s.label.chars().count() <= MAX_LABEL && s.source == SuggestionSource::Generated));
        assert_eq!(got[2].text, "Run the e2e suite");

        assert_eq!(parse_suggestions("[]"), Some(vec![]));
        assert_eq!(parse_suggestions("I'd suggest opening a PR."), None);
        assert_eq!(parse_suggestions("[{\"label\": \"broken\""), None);
        assert_eq!(parse_suggestions("{\"label\": \"x\", \"text\": \"y\"}"), None);
        let long = "y".repeat(2 * MAX_TEXT);
        let clamped = parse_suggestions(&format!("[{{\"label\": \"L\", \"text\": \"{long}\"}}]")).unwrap();
        assert_eq!(clamped[0].text.chars().count(), MAX_TEXT);
    }

    #[test]
    fn the_cli_result_is_parsed_and_errors_are_dropped() {
        let ok = json!({"type": "result", "subtype": "success", "is_error": false, "total_cost_usd": 0.0003359,
            "result": "[{\"label\": \"Open a draft PR\", \"text\": \"Open a draft PR.\"}]"});
        let got = parse_cli_output(&format!("{ok}\n")).unwrap();
        assert_eq!(got.cost_usd, Some(0.0003359));
        assert_eq!(got.suggestions[0].label, "Open a draft PR");
        let err = json!({"type": "result", "is_error": true, "result": "[]"});
        assert_eq!(parse_cli_output(&err.to_string()), None);
        assert_eq!(parse_cli_output("not json"), None);
        assert_eq!(parse_cli_output(&json!({"result": "no array"}).to_string()), None);
    }

    #[test]
    fn native_suggestions_become_capitalized_chips() {
        let s = native_suggestion("  open a draft PR ").unwrap();
        assert_eq!((s.label.as_str(), s.text.as_str(), s.source), ("Open a draft PR", "open a draft PR", SuggestionSource::Native));
        assert_eq!(native_suggestion("  "), None);
    }

    /// The probed 2.1.322 `--help` lines that matter, and an older CLI's.
    #[test]
    fn args_need_no_tools_and_no_persistence_and_isolate_when_they_can() {
        let help = "  --model <model>  Model\n  --output-format <format>\n  --tools <tools...>  Use \"\" to disable\n  \
                    --no-session-persistence  Disable\n  --setting-sources <sources>\n  --safe-mode  Start\n  \
                    --strict-mcp-config\n  --system-prompt <prompt>\n  --allowedTools, --allowed-tools <tools...>\n";
        let args = generation_args(help).unwrap();
        let joined = args.join(" ");
        assert!(joined.starts_with("-p --model haiku --output-format json --tools  --no-session-persistence --setting-sources  --safe-mode --strict-mcp-config --system-prompt "), "{joined}");
        assert_eq!(args[args.iter().position(|a| a == "--tools").unwrap() + 1], "");
        // No `--tools` or no `--no-session-persistence`: nothing runs.
        assert_eq!(generation_args(&help.replace("--tools", "--toolz")), None);
        assert_eq!(generation_args(&help.replace("--no-session-persistence", "")), None);
        // Isolation flags only when the CLI knows them.
        let older = help.replace("--safe-mode", "").replace("--setting-sources", "");
        let args = generation_args(&older).unwrap();
        assert!(!args.contains(&"--safe-mode".to_string()) && !args.contains(&"--setting-sources".to_string()));
    }

    // ── the process: a fake `claude` ─────────────────────────────────────

    const FAKE_HELP: &str = "--model --output-format --tools --no-session-persistence --setting-sources --safe-mode --strict-mcp-config --system-prompt";

    /// A fake `claude` in `dir`: `--help` prints the flags; a call records
    /// its argv (one per line) and stdin, waits `delay` seconds, then
    /// prints `reply` as the CLI's json result.
    fn fake_claude(dir: &Path, delay: &str, reply: &str) -> PathBuf {
        let path = dir.join("claude");
        let result = json!({"type": "result", "subtype": "success", "is_error": false,
                            "total_cost_usd": 0.0003, "result": reply});
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = --help ]; then echo '{FAKE_HELP}'; exit 0; fi\n\
             for a in \"$@\"; do printf '%s\\n' \"$a\"; done > '{dir}/args'\n\
             cat > '{dir}/stdin'\necho $$ >> '{dir}/pid'\nsleep {delay}\n\
             touch '{dir}/finished'\nprintf '%s\\n' '{result}'\n",
            dir = dir.display(),
            result = result.to_string().replace('\'', "'\\''"),
        );
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }

    fn ctx(turn: &str) -> TurnContext {
        turn_context(&[user("u", "Add a login page"), assistant("a", "Want me to open a draft PR?"), result(turn, false)]).unwrap()
    }

    async fn wait_for_file(path: &Path) {
        for _ in 0..200 {
            if path.exists() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("{} never appeared", path.display());
    }

    #[cfg(unix)]
    fn alive(pid_file: &Path) -> bool {
        let pids = std::fs::read_to_string(pid_file).unwrap();
    let pid: i32 = pids.lines().last().unwrap().trim().parse().unwrap();
        // SAFETY: signal 0 only probes whether the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[tokio::test]
    async fn generation_runs_haiku_without_tools_and_parses_the_reply() {
        let dir = tempfile::tempdir().unwrap();
        let reply = r#"[{"label": "Open a draft PR", "text": "Open a draft PR for the login page."}]"#;
        let suggester = Arc::new(Suggester::with_program(fake_claude(dir.path(), "0", reply), Duration::from_secs(10)));
        let mut events = suggester.subscribe();
        let got = suggester.suggest("t1", ctx("r1"), vec![("ANTHROPIC_API_KEY".into(), "k".into())]).await;
        assert_eq!(got, vec![Suggestion {
            label: "Open a draft PR".into(),
            text: "Open a draft PR for the login page.".into(),
            source: SuggestionSource::Generated,
        }]);
        let args: Vec<String> = std::fs::read_to_string(dir.path().join("args")).unwrap().lines().map(String::from).collect();
        let at = |flag: &str| args.iter().position(|a| a == flag).unwrap_or_else(|| panic!("no {flag} in {args:?}"));
        assert_eq!(args[at("--model") + 1], "haiku");
        assert_eq!(args[at("--tools") + 1], "", "no tools");
        assert_eq!(args[at("--output-format") + 1], "json");
        at("--no-session-persistence");
        at("--safe-mode");
        assert_eq!(args[0], "-p");
        let stdin = std::fs::read_to_string(dir.path().join("stdin")).unwrap();
        assert!(stdin.contains("USER:\nAdd a login page") && stdin.contains("open a draft PR?"), "{stdin}");
        let event = events.recv().await.unwrap();
        assert_eq!((event.task_id.as_str(), event.turn_id.as_str()), ("t1", "r1"));
        assert_eq!(event.suggestions, got);

        // Cached for the turn: no second call.
        std::fs::remove_file(dir.path().join("args")).unwrap();
        assert_eq!(suggester.suggest("t1", ctx("r1"), vec![]).await, got);
        assert!(!dir.path().join("args").exists());
    }

    #[tokio::test]
    async fn concurrent_asks_share_one_call() {
        let dir = tempfile::tempdir().unwrap();
        let reply = r#"[{"label": "Run the tests", "text": "Run the tests."}]"#;
        let suggester = Arc::new(Suggester::with_program(fake_claude(dir.path(), "0.3", reply), Duration::from_secs(10)));
        let (a, b) = tokio::join!(
            suggester.suggest("t1", ctx("r1"), vec![]),
            suggester.suggest("t1", ctx("r1"), vec![]),
        );
        assert_eq!(a, b);
        assert_eq!(a.len(), 1);
        // One process: one pid ever written (the file holds a single line).
        assert_eq!(std::fs::read_to_string(dir.path().join("pid")).unwrap().lines().count(), 1);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_timeout_kills_the_call_and_yields_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let suggester = Arc::new(Suggester::with_program(fake_claude(dir.path(), "30", "[]"), Duration::from_millis(400)));
        let started = Instant::now();
        assert_eq!(suggester.suggest("t1", ctx("r1"), vec![]).await, vec![]);
        assert!(started.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!alive(&dir.path().join("pid")), "the process group was killed");
        assert!(!dir.path().join("finished").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_new_turn_or_a_send_cancels_the_call() {
        let dir = tempfile::tempdir().unwrap();
        let suggester = Arc::new(Suggester::with_program(fake_claude(dir.path(), "30", "[]"), Duration::from_secs(20)));
        let mut events = suggester.subscribe();
        let asking = tokio::spawn({
            let s = suggester.clone();
            async move { s.suggest("t1", ctx("r1"), vec![]).await }
        });
        wait_for_file(&dir.path().join("pid")).await;
        // The user sends (or a turn starts on its own).
        suggester.cancel("t1");
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), asking).await.unwrap().unwrap(), vec![]);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!alive(&dir.path().join("pid")));
        assert!(events.try_recv().is_err(), "a cancelled call publishes nothing");

        // A later turn's end replaces a call in flight the same way.
        std::fs::remove_file(dir.path().join("pid")).unwrap();
        let asking = tokio::spawn({
            let s = suggester.clone();
            async move { s.suggest("t1", ctx("r2"), vec![]).await }
        });
        wait_for_file(&dir.path().join("pid")).await;
        suggester.turn_ended("t1", "r3");
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), asking).await.unwrap().unwrap(), vec![]);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!alive(&dir.path().join("pid")));
    }

    #[tokio::test]
    async fn a_failed_call_is_dropped_and_not_retried_for_the_turn() {
        let dir = tempfile::tempdir().unwrap();
        let suggester = Arc::new(Suggester::with_program(fake_claude(dir.path(), "0", "Sure! Open a PR."), Duration::from_secs(10)));
        assert_eq!(suggester.suggest("t1", ctx("r1"), vec![]).await, vec![]);
        std::fs::remove_file(dir.path().join("args")).unwrap();
        assert_eq!(suggester.suggest("t1", ctx("r1"), vec![]).await, vec![]);
        assert!(!dir.path().join("args").exists(), "no retry for the same turn");
    }

    #[tokio::test]
    async fn a_native_suggestion_leads_and_dedupes_the_generated_ones() {
        let dir = tempfile::tempdir().unwrap();
        let reply = r#"[{"label": "Open a draft PR", "text": "Open a draft PR."}, {"label": "Handle deep links", "text": "Also handle the mobile deep-link case."}]"#;
        let suggester = Arc::new(Suggester::with_program(fake_claude(dir.path(), "0", reply), Duration::from_secs(10)));
        let mut events = suggester.subscribe();
        // Mid-turn (nothing ended yet): ignored.
        suggester.native("t1", "open a draft PR");
        assert!(events.try_recv().is_err());
        suggester.turn_ended("t1", "r1");
        suggester.native("t1", "open a draft PR");
        let event = events.recv().await.unwrap();
        assert_eq!(event.suggestions.len(), 1);
        assert_eq!(event.suggestions[0].source, SuggestionSource::Native);
        let got = suggester.suggest("t1", ctx("r1"), vec![]).await;
        let labels: Vec<(&str, SuggestionSource)> = got.iter().map(|s| (s.label.as_str(), s.source)).collect();
        assert_eq!(labels, [("Open a draft PR", SuggestionSource::Native), ("Handle deep links", SuggestionSource::Generated)]);
    }

    /// The contract's casing (`types.ts` `Suggestion` / `SuggestionsEvent`).
    #[test]
    fn wire_shapes_match_the_frontend() {
        let s = Suggestion { label: "L".into(), text: "T".into(), source: SuggestionSource::Generated };
        let e = SuggestionsEvent { task_id: "t".into(), turn_id: "r".into(), suggestions: vec![s] };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({"taskId": "t", "turnId": "r", "suggestions": [{"label": "L", "text": "T", "source": "generated"}]})
        );
        assert_eq!(serde_json::to_value(SuggestionSource::Native).unwrap(), json!("native"));
    }
}
