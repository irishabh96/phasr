use serde::Serialize;

/// Where a PR/MR can be opened on the web.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestTarget {
    pub provider: &'static str,
    pub url: String,
}

/// Build the "create pull request" URL for the workspace's branch
/// against the repository's default branch. Returns `None` for hosts
/// we don't know (custom git servers, self-hosted Forgejo, etc.).
pub fn build_pull_request_target(
    remote_url: &str,
    base_branch: &str,
    head_branch: &str,
) -> Option<PullRequestTarget> {
    let (host, owner, repo) = parse_remote_url(remote_url)?;
    // URL-encode the slash separators in branch names like
    // `feat/some-thing` so providers don't interpret them as path segs.
    let head = encode_branch(head_branch);
    let base = encode_branch(base_branch);

    if host.contains("github.com") {
        return Some(PullRequestTarget {
            provider: "GitHub",
            url: format!("https://github.com/{owner}/{repo}/compare/{base}...{head}?expand=1"),
        });
    }
    if host.contains("gitlab.com") || host.contains("gitlab.") {
        return Some(PullRequestTarget {
            provider: "GitLab",
            url: format!(
                "https://{host}/{owner}/{repo}/-/merge_requests/new?merge_request%5Bsource_branch%5D={head}&merge_request%5Btarget_branch%5D={base}"
            ),
        });
    }
    if host.contains("bitbucket.org") {
        return Some(PullRequestTarget {
            provider: "Bitbucket",
            url: format!(
                "https://bitbucket.org/{owner}/{repo}/pull-requests/new?source={head}&dest={base}"
            ),
        });
    }
    None
}

/// Returns `(host, owner, repo)` parsed from a typical git remote URL.
/// Handles SSH (`git@host:owner/repo.git`), HTTPS, and `ssh://` forms.
pub fn parse_remote_url(url: &str) -> Option<(String, String, String)> {
    let trimmed = url.trim();
    // SSH shorthand: git@host:owner/repo(.git)?
    if let Some(rest) = trimmed.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        return split_owner_repo(path).map(|(o, r)| (host.to_string(), o, r));
    }
    // ssh://git@host/owner/repo(.git)?
    if let Some(rest) = trimmed.strip_prefix("ssh://") {
        let rest = rest.strip_prefix("git@").unwrap_or(rest);
        let (host_and_port, path) = rest.split_once('/')?;
        // host_and_port may include `:22`; we only want the host.
        let host = host_and_port
            .split_once(':')
            .map(|(h, _)| h)
            .unwrap_or(host_and_port);
        return split_owner_repo(path).map(|(o, r)| (host.to_string(), o, r));
    }
    // https://host/owner/repo(.git)?
    for prefix in ["https://", "http://"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            let (host, path) = rest.split_once('/')?;
            // strip optional `user@` and trailing `:port`.
            let host = host.rsplit('@').next().unwrap_or(host);
            let host = host.split_once(':').map(|(h, _)| h).unwrap_or(host);
            return split_owner_repo(path).map(|(o, r)| (host.to_string(), o, r));
        }
    }
    None
}

fn split_owner_repo(path: &str) -> Option<(String, String)> {
    let path = path.strip_suffix('/').unwrap_or(path);
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.splitn(2, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner, repo))
}

fn encode_branch(branch: &str) -> String {
    branch
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '/' => c.to_string(),
            other => format!("%{:02X}", other as u8),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_shorthand() {
        let (host, owner, repo) = parse_remote_url("git@github.com:foo/bar.git").unwrap();
        assert_eq!(host, "github.com");
        assert_eq!(owner, "foo");
        assert_eq!(repo, "bar");
    }

    #[test]
    fn parses_https_with_dot_git() {
        let (host, owner, repo) = parse_remote_url("https://github.com/foo/bar.git").unwrap();
        assert_eq!(host, "github.com");
        assert_eq!(owner, "foo");
        assert_eq!(repo, "bar");
    }

    #[test]
    fn parses_https_without_dot_git() {
        let (host, owner, repo) = parse_remote_url("https://github.com/foo/bar/").unwrap();
        assert_eq!(host, "github.com");
        assert_eq!(owner, "foo");
        assert_eq!(repo, "bar");
    }

    #[test]
    fn builds_github_url() {
        let target =
            build_pull_request_target("git@github.com:foo/bar.git", "main", "phasr/abc").unwrap();
        assert_eq!(target.provider, "GitHub");
        assert_eq!(
            target.url,
            "https://github.com/foo/bar/compare/main...phasr/abc?expand=1"
        );
    }

    #[test]
    fn returns_none_for_unknown_host() {
        assert!(build_pull_request_target("git@example.com:foo/bar.git", "main", "feat").is_none());
    }
}
