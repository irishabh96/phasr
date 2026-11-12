//! Agent and environment detection: which agent CLIs are installed (and
//! which version), plus git / gh / shell for the first-run screen.
//!
//! Tauri-agnostic. Everything runs against the user's login-shell PATH
//! (`pty::login_path`) — a Finder-launched app's own PATH is launchd's
//! minimal one — and every subprocess goes through `run_with_timeout`:
//! `gemini --version` has been seen to hang for minutes, and one stuck CLI
//! must not stall the whole report. Probes run in parallel, so the report
//! costs one timeout at worst, not one per tool.
//!
//! Results are cached in `DetectionCache` (managed state) because each
//! probe spawns real processes; the UI re-detects with `force`.

use std::ffi::OsStr;
use std::path::Path;
use std::process::Output;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::domain::Agent;
use crate::launcher::which_in;
use crate::util::proc::{run_with_timeout, ProcError};

/// Budget for one `--version`. Generous for a node CLI's cold start, short
/// enough that a hung one doesn't make detection feel broken.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(3);

/// `gh auth status` validates the token against the API, so it gets more
/// room than a local `--version`.
const GH_AUTH_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectionStatus {
    /// On PATH and answered `--version` (the version may still be
    /// unparseable → `version: null`).
    Found,
    /// Not on PATH.
    Missing,
    /// On PATH but `--version` didn't answer in time.
    Timeout,
    /// On PATH but couldn't be run, or failed without printing a version.
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetection {
    pub agent: Agent,
    pub binary: &'static str,
    pub path: Option<String>,
    pub version: Option<String>,
    pub status: DetectionStatus,
    pub install_hint: &'static str,
    pub detected_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCheck {
    /// `None` = git isn't installed (or didn't answer).
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhCheck {
    pub installed: bool,
    pub version: Option<String>,
    pub authenticated: bool,
    /// The github.com login, when `gh auth status` names one.
    pub account: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentCheck {
    pub git: GitCheck,
    pub gh: GhCheck,
    /// The shell terminals and agents are launched in.
    pub shell: String,
    pub checked_at: DateTime<Utc>,
}

/// Process-wide cache for both reports. `tokio::sync::Mutex` because the
/// guard is held across the probes: concurrent callers (two windows, a
/// re-render) wait for the one in-flight detection instead of each
/// spawning their own set of processes.
#[derive(Default)]
pub struct DetectionCache {
    agents: tokio::sync::Mutex<Option<Vec<AgentDetection>>>,
    environment: tokio::sync::Mutex<Option<EnvironmentCheck>>,
}

impl DetectionCache {
    pub async fn agents(&self, force: bool) -> Vec<AgentDetection> {
        let mut cached = self.agents.lock().await;
        if let (false, Some(report)) = (force, cached.as_mut()) {
            // A timeout is usually a cold start under load (every agent is
            // probed at once at launch), not a broken install: probe just
            // those again rather than serving "no version" until relaunch.
            if report.iter().any(|d| d.status == DetectionStatus::Timeout) {
                let path_env = crate::pty::login_path().await;
                for entry in report.iter_mut().filter(|d| d.status == DetectionStatus::Timeout) {
                    *entry = detect_agent(entry.agent, OsStr::new(&path_env), VERSION_TIMEOUT).await;
                }
            }
            return report.clone();
        }
        let path_env = crate::pty::login_path().await;
        let report = detect_agents(OsStr::new(&path_env), VERSION_TIMEOUT).await;
        *cached = Some(report.clone());
        report
    }

    pub async fn environment(&self, force: bool) -> EnvironmentCheck {
        let mut cached = self.environment.lock().await;
        if let (false, Some(report)) = (force, cached.as_ref()) {
            return report.clone();
        }
        let path_env = crate::pty::login_path().await;
        let report = check_environment(
            OsStr::new(&path_env),
            crate::pty::resolve_shell(),
            VERSION_TIMEOUT,
        )
        .await;
        *cached = Some(report.clone());
        report
    }
}

/// Every agent, probed in parallel, in `Agent::ALL` order.
pub async fn detect_agents(path_env: &OsStr, timeout: Duration) -> Vec<AgentDetection> {
    let mut set = tokio::task::JoinSet::new();
    for agent in Agent::ALL {
        let path_env = path_env.to_os_string();
        set.spawn(async move { detect_agent(agent, &path_env, timeout).await });
    }
    let mut report = Vec::with_capacity(Agent::ALL.len());
    while let Some(joined) = set.join_next().await {
        // A probe can only fail to join by panicking; dropping that one
        // agent from the report beats failing detection for all of them.
        if let Ok(detection) = joined {
            report.push(detection);
        }
    }
    report.sort_by_key(|d| Agent::ALL.iter().position(|a| *a == d.agent));
    report
}

pub async fn detect_agent(agent: Agent, path_env: &OsStr, timeout: Duration) -> AgentDetection {
    let binary = agent.binary();
    let found = which_in(binary, path_env);
    let (status, version) = match found.as_deref() {
        None => (DetectionStatus::Missing, None),
        Some(path) => probe_version(path, path_env, timeout).await,
    };
    AgentDetection {
        agent,
        binary,
        path: found.map(|p| p.to_string_lossy().into_owned()),
        version,
        status,
        install_hint: agent.install_hint(),
        detected_at: Utc::now(),
    }
}

/// `<binary> --version`, classified. PATH is passed through so shebang
/// shims (`#!/usr/bin/env node`) find their interpreter.
async fn probe_version(
    binary: &Path,
    path_env: &OsStr,
    timeout: Duration,
) -> (DetectionStatus, Option<String>) {
    match run_tool(binary, &["--version"], path_env, timeout).await {
        Err(ProcError::TimedOut { .. }) => (DetectionStatus::Timeout, None),
        Err(_) => (DetectionStatus::Error, None),
        Ok(output) => match version_from_output(&output) {
            Some(version) => (DetectionStatus::Found, Some(version)),
            None if output.status.success() => (DetectionStatus::Found, None),
            None => (DetectionStatus::Error, None),
        },
    }
}

async fn run_tool(
    binary: &Path,
    args: &[&str],
    path_env: &OsStr,
    timeout: Duration,
) -> Result<Output, ProcError> {
    let env = [("PATH".to_string(), path_env.to_string_lossy().into_owned())];
    run_with_timeout(&binary.to_string_lossy(), args, None, &env, timeout).await
}

pub async fn check_environment(
    path_env: &OsStr,
    shell: String,
    timeout: Duration,
) -> EnvironmentCheck {
    let git_path = which_in("git", path_env);
    let gh_path = which_in("gh", path_env);

    let git_version = async {
        match git_path.as_deref() {
            Some(git) => run_tool(git, &["--version"], path_env, timeout)
                .await
                .ok()
                .and_then(|o| version_from_output(&o)),
            None => None,
        }
    };
    let gh_version = async {
        match gh_path.as_deref() {
            Some(gh) => run_tool(gh, &["--version"], path_env, timeout)
                .await
                .ok()
                .and_then(|o| version_from_output(&o)),
            None => None,
        }
    };
    let gh_auth = async {
        let gh = gh_path.as_deref()?;
        run_tool(
            gh,
            &["auth", "status", "--hostname", "github.com"],
            path_env,
            timeout.max(GH_AUTH_TIMEOUT),
        )
        .await
        .ok()
    };
    let (git_version, gh_version, gh_auth) = tokio::join!(git_version, gh_version, gh_auth);

    // gh ≥ 2.40 exits non-zero when not logged in; older versions print the
    // same report on stderr instead of stdout, so read both.
    let (authenticated, account) = match gh_auth {
        Some(output) => {
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            (output.status.success(), parse_gh_account(&text))
        }
        None => (false, None),
    };

    EnvironmentCheck {
        git: GitCheck {
            version: git_version,
        },
        gh: GhCheck {
            installed: gh_path.is_some(),
            version: gh_version,
            authenticated,
            account: account.filter(|_| authenticated),
        },
        shell,
        checked_at: Utc::now(),
    }
}

fn version_from_output(output: &Output) -> Option<String> {
    parse_version(&String::from_utf8_lossy(&output.stdout))
        .or_else(|| parse_version(&String::from_utf8_lossy(&output.stderr)))
}

/// The first `\d+\.\d+(\.\d+)?` in `text` — what every CLI here prints
/// somewhere in its `--version` line ("2.1.319 (Claude Code)",
/// "codex-cli 0.165.0", "git version 2.50.1 (Apple Git-155)").
pub fn parse_version(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let digits_end = |from: usize| {
        let mut i = from;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        i
    };
    let mut start = 0;
    while start < bytes.len() {
        let begins_number = bytes[start].is_ascii_digit()
            && (start == 0 || !(bytes[start - 1].is_ascii_digit() || bytes[start - 1] == b'.'));
        if begins_number {
            let major_end = digits_end(start);
            if bytes.get(major_end) == Some(&b'.') {
                let minor_end = digits_end(major_end + 1);
                if minor_end > major_end + 1 {
                    let mut end = minor_end;
                    if bytes.get(minor_end) == Some(&b'.') {
                        let patch_end = digits_end(minor_end + 1);
                        if patch_end > minor_end + 1 {
                            end = patch_end;
                        }
                    }
                    return Some(text[start..end].to_string());
                }
            }
        }
        start += 1;
    }
    None
}

/// The github.com login from `gh auth status`. Current gh prints
/// "Logged in to github.com account <login> (keyring)"; older releases
/// "Logged in to github.com as <login> (oauth_token)".
pub fn parse_gh_account(text: &str) -> Option<String> {
    text.lines()
        .filter(|line| line.contains("Logged in to"))
        .find_map(|line| {
            let after = line
                .split_once(" account ")
                .or_else(|| line.split_once(" as "))?
                .1;
            let login = after.split_whitespace().next()?;
            let login = login.trim_matches(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'));
            (!login.is_empty()).then(|| login.to_string())
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn parses_real_version_outputs() {
        let cases = [
            ("2.1.319 (Claude Code)\n", Some("2.1.319")),
            ("codex-cli 0.165.0\n", Some("0.165.0")),
            (
                "GitHub Copilot CLI 1.0.79.\nRun 'copilot update' to check for updates.\n",
                Some("1.0.79"),
            ),
            ("0.34.0\n", Some("0.34.0")),
            ("git version 2.50.1 (Apple Git-155)\n", Some("2.50.1")),
            (
                "gh version 2.83.0 (2025-11-04)\nhttps://github.com/cli/cli/releases/tag/v2.83.0\n",
                Some("2.83.0"),
            ),
            ("opencode v1.2\n", Some("1.2")),
            ("1.2.3.4", Some("1.2.3")),
            ("build 12 of 2025-11-04", None),
            ("", None),
        ];
        for (text, expected) in cases {
            assert_eq!(parse_version(text).as_deref(), expected, "{text:?}");
        }
    }

    #[test]
    fn parses_gh_account_from_new_and_old_formats() {
        let new = "github.com\n  ✓ Logged in to github.com account octo-cat (keyring)\n  - Active account: true\n";
        assert_eq!(parse_gh_account(new).as_deref(), Some("octo-cat"));
        let old = "github.com\n  ✓ Logged in to github.com as hubot (oauth_token)\n";
        assert_eq!(parse_gh_account(old).as_deref(), Some("hubot"));
        let logged_out = "You are not logged into any GitHub hosts. To log in, run: gh auth login\n";
        assert_eq!(parse_gh_account(logged_out), None);
    }

    #[cfg(unix)]
    fn fake_bin(dir: &Path, name: &str, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A CLI whose `--version` hangs (as `gemini --version` really does)
    /// costs the timeout and reports `timeout` — it doesn't stall
    /// detection, and the other agents are still reported.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_hung_version_probe_times_out_without_stalling_the_report() {
        let dir = tempfile::tempdir().unwrap();
        fake_bin(dir.path(), "gemini", "sleep 10");
        fake_bin(dir.path(), "claude", "echo '2.1.319 (Claude Code)'");
        fake_bin(dir.path(), "codex", "echo 'boom' >&2; exit 2");
        // Present but not executable: must not count as installed.
        std::fs::write(dir.path().join("copilot"), "not a program").unwrap();
        let path_env = format!("{}:/usr/bin:/bin", dir.path().display());

        let started = Instant::now();
        let report = detect_agents(OsStr::new(&path_env), Duration::from_millis(400)).await;
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "detection took {:?}",
            started.elapsed()
        );

        let by_agent = |agent: Agent| report.iter().find(|d| d.agent == agent).unwrap();
        assert_eq!(
            report.iter().map(|d| d.agent).collect::<Vec<_>>(),
            Agent::ALL.to_vec(),
            "report keeps display order"
        );

        let gemini = by_agent(Agent::Gemini);
        assert_eq!(gemini.status, DetectionStatus::Timeout);
        assert!(gemini.path.as_deref().unwrap().ends_with("/gemini"));
        assert_eq!(gemini.version, None);

        let claude = by_agent(Agent::Claude);
        assert_eq!(claude.status, DetectionStatus::Found);
        assert_eq!(claude.version.as_deref(), Some("2.1.319"));

        assert_eq!(by_agent(Agent::Codex).status, DetectionStatus::Error);
        assert_eq!(by_agent(Agent::Copilot).status, DetectionStatus::Missing);

        let opencode = by_agent(Agent::OpenCode);
        assert_eq!(opencode.status, DetectionStatus::Missing);
        assert_eq!(opencode.path, None);
        assert_eq!(opencode.install_hint, "npm install -g opencode-ai");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn environment_check_reports_git_gh_and_auth() {
        let dir = tempfile::tempdir().unwrap();
        fake_bin(dir.path(), "git", "echo 'git version 2.50.1 (Apple Git-155)'");
        fake_bin(
            dir.path(),
            "gh",
            r#"if [ "$1" = "auth" ]; then
  echo 'github.com'
  echo '  ✓ Logged in to github.com account octo-cat (keyring)'
else
  echo 'gh version 2.83.0 (2025-11-04)'
fi"#,
        );
        let path_env = format!("{}:/usr/bin:/bin", dir.path().display());
        let check = check_environment(
            OsStr::new(&path_env),
            "/bin/zsh".into(),
            Duration::from_secs(3),
        )
        .await;
        assert_eq!(check.git.version.as_deref(), Some("2.50.1"));
        assert!(check.gh.installed);
        assert_eq!(check.gh.version.as_deref(), Some("2.83.0"));
        assert!(check.gh.authenticated);
        assert_eq!(check.gh.account.as_deref(), Some("octo-cat"));
        assert_eq!(check.shell, "/bin/zsh");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn environment_check_without_gh_or_with_logged_out_gh() {
        let empty = tempfile::tempdir().unwrap();
        let check = check_environment(
            OsStr::new(&empty.path().display().to_string()),
            "/bin/sh".into(),
            Duration::from_secs(3),
        )
        .await;
        assert_eq!(check.git.version, None);
        assert!(!check.gh.installed && !check.gh.authenticated);

        let dir = tempfile::tempdir().unwrap();
        fake_bin(
            dir.path(),
            "gh",
            r#"if [ "$1" = "auth" ]; then echo 'You are not logged into any GitHub hosts.' >&2; exit 1; fi
echo 'gh version 2.83.0'"#,
        );
        let path_env = format!("{}:/usr/bin:/bin", dir.path().display());
        let check =
            check_environment(OsStr::new(&path_env), "/bin/sh".into(), Duration::from_secs(3))
                .await;
        assert!(check.gh.installed);
        assert!(!check.gh.authenticated);
        assert_eq!(check.gh.account, None);
    }

    #[tokio::test]
    async fn cache_serves_the_previous_report_unless_forced() {
        let cache = DetectionCache::default();
        let marker = AgentDetection {
            agent: Agent::Claude,
            binary: "claude",
            path: Some("/cached/claude".into()),
            version: Some("9.9.9".into()),
            status: DetectionStatus::Found,
            install_hint: Agent::Claude.install_hint(),
            detected_at: Utc::now(),
        };
        *cache.agents.lock().await = Some(vec![marker]);
        let served = cache.agents(false).await;
        assert_eq!(served.len(), 1);
        assert_eq!(served[0].path.as_deref(), Some("/cached/claude"));
    }

    #[test]
    fn detection_serializes_in_the_ipc_shape() {
        let d = AgentDetection {
            agent: Agent::OpenCode,
            binary: "opencode",
            path: None,
            version: None,
            status: DetectionStatus::Missing,
            install_hint: "x",
            detected_at: Utc::now(),
        };
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["agent"], "opencode");
        assert_eq!(json["status"], "missing");
        assert!(json["path"].is_null());
        assert!(json.get("installHint").is_some() && json.get("detectedAt").is_some());
    }
}
