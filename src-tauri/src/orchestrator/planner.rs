//! The planner — turn a one-line goal into a validated `{subtasks, edges}`
//! draft by running phasr's own `claude` CLI read-only over the repository.
//!
//! Posture (spec A2): NO API key, NO SDK, NO MCP — the same "shell out to the
//! user's installed agent" model the scheduler uses, except this is a CAPTURED
//! one-shot rather than a PTY. `claude -p "<prompt>" --output-format json
//! --permission-mode plan`, run `.current_dir(repo)` so the model can inspect
//! the codebase, under a wall-clock timeout. `--permission-mode plan` keeps it
//! READ-ONLY: the planner must never mutate the repo while inspecting it
//! (D-OQ10) — never `--dangerously-skip-permissions` here.
//!
//! Two-layer output parsing (C-CORR-C): `--output-format json` returns claude's
//! ENVELOPE (`{type, subtype, is_error, result}`), not the plan JSON directly.
//! We peel the envelope, take `.result`, then extract the fenced/inline plan
//! JSON from that text, deserialize it, and run the SHARED gate validator
//! (`commands::board::validate_decomposition`) so the planner and the gate never
//! drift on what a well-formed plan is. One retry on a parse/validate failure;
//! nothing is persisted (the command returns a draft the frontend edits).

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use crate::commands::board::{validate_decomposition, EdgeInput, SubtaskInput, MAX_SUBTASKS};
use crate::domain::Agent;

/// The `claude` binary and how long to let it run. Injectable so tests can point
/// `binary` at a stub script (env-overridable in production via
/// `PHASR_CLAUDE_BIN`) instead of the real, non-deterministic CLI.
#[derive(Debug, Clone)]
pub struct PlannerConfig {
    pub binary: String,
    pub timeout: Duration,
}

impl Default for PlannerConfig {
    fn default() -> Self {
        Self {
            // The planner itself is ALWAYS Claude even though it *assigns*
            // codex/gemini/etc. to individual tickets (D-OQ5). `PHASR_CLAUDE_BIN`
            // is a test/ops override, not a per-user setting.
            binary: std::env::var("PHASR_CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string()),
            // Codebase inspection + generation; env-tunable via a hand-built
            // config, but 90s is the sane default (D-OQ2).
            timeout: Duration::from_secs(90),
        }
    }
}

/// A planner-subprocess failure. Every variant maps to honest,
/// `humanizeError`-friendly copy and serializes to a plain string across IPC
/// (via the wrapping `PlannerCmdError`).
#[derive(Debug)]
pub enum PlannerError {
    /// The `claude` binary couldn't be spawned — not installed, or a bad
    /// `PHASR_CLAUDE_BIN`. Not retried (a missing binary won't reappear).
    AgentUnavailable(String),
    /// The planner ran but reported failure: a non-zero exit, or the JSON
    /// envelope's `is_error` flag. The agent itself refused/errored. Not retried.
    AgentFailed(String),
    /// The planner exceeded the configured timeout; we killed the child. Not
    /// retried — a second 90s wait just doubles the stall.
    Timeout,
    /// The output couldn't be parsed into a plan (bad envelope, no JSON block, or
    /// malformed plan JSON) — even after one retry. Carries a short excerpt.
    Unparseable(String),
    /// The parsed plan failed the shared validator (cycle, duplicate role, over
    /// the cap, or a bad edge) — even after one retry.
    Invalid(String),
}

impl PlannerError {
    /// Only a malformed/invalid RESULT is worth a second, independent run — the
    /// model is non-deterministic, so a re-run often yields clean JSON. A spawn
    /// failure, timeout, or agent-reported error won't improve on a re-run.
    fn is_retryable(&self) -> bool {
        matches!(self, PlannerError::Unparseable(_) | PlannerError::Invalid(_))
    }
}

impl std::fmt::Display for PlannerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AgentUnavailable(m) => write!(f, "the planner agent isn't available: {m}"),
            Self::AgentFailed(m) => write!(f, "the planner agent failed: {m}"),
            Self::Timeout => write!(f, "the planner took too long and was stopped"),
            Self::Unparseable(m) => write!(f, "the planner returned output we couldn't parse: {m}"),
            Self::Invalid(m) => write!(f, "the planner produced an invalid plan: {m}"),
        }
    }
}

impl serde::Serialize for PlannerError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Run the planner: build the SAW-method prompt, spawn `claude` read-only in the
/// repo, parse the two-layer output, and validate. Retries the whole run ONCE on
/// a parse/validate failure (D-OQ4). Returns the validated draft; persists
/// nothing.
pub async fn plan(
    repo_dir: &Path,
    repo_name: &str,
    branch: &str,
    goal: &str,
    config: &PlannerConfig,
) -> Result<(Vec<SubtaskInput>, Vec<EdgeInput>), PlannerError> {
    let prompt = build_prompt(goal, repo_name, branch);
    match attempt(&prompt, repo_dir, config).await {
        Ok(plan) => Ok(plan),
        // Retry exactly once, but only on output we could plausibly get right on
        // a second run. Everything else returns straight away.
        Err(e) if e.is_retryable() => attempt(&prompt, repo_dir, config).await,
        Err(e) => Err(e),
    }
}

/// One end-to-end pass: run the subprocess, then parse + validate its output.
async fn attempt(
    prompt: &str,
    repo_dir: &Path,
    config: &PlannerConfig,
) -> Result<(Vec<SubtaskInput>, Vec<EdgeInput>), PlannerError> {
    let stdout = run_planner(prompt, repo_dir, config).await?;
    parse_and_validate(&stdout)
}

/// Spawn `claude` read-only in `repo_dir` and capture its stdout, under the
/// configured timeout. Models stdout handling on `git::run_git`'s capture, but
/// async (`tokio::process`) because a captured one-shot must not block a runtime
/// worker for up to 90s.
async fn run_planner(
    prompt: &str,
    repo_dir: &Path,
    config: &PlannerConfig,
) -> Result<String, PlannerError> {
    use std::process::Stdio;

    let mut command = tokio::process::Command::new(&config.binary);
    command
        .args([
            "-p",
            prompt,
            "--output-format",
            "json",
            // Read-only: inspect the codebase, never mutate it (D-OQ10).
            "--permission-mode",
            "plan",
        ])
        .current_dir(repo_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // If the timeout fires (the `wait_with_output` future is dropped below),
        // reap the child rather than leak a 90s process — this is our
        // "kill the child after the timeout" (the brief's `child.kill()`).
        .kill_on_drop(true);

    let child = command.spawn().map_err(|e| {
        PlannerError::AgentUnavailable(format!("could not launch `{}`: {e}", config.binary))
    })?;

    let output = match tokio::time::timeout(config.timeout, child.wait_with_output()).await {
        Ok(result) => result
            .map_err(|e| PlannerError::AgentUnavailable(format!("planner process failed: {e}")))?,
        // Elapsed: dropping the future here drops `child` → `kill_on_drop` reaps it.
        Err(_elapsed) => return Err(PlannerError::Timeout),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(PlannerError::AgentFailed(if stderr.is_empty() {
            format!("planner exited with {}", output.status)
        } else {
            stderr
        }));
    }

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The two-layer parse (C-CORR-C): peel the envelope → extract the plan JSON →
/// deserialize → validate. Any structural failure is `Unparseable`; a
/// well-formed-but-cyclic/oversized/dup plan is `Invalid`; an `is_error`
/// envelope is `AgentFailed`.
fn parse_and_validate(stdout: &str) -> Result<(Vec<SubtaskInput>, Vec<EdgeInput>), PlannerError> {
    let text = peel_envelope(stdout)?;
    let json = extract_json_block(&text)
        .ok_or_else(|| PlannerError::Unparseable(excerpt(&text)))?;
    let parsed: ParsedPlan = serde_json::from_str(&json)
        .map_err(|e| PlannerError::Unparseable(format!("{e} — near: {}", excerpt(&json))))?;

    let subtasks: Vec<SubtaskInput> = parsed.subtasks.into_iter().map(Into::into).collect();
    let edges: Vec<EdgeInput> = parsed.edges.into_iter().map(Into::into).collect();

    // The SHARED gate validator (BE-1) — one source of truth for "valid plan".
    validate_decomposition(&subtasks, &edges).map_err(|e| PlannerError::Invalid(e.to_string()))?;
    Ok((subtasks, edges))
}

/// Layer 1: peel claude's `--output-format json` envelope. On a result envelope
/// (`is_error: true`) → `AgentFailed`; otherwise return the `.result` text.
/// Tolerates output that ISN'T an envelope (a test stub echoing raw JSON, or a
/// fenced block) by returning it verbatim as the model text.
fn peel_envelope(stdout: &str) -> Result<String, PlannerError> {
    let trimmed = stdout.trim();
    // An envelope is a JSON OBJECT with a top-level `result` (usually
    // `type:"result"`/`is_error`). A raw plan `{subtasks,edges}` has neither, so
    // we don't mistake it for an envelope.
    if let Ok(serde_json::Value::Object(map)) = serde_json::from_str::<serde_json::Value>(trimmed) {
        let looks_like_envelope = map.contains_key("result")
            || map.get("type").and_then(|v| v.as_str()) == Some("result");
        if looks_like_envelope {
            let is_error = map.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
            let result_text = map
                .get("result")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if is_error {
                return Err(PlannerError::AgentFailed(if result_text.trim().is_empty() {
                    "the planner agent reported an error".to_string()
                } else {
                    result_text
                }));
            }
            return Ok(result_text);
        }
    }
    Ok(trimmed.to_string())
}

/// Layer 2: extract the plan JSON from the model's text. Prefers the content of
/// the first fenced code block (```json or bare ```), else scans the whole text;
/// within that region it returns the first BALANCED `{…}` object. That single
/// balanced scan transparently drops a ```json language tag, prose around the
/// fence, and any trailing chatter.
fn extract_json_block(text: &str) -> Option<String> {
    let region = fenced_region(text).unwrap_or(text);
    balanced_object(region)
}

/// The text inside the first ``` … ``` fence (opening fence + optional language
/// tag line and closing fence stripped), or None when the text isn't fenced.
fn fenced_region(text: &str) -> Option<&str> {
    let open = text.find("```")?;
    let after = &text[open + 3..];
    // Skip the rest of the opening-fence line (an optional language tag like
    // `json`) up to and including its newline.
    let inner_start = after.find('\n').map(|i| i + 1).unwrap_or(after.len());
    let inner = &after[inner_start..];
    let close = inner.find("```")?;
    Some(&inner[..close])
}

/// The first balanced `{…}` object in `text`. A brace-depth scan that is
/// string-aware, so a `}` inside a JSON string value (e.g. a prompt containing
/// braces) doesn't close the object early.
fn balanced_object(text: &str) -> Option<String> {
    let start = text.find('{')?;
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for i in start..bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
            }
            continue;
        }
        match c {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// A short, single-line excerpt for error messages so we never dump a
/// multi-megabyte blob onto the wire.
fn excerpt(text: &str) -> String {
    const MAX: usize = 200;
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() > MAX {
        let head: String = one_line.chars().take(MAX).collect();
        format!("{head}…")
    } else {
        one_line
    }
}

// ── the model-facing prompt (SAW-method decomposition) ──────────────────────

/// Compose the read-only decomposition prompt: the goal, the repo name/branch,
/// the agent capability menu (from `Agent::ALL`), the role guidance, and a STRICT
/// output contract (a single fenced ```json block; unique kebab-case roles;
/// agent ∈ the five; referential edges; no self-edges; no cycles; ≤ MAX_SUBTASKS).
fn build_prompt(goal: &str, repo_name: &str, branch: &str) -> String {
    let mut agents = String::new();
    for agent in Agent::ALL {
        agents.push_str(&format!(
            "- {}: {}\n",
            agent.as_str(),
            agent_strength(agent)
        ));
    }

    format!(
        "You are the planning agent (a BSA — Business Systems Analyst) for phasr, a tool that \
runs multiple AI coding agents in parallel, each in its own isolated git worktree.\n\n\
Decompose the goal below into a set of well-scoped, parallelizable subtasks (\"tickets\"), \
each assigned to one agent, connected by a dependency DAG of producer→consumer handoffs.\n\n\
## Goal\n{goal}\n\n\
## Repository\n\
- name: {repo_name}\n\
- branch: {branch}\n\
You are running READ-ONLY inside this repository — inspect the codebase (file layout, \
stack, existing patterns) to inform the decomposition. Do NOT modify any files.\n\n\
## Agents available (pick the best fit per ticket)\n{agents}\n\
## Roles\n\
Each ticket has a unique, kebab-case `role` naming the persona/slice of work (e.g. \
`backend-api`, `frontend-ui`, `db-migration`, `qa`). Roles are the nodes of the DAG. An \
edge `{{\"fromRole\": \"a\", \"toRole\": \"b\"}}` means ticket `b` depends on (waits for the \
handoff from) ticket `a`.\n\n\
## Output contract (STRICT)\n\
Reply with ONLY a single fenced ```json code block and nothing else — no prose before or \
after. Shape:\n\
```json\n\
{{\n  \"subtasks\": [\n    {{ \"role\": \"kebab-case-role\", \"agent\": \"claude\", \"prompt\": \"what this agent should do\" }}\n  ],\n  \"edges\": [\n    {{ \"fromRole\": \"producer-role\", \"toRole\": \"consumer-role\" }}\n  ]\n}}\n\
```\n\
Constraints:\n\
- Between 1 and {MAX_SUBTASKS} subtasks; prefer few, well-scoped tickets over many tiny ones.\n\
- Every `role` is unique and kebab-case.\n\
- Every `agent` is EXACTLY one of: {agent_ids}.\n\
- Every edge's `fromRole`/`toRole` references a role that exists in `subtasks`.\n\
- No self-edges (`fromRole` != `toRole`).\n\
- The graph is a DAG — NO cycles.\n",
        goal = goal.trim(),
        repo_name = repo_name,
        branch = branch,
        agents = agents,
        MAX_SUBTASKS = MAX_SUBTASKS,
        agent_ids = Agent::ALL
            .iter()
            .map(|a| a.as_str())
            .collect::<Vec<_>>()
            .join(", "),
    )
}

/// A one-line capability blurb per agent for the planner's menu. Kept HERE (not
/// in `domain::agent`, which is pure data) because it's model-facing guidance,
/// not persisted state. The exhaustive match means a new `Agent` variant forces
/// an entry rather than silently shipping a blank line.
fn agent_strength(agent: Agent) -> &'static str {
    match agent {
        Agent::Claude => "deep reasoning, careful multi-file refactors, and nuanced implementation",
        Agent::Codex => "fast, high-reasoning code generation and focused edits",
        Agent::Copilot => "IDE-style completions and routine, well-specified implementation",
        Agent::Gemini => "large-context analysis and broad sweeps across a big codebase",
        Agent::OpenCode => "open-source, terminal-native general-purpose coding",
    }
}

// ── the planner's internal parse target (lenient agent, strict roles) ───────

/// The planner's parse struct. Separate from `SubtaskInput`/`EdgeInput` only so
/// the `agent` field can be deserialized LENIENTLY.
#[derive(Debug, Deserialize)]
struct ParsedPlan {
    #[serde(default)]
    subtasks: Vec<ParsedSubtask>,
    #[serde(default)]
    edges: Vec<ParsedEdge>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedSubtask {
    role: String,
    // Lenient (D-OQ3): unknown/missing agent → Claude, because the agent is
    // user-editable in the review surface, so we never reject a whole plan just
    // because the model named a tool we don't recognize. Roles stay strict.
    #[serde(default = "Agent::default", deserialize_with = "lenient_agent")]
    agent: Agent,
    #[serde(default)]
    prompt: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedEdge {
    from_role: String,
    to_role: String,
}

impl From<ParsedSubtask> for SubtaskInput {
    fn from(p: ParsedSubtask) -> Self {
        SubtaskInput {
            role: p.role,
            agent: p.agent,
            prompt: p.prompt,
        }
    }
}

impl From<ParsedEdge> for EdgeInput {
    fn from(p: ParsedEdge) -> Self {
        EdgeInput {
            from_role: p.from_role,
            to_role: p.to_role,
        }
    }
}

/// Deserialize an `agent` value leniently: any of the known lowercase agent
/// strings maps to its variant; anything else (or `null`) falls back to Claude.
fn lenient_agent<'de, D>(deserializer: D) -> Result<Agent, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(raw
        .as_deref()
        .and_then(Agent::from_str)
        .unwrap_or_else(Agent::default))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── layer-2 extraction (raw / fenced / enveloped / brace-in-string) ─────

    const VALID_PLAN: &str = r#"{"subtasks":[{"role":"backend","agent":"claude","prompt":"do the backend"},{"role":"frontend","agent":"codex","prompt":"do the frontend"}],"edges":[{"fromRole":"backend","toRole":"frontend"}]}"#;

    #[test]
    fn parses_raw_json_without_a_fence_or_envelope() {
        let (subtasks, edges) = parse_and_validate(VALID_PLAN).expect("raw plan JSON parses");
        assert_eq!(subtasks.len(), 2);
        assert_eq!(edges.len(), 1);
        assert_eq!(subtasks[0].role, "backend");
        assert_eq!(subtasks[1].agent, Agent::Codex);
    }

    #[test]
    fn parses_fenced_json_block() {
        let text = format!("Here is the plan:\n\n```json\n{VALID_PLAN}\n```\n");
        let (subtasks, edges) = parse_and_validate(&text).expect("fenced plan parses");
        assert_eq!(subtasks.len(), 2);
        assert_eq!(edges.len(), 1);
    }

    #[test]
    fn parses_plan_from_claude_envelope() {
        let model_text = format!("Here is the plan:\n\n```json\n{VALID_PLAN}\n```");
        let envelope = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "result": model_text,
        })
        .to_string();
        let (subtasks, edges) = parse_and_validate(&envelope).expect("enveloped plan parses");
        assert_eq!(subtasks.len(), 2);
        assert_eq!(edges.len(), 1);
    }

    #[test]
    fn envelope_is_error_maps_to_agent_failed() {
        let envelope = serde_json::json!({
            "type": "result",
            "is_error": true,
            "result": "I cannot do that",
        })
        .to_string();
        assert!(matches!(
            parse_and_validate(&envelope),
            Err(PlannerError::AgentFailed(_))
        ));
    }

    #[test]
    fn a_brace_inside_a_prompt_string_does_not_end_the_object() {
        // The prompt value contains `{ }` — the balanced scan must be string-aware.
        let plan = r#"{"subtasks":[{"role":"only","agent":"claude","prompt":"handle the {payload} and } braces"}],"edges":[]}"#;
        let (subtasks, edges) = parse_and_validate(plan).expect("braces-in-string plan parses");
        assert_eq!(subtasks.len(), 1);
        assert!(edges.is_empty());
        assert!(subtasks[0].prompt.contains("{payload}"));
    }

    #[test]
    fn unknown_agent_falls_back_to_claude() {
        let plan = r#"{"subtasks":[{"role":"solo","agent":"gpt5-turbo","prompt":"go"}],"edges":[]}"#;
        let (subtasks, _edges) = parse_and_validate(plan).expect("unknown agent tolerated");
        assert_eq!(subtasks[0].agent, Agent::Claude);
    }

    #[test]
    fn missing_agent_falls_back_to_claude() {
        let plan = r#"{"subtasks":[{"role":"solo","prompt":"go"}],"edges":[]}"#;
        let (subtasks, _edges) = parse_and_validate(plan).expect("missing agent tolerated");
        assert_eq!(subtasks[0].agent, Agent::Claude);
    }

    #[test]
    fn garbage_output_is_unparseable() {
        assert!(matches!(
            parse_and_validate("sorry, I can't help with that"),
            Err(PlannerError::Unparseable(_))
        ));
    }

    #[test]
    fn a_cyclic_plan_is_invalid() {
        let plan = r#"{"subtasks":[{"role":"a","agent":"claude","prompt":"x"},{"role":"b","agent":"claude","prompt":"y"}],"edges":[{"fromRole":"a","toRole":"b"},{"fromRole":"b","toRole":"a"}]}"#;
        assert!(matches!(
            parse_and_validate(plan),
            Err(PlannerError::Invalid(_))
        ));
    }

    #[test]
    fn prompt_embeds_goal_agents_and_the_cap() {
        let prompt = build_prompt("Build a login page", "acme-web", "main");
        assert!(prompt.contains("Build a login page"));
        assert!(prompt.contains("acme-web"));
        assert!(prompt.contains("branch: main"));
        // Every agent id appears in the capability menu.
        for agent in Agent::ALL {
            assert!(prompt.contains(agent.as_str()), "menu lists {}", agent.as_str());
        }
        assert!(prompt.contains(&MAX_SUBTASKS.to_string()));
        assert!(prompt.contains("NO cycles"));
    }

    // ── env-overridable stub subprocess (the five scenarios) ────────────────
    //
    // Tests inject `PlannerConfig.binary` DIRECTLY (a stub script path) rather
    // than mutating the process-global `PHASR_CLAUDE_BIN`, so they stay
    // deterministic under `cargo test`'s parallel runner. One dedicated test
    // (`default_config_reads_env_binary`) covers the env-override path itself.

    #[cfg(unix)]
    mod subprocess {
        use super::*;
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::time::Duration;

        static STUB_SEQ: AtomicU32 = AtomicU32::new(0);

        /// Write an executable `#!/bin/sh` stub into `dir` and return its path.
        fn write_stub(dir: &Path, body: &str) -> PathBuf {
            use std::os::unix::fs::PermissionsExt;
            let n = STUB_SEQ.fetch_add(1, Ordering::SeqCst);
            let path = dir.join(format!("claude-stub-{n}.sh"));
            std::fs::write(&path, body).unwrap();
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
            path
        }

        /// A stub that (1) appends one byte to a counter file per invocation and
        /// (2) prints `stdout` verbatim. Returns (binary path, counter path). The
        /// counter proves how many times the planner actually shelled out — i.e.
        /// whether the one-retry fired.
        fn counting_stub(dir: &Path, stdout: &str) -> (PathBuf, PathBuf) {
            let counter = dir.join(format!(
                "invocations-{}",
                STUB_SEQ.load(Ordering::SeqCst)
            ));
            let body = format!(
                "#!/bin/sh\nprintf 'x' >> '{}'\ncat <<'PHASR_STUB_EOF'\n{}\nPHASR_STUB_EOF\n",
                counter.display(),
                stdout
            );
            let path = write_stub(dir, &body);
            (path, counter)
        }

        fn invocation_count(counter: &Path) -> usize {
            std::fs::read(counter).map(|b| b.len()).unwrap_or(0)
        }

        fn config_for(binary: PathBuf) -> PlannerConfig {
            PlannerConfig {
                binary: binary.to_string_lossy().into_owned(),
                timeout: Duration::from_secs(5),
            }
        }

        /// A clean envelope carrying a fenced plan → the parsed 2-ticket/1-edge
        /// plan, on the FIRST attempt (no retry).
        #[tokio::test]
        async fn clean_envelope_returns_parsed_plan_without_retry() {
            let dir = tempfile::tempdir().unwrap();
            let model_text = format!("Here is the plan:\n\n```json\n{VALID_PLAN}\n```");
            let envelope = serde_json::json!({
                "type": "result",
                "is_error": false,
                "result": model_text,
            })
            .to_string();
            let (binary, counter) = counting_stub(dir.path(), &envelope);

            let (subtasks, edges) =
                plan(dir.path(), "repo", "main", "build it", &config_for(binary))
                    .await
                    .expect("a clean plan must parse");

            assert_eq!(subtasks.len(), 2);
            assert_eq!(edges.len(), 1);
            assert_eq!(invocation_count(&counter), 1, "a clean plan must NOT retry");
        }

        /// Garbage twice → `Unparseable` after EXACTLY one retry (2 invocations).
        #[tokio::test]
        async fn garbage_retries_once_then_unparseable() {
            let dir = tempfile::tempdir().unwrap();
            let (binary, counter) = counting_stub(dir.path(), "sorry, no plan here");

            let err = plan(dir.path(), "repo", "main", "build it", &config_for(binary))
                .await
                .expect_err("garbage must fail");

            assert!(matches!(err, PlannerError::Unparseable(_)), "got {err:?}");
            assert_eq!(invocation_count(&counter), 2, "malformed output retries once");
        }

        /// A cyclic plan twice → `Invalid` after one retry (the shared validator
        /// rejected it both times).
        #[tokio::test]
        async fn cyclic_plan_retries_once_then_invalid() {
            let dir = tempfile::tempdir().unwrap();
            let cyclic = r#"{"subtasks":[{"role":"a","agent":"claude","prompt":"x"},{"role":"b","agent":"claude","prompt":"y"}],"edges":[{"fromRole":"a","toRole":"b"},{"fromRole":"b","toRole":"a"}]}"#;
            let (binary, counter) = counting_stub(dir.path(), cyclic);

            let err = plan(dir.path(), "repo", "main", "build it", &config_for(binary))
                .await
                .expect_err("a cyclic plan must fail");

            assert!(matches!(err, PlannerError::Invalid(_)), "got {err:?}");
            assert_eq!(invocation_count(&counter), 2, "an invalid plan retries once");
        }

        /// A stub that sleeps past the timeout → `Timeout` (the child is reaped).
        #[tokio::test]
        async fn sleeping_stub_times_out() {
            let dir = tempfile::tempdir().unwrap();
            // `exec sleep` so SIGKILL (kill_on_drop) lands on `sleep` directly.
            let binary = write_stub(dir.path(), "#!/bin/sh\nexec sleep 30\n");
            let config = PlannerConfig {
                binary: binary.to_string_lossy().into_owned(),
                // Far below the 30s sleep, so the timeout fires fast and the test
                // finishes in ~150ms rather than blocking.
                timeout: Duration::from_millis(150),
            };

            let err = plan(dir.path(), "repo", "main", "build it", &config)
                .await
                .expect_err("a slow planner must time out");
            assert!(matches!(err, PlannerError::Timeout), "got {err:?}");
        }

        /// A binary that doesn't exist → `AgentUnavailable`, and it is NOT retried.
        #[tokio::test]
        async fn nonexistent_binary_is_agent_unavailable() {
            let dir = tempfile::tempdir().unwrap();
            let config = PlannerConfig {
                binary: dir
                    .path()
                    .join("definitely-not-a-real-binary")
                    .to_string_lossy()
                    .into_owned(),
                timeout: Duration::from_secs(5),
            };
            let err = plan(dir.path(), "repo", "main", "build it", &config)
                .await
                .expect_err("a missing binary must fail");
            assert!(matches!(err, PlannerError::AgentUnavailable(_)), "got {err:?}");
        }

        /// A non-zero exit → `AgentFailed`, carrying the stub's stderr.
        #[tokio::test]
        async fn nonzero_exit_is_agent_failed() {
            let dir = tempfile::tempdir().unwrap();
            let binary = write_stub(
                dir.path(),
                "#!/bin/sh\necho 'boom' 1>&2\nexit 3\n",
            );
            let err = plan(dir.path(), "repo", "main", "build it", &config_for(binary))
                .await
                .expect_err("a non-zero exit must fail");
            match err {
                PlannerError::AgentFailed(msg) => assert!(msg.contains("boom"), "stderr rides along"),
                other => panic!("expected AgentFailed, got {other:?}"),
            }
        }
    }

    /// The env-override path: `PlannerConfig::default()` reads `PHASR_CLAUDE_BIN`.
    /// The only test that touches the process-global env var; no other test reads
    /// it, so this can't race the parallel runner.
    #[test]
    fn default_config_reads_env_binary() {
        std::env::set_var("PHASR_CLAUDE_BIN", "/opt/custom/claude");
        let config = PlannerConfig::default();
        std::env::remove_var("PHASR_CLAUDE_BIN");
        assert_eq!(config.binary, "/opt/custom/claude");
        assert_eq!(config.timeout, Duration::from_secs(90));
    }
}
