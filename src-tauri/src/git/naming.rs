use std::path::{Path, PathBuf};
use std::process::Command;

/// `~/.phasr/worktrees`, matching the default local layout. Falls back
/// to `/tmp` if `$HOME` is unset (CI sandboxes).
pub fn default_worktree_base_path() -> PathBuf {
    home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".phasr")
        .join("worktrees")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// First UUID segment, short enough for branch names while remaining
/// useful as a collision fallback.
pub fn short_id(id: &str) -> &str {
    id.split('-').next().unwrap_or(id)
}

/// Lowercase, alphanumeric-or-dash slug derived from a task name.
pub fn slugify(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut prev_dash = true;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

pub fn default_branch_name(slug: &str, id_fallback: &str) -> String {
    let base = if slug.is_empty() { id_fallback } else { slug };
    sanitize_branch_name(&format!("phasr/{base}")).unwrap_or_else(|| format!("phasr/{id_fallback}"))
}

/// Bump with `-2`, `-3`, ... if a branch with the requested name
/// already exists in `repo_path`.
pub fn unique_branch_name(repo_path: &Path, requested: &str, id_fallback: &str) -> String {
    let base =
        sanitize_branch_name(requested).unwrap_or_else(|| default_branch_name("", id_fallback));
    if !branch_exists(repo_path, &base) {
        return base;
    }
    for suffix in 2..1000 {
        let next = format!("{base}-{suffix}");
        if !branch_exists(repo_path, &next) {
            return next;
        }
    }
    format!("{base}-{id_fallback}")
}

fn sanitize_branch_name(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len());
    let mut prev_dash = false;

    for c in raw.trim().chars() {
        let next = if c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.') {
            c
        } else {
            '-'
        };
        if next == '-' {
            if !prev_dash {
                out.push('-');
            }
            prev_dash = true;
        } else {
            out.push(next);
            prev_dash = false;
        }
    }

    let mut parts = Vec::new();
    for part in out.split('/') {
        let mut cleaned = part
            .trim_matches(|c| matches!(c, '-' | '.'))
            .replace("@{", "-");
        while cleaned.contains("..") {
            cleaned = cleaned.replace("..", ".");
        }
        while cleaned.ends_with(".lock") {
            cleaned.truncate(cleaned.len().saturating_sub(5));
            cleaned = cleaned.trim_matches(|c| matches!(c, '-' | '.')).to_string();
        }
        if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
            continue;
        }
        parts.push(cleaned);
    }

    let candidate = parts.join("/");
    if candidate.is_empty() {
        None
    } else {
        Some(candidate)
    }
}

/// `true` when the local branch already exists. Errors (repo not found,
/// permissions) collapse to `false`; the later git worktree add will
/// surface the real error if any.
fn branch_exists(repo_path: &Path, name: &str) -> bool {
    Command::new("git")
        .arg("show-ref")
        .arg("--verify")
        .arg("--quiet")
        .arg(format!("refs/heads/{name}"))
        .current_dir(repo_path)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_basics() {
        assert_eq!(slugify("Add dark mode"), "add-dark-mode");
        assert_eq!(slugify("Fix checkout bug!"), "fix-checkout-bug");
        assert_eq!(slugify("  multiple   spaces  "), "multiple-spaces");
        assert_eq!(slugify("UPPER -> lower"), "upper-lower");
        assert_eq!(slugify(""), "");
        assert_eq!(slugify("???"), "");
        assert_eq!(slugify("v1.2.3-rc"), "v1-2-3-rc");
    }

    #[test]
    fn unique_branch_name_falls_back_when_requested_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            unique_branch_name(tmp.path(), "", "deadbeef"),
            "phasr/deadbeef"
        );
        assert_eq!(
            unique_branch_name(tmp.path(), "custom/fix-typo", "deadbeef"),
            "custom/fix-typo"
        );
    }

    #[test]
    fn unique_branch_name_collides_when_branch_exists() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path();
        Command::new("git")
            .args(["init", "--quiet", "--initial-branch=main"])
            .current_dir(repo)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.email", "test@example.com"])
            .current_dir(repo)
            .status()
            .unwrap();
        Command::new("git")
            .args(["config", "user.name", "test"])
            .current_dir(repo)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "--allow-empty", "-m", "seed"])
            .current_dir(repo)
            .status()
            .unwrap();
        Command::new("git")
            .args(["branch", "custom/fix"])
            .current_dir(repo)
            .status()
            .unwrap();
        let next = unique_branch_name(repo, "custom/fix", "deadbeef");
        assert_eq!(next, "custom/fix-2");
    }
}
