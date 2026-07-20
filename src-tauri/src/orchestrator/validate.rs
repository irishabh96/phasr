//! The captured, per-worktree Validate runner (Story V1).
//!
//! Validate runs the user's opted-in `RunCommand`s (`run_in_validate == true`) as
//! CAPTURED subprocesses in the ticket's own worktree and folds their exit codes
//! into one pass/fail. It deliberately does NOT reuse `start_run_command`'s path
//! (`commands::run_commands`), which spawns an INTERACTIVE PTY in the MAIN
//! checkout and never reads an exit code (spec claim #9 / A4). Here we need the
//! ticket's branch state (`cwd = worktree_path`) and a real pass/fail.
//!
//! Shape mirrors the planner's captured one-shot (`orchestrator::planner`):
//! `tokio::process` (never blocks a runtime worker), a per-check wall-clock
//! timeout with `kill_on_drop`, and an env-overridable shell for deterministic
//! tests.
//!
//! ## PATH augmentation (architect §R3 — the latent-bundle bug)
//!
//! A Finder-launched `.app` inherits a MINIMAL PATH (no `/opt/homebrew/bin`), so a
//! bare `sh -c "pnpm typecheck"` dies with `command not found`. We reuse the
//! terminal's macOS PATH shaping (`pty::terminal_env`) for every check's
//! environment, so a check resolves the same binaries the interactive terminal
//! does. (The planner has this latent bug; Validate must not.)

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// One check's result. `passed = exit 0`; `exit_code` is `None` on a timeout or a
/// spawn failure. `tail_output` is the tail of combined stdout+stderr, bounded so
/// we never push a multi-megabyte blob across IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateCheck {
    pub name: String,
    pub command: String,
    pub passed: bool,
    pub exit_code: Option<i64>,
    pub tail_output: String,
}

/// The aggregate Validate result for one ticket. Round-trips through disk
/// (`validate.json`) — hence `Deserialize` — and returns to the caller. `passed`
/// is true ONLY when there is at least one check and every check exited 0: a
/// ticket with no checks configured is a legible empty result, never a pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateResult {
    pub subtask_id: String,
    pub checks: Vec<ValidateCheck>,
    pub passed: bool,
    pub ran_at_ms: i64,
}

/// The shell + per-check timeout. Injectable so tests point `shell` at a real
/// `/bin/sh` with a short timeout (mirrors `PlannerConfig`'s test-injectable
/// binary). `PHASR_VALIDATE_SHELL` is a test/ops override, not a per-user setting.
#[derive(Debug, Clone)]
pub struct ValidateConfig {
    pub shell: String,
    pub timeout: Duration,
}

impl Default for ValidateConfig {
    fn default() -> Self {
        Self {
            shell: std::env::var("PHASR_VALIDATE_SHELL").unwrap_or_else(|_| "/bin/sh".to_string()),
            // Check suites (test/typecheck) can run for minutes, and this is a
            // captured runner off the PTY hot path, so a generous ceiling is fine;
            // a hung check surfaces as an honest captured timeout, not a wedge.
            timeout: Duration::from_secs(300),
        }
    }
}

/// The environment handed to every check: the terminal's shaping (augmented
/// macOS PATH, sane `TERM`/`LANG`, secrets stripped) so a `.app`-bundled run
/// resolves `pnpm`/`node`/etc. (§R3). Pulled out so a test can assert the PATH is
/// augmented without spawning anything.
pub(crate) fn check_env(config: &ValidateConfig) -> Vec<(OsString, OsString)> {
    crate::pty::terminal_env(&config.shell)
}

/// Run every check sequentially in `worktree_path`, aggregating pass/fail. Pure
/// over its inputs (no DB, no Tauri) so tests drive it directly. `checks` is a
/// slice of `(name, command)` — the caller resolves which `RunCommand`s opted in.
pub async fn run_validate(
    subtask_id: &str,
    worktree_path: &Path,
    checks: &[(String, String)],
    config: &ValidateConfig,
) -> ValidateResult {
    let env = check_env(config);
    let mut results = Vec::with_capacity(checks.len());
    for (name, command) in checks {
        results.push(run_one_check(name, command, worktree_path, &env, config).await);
    }
    // A ticket with no checks is NOT a pass — it is a legible empty result so the
    // FE can surface "Add a check to validate" (V1 AC), never a green gate.
    let passed = !results.is_empty() && results.iter().all(|c| c.passed);
    ValidateResult {
        subtask_id: subtask_id.to_string(),
        checks: results,
        passed,
        ran_at_ms: chrono::Utc::now().timestamp_millis(),
    }
}

/// Run one check as `sh -c "<command>"` in the worktree, captured, under the
/// timeout. A timeout or spawn failure is a captured non-pass (`exit_code: None`)
/// with an explanatory tail — never a panic, never a hang past the ceiling.
async fn run_one_check(
    name: &str,
    command: &str,
    worktree_path: &Path,
    env: &[(OsString, OsString)],
    config: &ValidateConfig,
) -> ValidateCheck {
    use std::process::Stdio;

    let mut cmd = tokio::process::Command::new(&config.shell);
    cmd.arg("-c")
        .arg(command)
        .current_dir(worktree_path)
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k.clone(), v.clone())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // On the timeout branch below the future is dropped → kill the child
        // rather than leak a long-running check (matches the planner).
        .kill_on_drop(true);

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return ValidateCheck {
                name: name.to_string(),
                command: command.to_string(),
                passed: false,
                exit_code: None,
                tail_output: format!("could not launch `{}`: {err}", config.shell),
            };
        }
    };

    match tokio::time::timeout(config.timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&output.stderr);
            if !stderr.trim().is_empty() {
                combined.push_str(&stderr);
            }
            ValidateCheck {
                name: name.to_string(),
                command: command.to_string(),
                passed: output.status.success(),
                exit_code: output.status.code().map(|c| c as i64),
                tail_output: tail(&combined, MAX_TAIL_BYTES),
            }
        }
        Ok(Err(err)) => ValidateCheck {
            name: name.to_string(),
            command: command.to_string(),
            passed: false,
            exit_code: None,
            tail_output: format!("check process failed: {err}"),
        },
        // Elapsed: dropping the future drops the child → `kill_on_drop` reaps it.
        Err(_elapsed) => ValidateCheck {
            name: name.to_string(),
            command: command.to_string(),
            passed: false,
            exit_code: None,
            tail_output: format!(
                "check timed out after {}s and was stopped",
                config.timeout.as_secs()
            ),
        },
    }
}

/// Cap the captured output we keep per check (last N bytes of combined
/// stdout+stderr). The card shows the tail; the full log is never needed on the
/// wire, and an unbounded test suite log must not blow up `validate.json`.
const MAX_TAIL_BYTES: usize = 8_192;

/// The last `max` bytes of `s`, on a char boundary, prefixed with `…` when
/// truncated. Never splits a UTF-8 codepoint.
fn tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut start = s.len() - max;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> ValidateConfig {
        ValidateConfig {
            shell: "/bin/sh".into(),
            timeout: Duration::from_secs(5),
        }
    }

    // A single passing check → exit 0, overall pass. The captured exit code is the
    // load-bearing signal the interactive PTY path never gave us.
    #[tokio::test]
    async fn passing_check_reports_exit_zero_and_overall_pass() {
        let dir = tempfile::tempdir().unwrap();
        let checks = vec![("typecheck".into(), "exit 0".into())];
        let result = run_validate("t1", dir.path(), &checks, &test_config()).await;
        assert_eq!(result.checks.len(), 1);
        assert!(result.checks[0].passed);
        assert_eq!(result.checks[0].exit_code, Some(0));
        assert!(result.passed, "one passing check → the ticket validates");
    }

    // A single failing check → its real exit code rides back and the overall
    // result is a fail (the whole point of a captured runner).
    #[tokio::test]
    async fn failing_check_captures_exit_code_and_fails_overall() {
        let dir = tempfile::tempdir().unwrap();
        let checks = vec![("test".into(), "echo boom 1>&2; exit 3".into())];
        let result = run_validate("t1", dir.path(), &checks, &test_config()).await;
        assert!(!result.checks[0].passed);
        assert_eq!(result.checks[0].exit_code, Some(3));
        assert!(result.checks[0].tail_output.contains("boom"), "stderr is captured");
        assert!(!result.passed);
    }

    // A passing AND a failing check → the failing one poisons the aggregate, but
    // BOTH results are recorded (the FE shows the failing-check count).
    #[tokio::test]
    async fn one_failing_check_fails_the_aggregate() {
        let dir = tempfile::tempdir().unwrap();
        let checks = vec![
            ("lint".into(), "exit 0".into()),
            ("test".into(), "exit 1".into()),
        ];
        let result = run_validate("t1", dir.path(), &checks, &test_config()).await;
        assert_eq!(result.checks.len(), 2);
        assert!(result.checks[0].passed);
        assert!(!result.checks[1].passed);
        assert!(!result.passed);
    }

    // No checks configured → a legible empty result, `passed: false` (NOT an
    // error, NOT a green gate) so the FE can offer "Add a check".
    #[tokio::test]
    async fn no_checks_is_a_legible_empty_non_pass() {
        let dir = tempfile::tempdir().unwrap();
        let result = run_validate("t1", dir.path(), &[], &test_config()).await;
        assert!(result.checks.is_empty());
        assert!(!result.passed);
    }

    // A hung check is reaped at the timeout and reported as a non-pass with no
    // exit code — never a hang past the ceiling.
    #[tokio::test]
    async fn a_hung_check_times_out_and_does_not_pass() {
        let dir = tempfile::tempdir().unwrap();
        let checks = vec![("slow".into(), "sleep 30".into())];
        let config = ValidateConfig {
            shell: "/bin/sh".into(),
            timeout: Duration::from_millis(150),
        };
        let result = run_validate("t1", dir.path(), &checks, &config).await;
        assert!(!result.checks[0].passed);
        assert_eq!(result.checks[0].exit_code, None);
        assert!(result.checks[0].tail_output.contains("timed out"));
        assert!(!result.passed);
    }

    // The check runs in the TICKET'S worktree: `pwd` echoes the worktree path.
    #[tokio::test]
    async fn checks_run_in_the_worktree_cwd() {
        let dir = tempfile::tempdir().unwrap();
        // Canonicalize: macOS `/var` → `/private/var` symlink, else `pwd`
        // (which resolves the real path) won't match the tempdir string.
        let worktree = std::fs::canonicalize(dir.path()).unwrap();
        let checks = vec![("where".into(), "pwd".into())];
        let result = run_validate("t1", &worktree, &checks, &test_config()).await;
        assert!(
            result.checks[0]
                .tail_output
                .contains(&*worktree.to_string_lossy()),
            "cwd must be the worktree, got: {:?}",
            result.checks[0].tail_output
        );
    }

    // §R3: the check environment augments PATH on macOS so a bundled `.app` (with
    // its stripped PATH) still resolves Homebrew binaries. Gated to a real
    // Homebrew dir so it is deterministic on a dev mac and a silent skip on a bare
    // runner.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn check_env_augments_macos_path() {
        let env = check_env(&test_config());
        let path = env
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.to_string_lossy().into_owned())
            .unwrap_or_default();
        for brew in ["/opt/homebrew/bin", "/usr/local/bin"] {
            if std::path::Path::new(brew).exists() {
                assert!(
                    path.split(':').any(|p| p == brew),
                    "validate PATH must include `{brew}` (§R3); got {path}"
                );
            }
        }
    }
}
