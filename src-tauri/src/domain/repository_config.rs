//! Per-repository rules (Settings → Worktrees / Branch rules). Local to
//! this machine: `repository_config` never syncs.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::Agent;
use super::settings::UserSettings;

/// Built-in branch template when neither the repository nor the user set one.
pub const DEFAULT_BRANCH_TEMPLATE: &str = "phasr/{{slug}}";

/// Whether an agent may `git push` on its own.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PushPolicy {
    /// The agent must ask (Claude: a `permissions.ask` rule).
    #[default]
    Ask,
    /// No rule: the task's permission mode decides.
    Allow,
    /// Never (Claude: a `permissions.deny` rule).
    Deny,
}

/// What "Approve & create PR" opens by default.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PrMode {
    #[default]
    Draft,
    Ready,
}

/// What happens to a task's worktree + local branch once it's merged.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CleanupAfterMerge {
    /// An inbox entry suggests it.
    #[default]
    Ask,
    Always,
    Never,
}

macro_rules! lenient_enum {
    ($ty:ty { $($variant:ident => $s:literal),+ $(,)? }) => {
        impl $ty {
            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $s),+ }
            }
            /// Unknown text (a newer build's value, a hand edit) reads as
            /// the default rather than making the row unreadable.
            pub fn from_str_lenient(s: &str) -> Self {
                match s { $($s => Self::$variant,)+ _ => Self::default() }
            }
        }
    };
}

lenient_enum!(PushPolicy { Ask => "ask", Allow => "allow", Deny => "deny" });
lenient_enum!(PrMode { Draft => "draft", Ready => "ready" });
lenient_enum!(CleanupAfterMerge { Ask => "ask", Always => "always", Never => "never" });

/// Agents phasr can actually hold to `protected_paths` / `agents_may_push`
/// (it writes their permission rules). Others run unrestricted by these;
/// the UI says so.
pub const POLICY_ENFORCED_AGENTS: &[Agent] = &[Agent::Claude];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryConfig {
    pub repository_id: String,
    /// `None` → the repository's default branch.
    pub default_base_branch: Option<String>,
    pub fetch_base_before_task: bool,
    pub agents_may_push: PushPolicy,
    pub pr_mode: PrMode,
    /// Globs (relative to the worktree) the agent must ask before editing.
    pub protected_paths: Vec<String>,
    /// Globs of untracked/ignored files copied from the checkout into each
    /// new worktree (`.env`, `config/*.local`), never overwriting.
    pub copy_untracked_globs: Vec<String>,
    pub cleanup_after_merge: CleanupAfterMerge,
    /// "After creating": runs once in a new task worktree, before the agent.
    pub pre_task_hook: Option<String>,
    /// Overrides `UserSettings::branch_prefix_template` for this repository.
    pub branch_prefix_template: Option<String>,
    /// Overrides `UserSettings::worktree_base_path` for this repository.
    pub worktree_base_path: Option<String>,
    /// Read-only: which agents the push / protected-path rules bind.
    pub policy_enforced_for: Vec<Agent>,
    /// `None` = never saved (all defaults).
    pub updated_at: Option<DateTime<Utc>>,
}

impl RepositoryConfig {
    pub fn defaults(repository_id: impl Into<String>) -> Self {
        Self {
            repository_id: repository_id.into(),
            default_base_branch: None,
            fetch_base_before_task: false,
            agents_may_push: PushPolicy::default(),
            pr_mode: PrMode::default(),
            protected_paths: Vec::new(),
            copy_untracked_globs: Vec::new(),
            cleanup_after_merge: CleanupAfterMerge::default(),
            pre_task_hook: None,
            branch_prefix_template: None,
            worktree_base_path: None,
            policy_enforced_for: POLICY_ENFORCED_AGENTS.to_vec(),
            updated_at: None,
        }
    }

    /// Branch template precedence: this repository's override, else the
    /// user's setting, else `phasr/{{slug}}`. Blank counts as unset.
    pub fn branch_template<'a>(&'a self, settings: &'a UserSettings) -> &'a str {
        non_blank(self.branch_prefix_template.as_deref())
            .or_else(|| non_blank(Some(settings.branch_prefix_template.as_str())))
            .unwrap_or(DEFAULT_BRANCH_TEMPLATE)
    }

    /// Worktree base precedence (unexpanded): repository override, else the
    /// user's setting. `None` → phasr's default location.
    pub fn worktree_base<'a>(&'a self, settings: &'a UserSettings) -> Option<&'a str> {
        non_blank(self.worktree_base_path.as_deref())
            .or_else(|| non_blank(Some(settings.worktree_base_path.as_str())))
    }

    pub fn after_create_hook(&self) -> Option<&str> {
        non_blank(self.pre_task_hook.as_deref())
    }

    pub fn base_branch(&self) -> Option<&str> {
        non_blank(self.default_base_branch.as_deref())
    }
}

/// Whether `name` may be handed to git as a base branch. Branch names
/// reach `git fetch` / `worktree add` / `merge-base` / `checkout` as
/// arguments, and a per-task base is a SYNCED column — so another machine
/// (or a crafted row) could supply `--upload-pack=…`. A leading `-` would
/// be parsed as an option; whitespace and control characters are never
/// part of a real branch name. (git's own `check-ref-format` rules are
/// stricter still; git rejects the rest itself.)
pub fn validate_branch_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.starts_with('-')
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(format!("`{name}` isn't a branch name"));
    }
    Ok(())
}

fn non_blank(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// A JSON array of strings as stored; anything else reads as empty.
pub fn globs_from_json(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

pub fn globs_to_json(globs: &[String]) -> String {
    serde_json::to_string(globs).unwrap_or_else(|_| "[]".into())
}

/// Normalise and validate one user-entered glob: trimmed, a leading `./`
/// dropped, and relative to the worktree — an absolute pattern or a `..`
/// would point copy/protect rules outside it. Blank → `Ok(None)` (skipped).
pub fn normalize_glob(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();
    let trimmed = trimmed.strip_prefix("./").unwrap_or(trimmed);
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.starts_with('/') || trimmed.starts_with('~') {
        return Err(format!("`{raw}` must be relative to the repository"));
    }
    if trimmed.split('/').any(|part| part == "..") {
        return Err(format!("`{raw}` may not contain `..`"));
    }
    if trimmed.split('/').any(|part| part.eq_ignore_ascii_case(".git")) {
        return Err(format!("`{raw}` may not point into `.git`"));
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(format!("`{raw}` contains a control character"));
    }
    Ok(Some(trimmed.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_wire_shape() {
        let cfg = RepositoryConfig::defaults("r1");
        let json = serde_json::to_value(&cfg).unwrap();
        assert_eq!(json["repositoryId"], "r1");
        assert_eq!(json["agentsMayPush"], "ask");
        assert_eq!(json["prMode"], "draft");
        assert_eq!(json["cleanupAfterMerge"], "ask");
        assert_eq!(json["fetchBaseBeforeTask"], false);
        assert_eq!(json["protectedPaths"], serde_json::json!([]));
        assert_eq!(json["policyEnforcedFor"], serde_json::json!(["claude"]));
        assert!(json["defaultBaseBranch"].is_null());
    }

    #[test]
    fn enums_read_leniently() {
        assert_eq!(PushPolicy::from_str_lenient("deny"), PushPolicy::Deny);
        assert_eq!(PushPolicy::from_str_lenient("sometimes"), PushPolicy::Ask);
        assert_eq!(PrMode::from_str_lenient("ready"), PrMode::Ready);
        assert_eq!(CleanupAfterMerge::from_str_lenient("always"), CleanupAfterMerge::Always);
        assert_eq!(CleanupAfterMerge::from_str_lenient(""), CleanupAfterMerge::Ask);
        for p in [PushPolicy::Ask, PushPolicy::Allow, PushPolicy::Deny] {
            assert_eq!(serde_json::to_value(p).unwrap(), p.as_str());
        }
    }

    #[test]
    fn branch_template_precedence_repo_then_user_then_builtin() {
        let mut settings = UserSettings::default();
        let mut cfg = RepositoryConfig::defaults("r");
        settings.branch_prefix_template = "me/{{slug}}".into();
        assert_eq!(cfg.branch_template(&settings), "me/{{slug}}");
        cfg.branch_prefix_template = Some("team/{{agent}}/{{slug}}".into());
        assert_eq!(cfg.branch_template(&settings), "team/{{agent}}/{{slug}}");
        cfg.branch_prefix_template = Some("   ".into());
        settings.branch_prefix_template = "".into();
        assert_eq!(cfg.branch_template(&settings), DEFAULT_BRANCH_TEMPLATE);
    }

    #[test]
    fn worktree_base_precedence() {
        let mut settings = UserSettings::default();
        let mut cfg = RepositoryConfig::defaults("r");
        assert_eq!(cfg.worktree_base(&settings), Some("~/.phasr/worktrees"));
        cfg.worktree_base_path = Some("/fast/wt".into());
        assert_eq!(cfg.worktree_base(&settings), Some("/fast/wt"));
        cfg.worktree_base_path = None;
        settings.worktree_base_path = " ".into();
        assert_eq!(cfg.worktree_base(&settings), None);
    }

    #[test]
    fn globs_are_validated_and_stored_leniently() {
        assert_eq!(normalize_glob(" ./.env ").unwrap().as_deref(), Some(".env"));
        assert_eq!(normalize_glob("config/**/*.local").unwrap().as_deref(), Some("config/**/*.local"));
        assert_eq!(normalize_glob("  ").unwrap(), None);
        assert!(normalize_glob("/etc/passwd").is_err());
        assert!(normalize_glob("~/.ssh/*").is_err());
        assert!(normalize_glob("../secrets").is_err());
        assert!(normalize_glob(".git/hooks/*").is_err());
        assert_eq!(globs_from_json("not json"), Vec::<String>::new());
        let globs = vec![".env".to_string(), "*.pem".to_string()];
        assert_eq!(globs_from_json(&globs_to_json(&globs)), globs);
    }

    #[test]
    fn branch_names_that_git_would_parse_as_options_are_rejected() {
        for bad in ["--upload-pack=touch /tmp/x", "-b", "", "has space", "tab\there", "nl\n"] {
            assert!(validate_branch_name(bad).is_err(), "{bad:?}");
        }
        for ok in ["main", "release/1.2", "feature-x", "origin/main", "a-b-"] {
            assert!(validate_branch_name(ok).is_ok(), "{ok}");
        }
    }
}
