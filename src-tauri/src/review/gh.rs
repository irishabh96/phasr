//! The GitHub CLI (`gh`), for opening and tracking a task's pull request.
//!
//! Optional by design: when `gh` is missing or not signed in to the
//! remote's host, "Approve & create PR" falls back to the browser compare
//! URL. GitHub Enterprise works the same way — the host comes from the
//! remote (`GH_HOST` + `--repo HOST/OWNER/REPO`), never assumed github.com.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use regex::Regex;
use serde::Deserialize;
use thiserror::Error;

use crate::util::proc::{run_with_timeout, ProcError};

const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// `gh pr create` talks to the API (and may wait on a slow push mirror).
const CREATE_TIMEOUT: Duration = Duration::from_secs(90);
const VIEW_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum GhError {
    #[error(transparent)]
    Proc(#[from] ProcError),
    #[error("gh: {0}")]
    Failed(String),
    #[error("gh printed no pull request URL")]
    NoUrl,
}

/// `gh` on the user's login-shell PATH (a Finder-launched app inherits
/// launchd's minimal PATH, which never has Homebrew's `gh`).
pub async fn find_gh() -> Option<PathBuf> {
    let path = crate::pty::login_path().await;
    find_in_path("gh", &path)
}

fn find_in_path(name: &str, path: &str) -> Option<PathBuf> {
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(name))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Env for every `gh` call: the remote's host, no prompts, plain output.
async fn gh_env(host: &str) -> Vec<(String, String)> {
    vec![
        ("GH_HOST".into(), host.into()),
        ("GH_PROMPT_DISABLED".into(), "1".into()),
        ("NO_COLOR".into(), "1".into()),
        ("PATH".into(), crate::pty::login_path().await),
    ]
}

/// Whether `gh` is signed in to `host`.
pub async fn authenticated(gh: &Path, host: &str) -> bool {
    let program = gh.to_string_lossy();
    run_with_timeout(&program, &["auth", "status", "--hostname", host], None, &gh_env(host).await, AUTH_TIMEOUT)
        .await
        .is_ok_and(|out| out.status.success())
}

/// A pull request `gh` created (or found already open for the branch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedPr {
    pub url: String,
    pub number: Option<i64>,
    /// `gh` refused because one already exists; this is that one.
    pub already_existed: bool,
}

pub struct CreatePr<'a> {
    pub host: &'a str,
    pub owner: &'a str,
    pub repo: &'a str,
    pub base: &'a str,
    pub head: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub draft: bool,
}

pub async fn create_pr(gh: &Path, cwd: &Path, pr: &CreatePr<'_>) -> Result<CreatedPr, GhError> {
    let repo = format!("{}/{}/{}", pr.host, pr.owner, pr.repo);
    let mut args: Vec<&str> = vec![
        "pr", "create", "--repo", &repo, "--base", pr.base, "--head", pr.head, "--title", pr.title,
        "--body", pr.body,
    ];
    if pr.draft {
        args.push("--draft");
    }
    let program = gh.to_string_lossy();
    let out = run_with_timeout(&program, &args, Some(cwd), &gh_env(pr.host).await, CREATE_TIMEOUT).await?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    parse_create_output(out.status.success(), &stdout, &stderr)
}

/// `gh pr create` prints the new PR's URL on stdout; when one already
/// exists for the branch it fails with that PR's URL in stderr, which is
/// as good as created for us.
pub fn parse_create_output(success: bool, stdout: &str, stderr: &str) -> Result<CreatedPr, GhError> {
    if success {
        return pr_url_in(stdout)
            .map(|(url, number)| CreatedPr {
                url,
                number,
                already_existed: false,
            })
            .ok_or(GhError::NoUrl);
    }
    if stderr.contains("already exists") {
        if let Some((url, number)) = pr_url_in(stderr) {
            return Ok(CreatedPr {
                url,
                number,
                already_existed: true,
            });
        }
    }
    let msg = stderr.trim();
    Err(GhError::Failed(if msg.is_empty() {
        "gh pr create failed".into()
    } else {
        msg.lines().last().unwrap_or(msg).to_string()
    }))
}

fn pr_url_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"https?://[^\s/]+/[^\s/]+/[^\s/]+/pull/(\d+)").expect("static regex"))
}

/// The last pull-request URL in `text`, with its number.
pub fn pr_url_in(text: &str) -> Option<(String, Option<i64>)> {
    pr_url_regex()
        .captures_iter(text)
        .last()
        .map(|c| (c[0].to_string(), c[1].parse().ok()))
}

/// The host of a PR URL (`https://github.example.com/o/r/pull/1`).
pub fn host_of_url(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    rest.split('/').next().filter(|h| !h.is_empty())
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrView {
    /// `OPEN` | `CLOSED` | `MERGED`.
    pub state: String,
    #[serde(default)]
    pub merged_at: Option<String>,
    #[serde(default)]
    pub is_draft: bool,
}

impl PrView {
    /// phasr's `pr_state`: `open` | `draft` | `merged` | `closed`.
    pub fn pr_state(&self) -> &'static str {
        match self.state.as_str() {
            "MERGED" => "merged",
            "CLOSED" => "closed",
            _ if self.merged_at.is_some() => "merged",
            _ if self.is_draft => "draft",
            _ => "open",
        }
    }
}

pub async fn view_pr(gh: &Path, url: &str) -> Result<PrView, GhError> {
    let host = host_of_url(url).unwrap_or("github.com");
    let program = gh.to_string_lossy();
    let out = run_with_timeout(
        &program,
        &["pr", "view", url, "--json", "state,mergedAt,isDraft"],
        None,
        &gh_env(host).await,
        VIEW_TIMEOUT,
    )
    .await?;
    if !out.status.success() {
        return Err(GhError::Failed(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| GhError::Failed(format!("unexpected gh output: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_url_gh_prints() {
        let stdout = "\nCreating pull request for phasr/fix-login into main in acme/web\n\nhttps://github.com/acme/web/pull/142\n";
        assert_eq!(
            parse_create_output(true, stdout, "").unwrap(),
            CreatedPr {
                url: "https://github.com/acme/web/pull/142".into(),
                number: Some(142),
                already_existed: false
            }
        );
    }

    #[test]
    fn parses_a_github_enterprise_url() {
        let stdout = "https://github.acme-corp.com/platform/api/pull/7\n";
        let pr = parse_create_output(true, stdout, "").unwrap();
        assert_eq!(pr.url, "https://github.acme-corp.com/platform/api/pull/7");
        assert_eq!(pr.number, Some(7));
        assert_eq!(host_of_url(&pr.url), Some("github.acme-corp.com"));
    }

    #[test]
    fn an_existing_pr_is_returned_not_failed() {
        let stderr = "a pull request for branch \"phasr/x\" into branch \"main\" already exists:\nhttps://github.com/acme/web/pull/99\n";
        let pr = parse_create_output(false, "", stderr).unwrap();
        assert_eq!((pr.number, pr.already_existed), (Some(99), true));
    }

    #[test]
    fn real_failures_surface_gh_s_message() {
        let err = parse_create_output(false, "", "pull request create failed: GraphQL: No commits between main and phasr/x\n")
            .unwrap_err();
        assert!(err.to_string().contains("No commits between"), "{err}");
        assert!(matches!(parse_create_output(true, "done\n", ""), Err(GhError::NoUrl)));
    }

    #[test]
    fn pr_view_maps_to_phasr_states() {
        let view = |json: &str| serde_json::from_str::<PrView>(json).unwrap().pr_state();
        assert_eq!(view(r#"{"state":"OPEN","mergedAt":null,"isDraft":true}"#), "draft");
        assert_eq!(view(r#"{"state":"OPEN","mergedAt":null,"isDraft":false}"#), "open");
        assert_eq!(view(r#"{"state":"MERGED","mergedAt":"2026-11-09T10:00:00Z","isDraft":false}"#), "merged");
        assert_eq!(view(r#"{"state":"CLOSED","mergedAt":null,"isDraft":false}"#), "closed");
    }

    #[test]
    fn finds_executables_on_a_path_string() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("gh");
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        let path = format!("/nonexistent:{}", dir.path().display());
        assert!(find_in_path("gh", &path).is_none(), "not executable yet");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(find_in_path("gh", &path), Some(bin));
        }
    }
}
