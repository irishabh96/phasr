//! Per-task setup from the user's settings and the repository's rules
//! (Settings → Worktrees / Branch rules / Terminal / Agents & keys).
//!
//! A new worktree task starts in this order — each step's output goes to
//! the task log (`<log_dir>/<task>.log`, the file `read_task_log` serves):
//!
//!   1. fetch the base (optional, 60s, a failure only logs)
//!   2. cut the worktree (branch from the template, under the resolved base)
//!   3. copy untracked files into it (globs; never overwrites)
//!   4. run the "after creating" hook once (a failure only logs)
//!   5. spawn the agent (shell override, API key env, Claude rules)

use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use crate::agent_signals::AgentPolicy;
use crate::domain::{Agent, RepositoryConfig, UserSettings};
use crate::git;
use crate::secrets::ApiKeys;
use crate::store::{RepositoryConfigRepo, SettingsRepo};
use crate::util::proc::run_with_timeout;

pub const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// Long enough for a cold `pnpm install`; past it the hook is killed (its
/// whole process group) and the agent starts anyway.
pub const HOOK_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Most of a hook's output that lands in the task log.
const HOOK_LOG_CAP: usize = 64 * 1024;

/// Everything a launch needs from settings, resolved once.
#[derive(Debug, Clone)]
pub struct TaskSetup {
    pub config: RepositoryConfig,
    pub settings: UserSettings,
}

impl TaskSetup {
    /// The built-in behaviour (tests without a config source).
    pub fn defaults(repository_id: &str) -> Self {
        Self {
            config: RepositoryConfig::defaults(repository_id),
            settings: UserSettings::default(),
        }
    }

    pub fn branch_template(&self) -> &str {
        self.config.branch_template(&self.settings)
    }

    pub fn worktree_base(&self) -> PathBuf {
        git::resolve_worktree_base(self.config.worktree_base(&self.settings))
    }

    /// Every location a phasr worktree for this repository may live in:
    /// the current base, the user-level one, and the built-in default — a
    /// base changed after tasks were created must not strand them.
    pub fn known_worktree_bases(&self) -> Vec<PathBuf> {
        let mut bases = vec![
            self.worktree_base(),
            git::resolve_worktree_base(Some(self.settings.worktree_base_path.as_str())),
            git::default_worktree_base_path(),
        ];
        bases.dedup();
        bases
    }

    /// Requested base, else the repository's configured default base, else
    /// its default branch.
    pub fn base_branch(&self, requested: Option<&str>, repository_default: &str) -> String {
        requested
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .or_else(|| self.config.base_branch())
            .unwrap_or(repository_default)
            .to_string()
    }

    pub fn shell(&self) -> Option<String> {
        crate::pty::usable_shell_override(&self.settings.terminal_shell)
    }

    pub fn policy(&self) -> AgentPolicy {
        AgentPolicy {
            protected_paths: self.config.protected_paths.clone(),
            agents_may_push: self.config.agents_may_push,
        }
    }

    /// The task's branch: template → sanitised → unique in the repository.
    /// Blocking (`git show-ref`).
    pub fn branch_for(&self, repository_path: &Path, task_name: &str, task_id: &str, agent: Option<Agent>) -> String {
        let short = git::short_id(task_id);
        let rendered = git::render_branch_name(
            self.branch_template(),
            &git::slugify(task_name),
            short,
            agent.map(Agent::as_str).unwrap_or("agent"),
        );
        git::unique_branch_name(repository_path, &rendered, short)
    }
}

/// Reads settings + repository rules for each launch. `Clone` + cheap.
#[derive(Clone)]
pub struct TaskConfig {
    configs: RepositoryConfigRepo,
    settings: SettingsRepo,
    api_keys: Option<ApiKeys>,
    /// Per-machine trust for the synced command-like settings (the shell);
    /// `None` (tests) uses them as stored.
    trust: Option<crate::store::AppMetaRepo>,
}

impl TaskConfig {
    pub fn new(configs: RepositoryConfigRepo, settings: SettingsRepo, api_keys: Option<ApiKeys>) -> Self {
        Self {
            configs,
            settings,
            api_keys,
            trust: None,
        }
    }

    pub fn with_trust(mut self, meta: crate::store::AppMetaRepo) -> Self {
        self.trust = Some(meta);
        self
    }

    /// The per-machine trust store, when launches are gated by it (always
    /// in the app; `None` in tests, which run stored commands as is).
    pub fn trust(&self) -> Option<&crate::store::AppMetaRepo> {
        self.trust.as_ref()
    }

    /// Never fails a launch: an unreadable row means the built-in behaviour.
    pub async fn setup_for(&self, repository_id: &str) -> TaskSetup {
        let config = self.configs.get(repository_id).await.unwrap_or_else(|err| {
            eprintln!("repository config for {repository_id} unreadable, using defaults: {err}");
            RepositoryConfig::defaults(repository_id)
        });
        let settings = self.settings.get_or_default().await.unwrap_or_else(|err| {
            eprintln!("user settings unreadable, using defaults: {err}");
            UserSettings::default()
        });
        // A synced terminal shell / template not confirmed here isn't used.
        let settings = match &self.trust {
            Some(meta) => crate::settings_trust::usable(meta, settings).await,
            None => settings,
        };
        TaskSetup { config, settings }
    }

    pub async fn api_env(&self, agent: Agent) -> Vec<(String, String)> {
        match &self.api_keys {
            Some(keys) => keys.env_for(agent).await,
            None => Vec::new(),
        }
    }
}

/// Lines for the task log, written before the agent's PTY opens it.
#[derive(Debug, Default)]
pub struct SetupLog {
    lines: Vec<String>,
}

impl SetupLog {
    pub fn push(&mut self, line: impl Into<String>) {
        self.lines.push(line.into());
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// Append to `<log_dir>/<task_id>.log` (the PTY appends after it). CRLF:
    /// the log is terminal output and is rendered as such.
    pub fn flush(&mut self, log_dir: &Path, task_id: &str) {
        if self.lines.is_empty() {
            return;
        }
        let path = log_dir.join(format!("{task_id}.log"));
        let mut body = String::new();
        for line in self.lines.drain(..) {
            for l in line.lines() {
                body.push_str(l);
                body.push_str("\r\n");
            }
        }
        let result = std::fs::create_dir_all(log_dir).and_then(|_| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?
                .write_all(body.as_bytes())
        });
        if let Err(err) = result {
            eprintln!("couldn't write setup log for {task_id}: {err}");
        }
    }
}

/// `git fetch origin <base>`, then the ref to cut the worktree from: the
/// fetched `origin/<base>` when it's ahead of (or the only) local `<base>`,
/// else the local branch (it has commits the remote doesn't — cutting from
/// the remote would silently drop them). Any failure — no `origin`,
/// offline, a 60s timeout — is logged and the local base is used.
///
/// Runs OUTSIDE the repo lock on purpose: a slow network must not hold up
/// every other task in the repository. git's own ref locking covers the
/// remote-tracking ref it updates.
pub async fn fetch_base(repository_path: &Path, base: &str, log: &mut SetupLog) -> String {
    let local = base.to_string();
    if base.starts_with("origin/") {
        return local;
    }
    let output = run_with_timeout(
        "git",
        // `--` before the remote/refspec: `base` must never be read as an
        // option (`--upload-pack=…`), whatever validation upstream missed.
        &["fetch", "--quiet", "--", "origin", base],
        Some(repository_path),
        &[],
        FETCH_TIMEOUT,
    )
    .await;
    match output {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            log.push(format!("phasr: fetching {base} failed, starting from the local branch: {stderr}"));
            return local;
        }
        Err(err) => {
            log.push(format!("phasr: fetching {base} failed, starting from the local branch: {err}"));
            return local;
        }
    }
    let remote = format!("origin/{base}");
    let path = repository_path.to_path_buf();
    let (base_owned, remote_owned) = (base.to_string(), remote.clone());
    let pick = tokio::task::spawn_blocking(move || pick_start_point(&path, &base_owned, &remote_owned))
        .await
        .unwrap_or(None);
    match pick {
        Some(start) => {
            log.push(format!("phasr: fetched {base}; starting from {start}"));
            start
        }
        None => local,
    }
}

/// `origin/<base>` if it exists and local `<base>` is missing or an
/// ancestor of it; `<base>` otherwise. Blocking.
fn pick_start_point(repo: &Path, base: &str, remote: &str) -> Option<String> {
    let git_ok = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(repo)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if !git_ok(&["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}")]) {
        return None;
    }
    let local_exists = git_ok(&["rev-parse", "--verify", "--quiet", &format!("refs/heads/{base}")]);
    if !local_exists || git_ok(&["merge-base", "--is-ancestor", "--", base, remote]) {
        Some(remote.to_string())
    } else {
        Some(base.to_string())
    }
}

/// Copy files matching `globs` that are untracked in the checkout (ignored
/// ones included — `.env` is the point) into the new worktree, keeping
/// their relative paths. A file that already exists in the worktree (a
/// tracked one, or anything the user put there) is never overwritten;
/// symlinks and directories are skipped. Returns the copied paths.
///
/// Matching is git's own (`:(glob)` pathspecs over `ls-files --others`),
/// so `.env` means the top-level file and `**/.env` any depth. Blocking.
pub fn copy_untracked(repository_path: &Path, worktree: &Path, globs: &[String]) -> Vec<String> {
    let specs: Vec<String> = globs
        .iter()
        .filter_map(|g| crate::domain::repository_config::normalize_glob(g).ok().flatten())
        .map(|g| format!(":(glob){g}"))
        .collect();
    if specs.is_empty() {
        return Vec::new();
    }
    let mut args = vec!["ls-files", "--others", "-z", "--"];
    args.extend(specs.iter().map(String::as_str));
    let listed = match std::process::Command::new("git")
        .args(&args)
        .current_dir(repository_path)
        .output()
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).into_owned(),
        _ => return Vec::new(),
    };
    let mut copied = Vec::new();
    for rel in listed.split('\0').filter(|p| !p.is_empty() && !p.ends_with('/')) {
        if !is_clean_relative(rel) {
            continue;
        }
        let src = repository_path.join(rel);
        let dest = worktree.join(rel);
        let Ok(meta) = std::fs::symlink_metadata(&src) else { continue };
        if !meta.is_file() || std::fs::symlink_metadata(&dest).is_ok() {
            continue;
        }
        let ok = dest
            .parent()
            .map(std::fs::create_dir_all)
            .unwrap_or(Ok(()))
            .and_then(|_| {
                // `create_new` closes the check-then-write race: if anything
                // appeared at `dest` meanwhile, this fails instead of
                // clobbering it.
                let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&dest)?;
                let mut input = std::fs::File::open(&src)?;
                std::io::copy(&mut input, &mut out)?;
                out.set_permissions(meta.permissions())
            });
        match ok {
            Ok(()) => copied.push(rel.to_string()),
            Err(err) => eprintln!("couldn't copy {rel} into the worktree: {err}"),
        }
    }
    copied
}

fn is_clean_relative(rel: &str) -> bool {
    let path = Path::new(rel);
    !path.is_absolute()
        && path.components().all(|c| match c {
            Component::Normal(n) => !n.to_string_lossy().eq_ignore_ascii_case(".git"),
            _ => false,
        })
}

/// Run the "after creating" hook once in `worktree` with the login PATH,
/// output captured into `log`. Non-zero exit or timeout is logged and the
/// task continues — a broken `pnpm install` shouldn't make the agent
/// un-startable; the agent (and the user, in the log) see the state.
pub async fn run_after_create_hook(worktree: &Path, hook: &str, shell: Option<&str>, log: &mut SetupLog) {
    let shell = shell.map(str::to_string).unwrap_or_else(|| "/bin/sh".to_string());
    let path = crate::pty::login_path().await;
    log.push(format!("phasr: running after-create hook: {hook}"));
    let env = vec![("PATH".to_string(), path), ("CI".to_string(), "1".to_string())];
    match run_with_timeout(&shell, &["-c", hook], Some(worktree), &env, HOOK_TIMEOUT).await {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            if text.len() > HOOK_LOG_CAP {
                let mut cut = text.len() - HOOK_LOG_CAP;
                while !text.is_char_boundary(cut) {
                    cut += 1;
                }
                text = format!("… (earlier output trimmed)\n{}", &text[cut..]);
            }
            if !text.trim().is_empty() {
                log.push(text.trim_end().to_string());
            }
            match out.status.code() {
                Some(0) => log.push("phasr: after-create hook finished"),
                code => log.push(format!(
                    "phasr: after-create hook exited with {}; starting the agent anyway",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into())
                )),
            }
        }
        Err(err) => log.push(format!("phasr: after-create hook failed: {err}; starting the agent anyway")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git(p, &["init", "-q", "-b", "main"]);
        git(p, &["config", "user.email", "t@example.com"]);
        git(p, &["config", "user.name", "t"]);
        std::fs::write(p.join(".gitignore"), ".env\n*.local\nnode_modules/\n").unwrap();
        std::fs::write(p.join("tracked.txt"), "tracked\n").unwrap();
        git(p, &["add", "-A"]);
        git(p, &["commit", "-qm", "init"]);
        dir
    }

    #[test]
    fn copy_untracked_copies_matches_and_never_overwrites() {
        let repo = repo();
        let p = repo.path();
        std::fs::write(p.join(".env"), "SECRET=1\n").unwrap();
        std::fs::create_dir_all(p.join("config")).unwrap();
        std::fs::write(p.join("config/dev.local"), "dev\n").unwrap();
        std::fs::write(p.join("config/keep.local"), "from checkout\n").unwrap();
        std::fs::write(p.join("unrelated.tmp"), "x").unwrap();
        std::fs::create_dir_all(p.join("node_modules/pkg")).unwrap();
        std::fs::write(p.join("node_modules/pkg/.env"), "nested").unwrap();
        // Tracked files are never "untracked" candidates.
        std::fs::write(p.join("tracked.txt"), "edited in checkout\n").unwrap();

        let wt = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(wt.path().join("config")).unwrap();
        std::fs::write(wt.path().join("config/keep.local"), "already here\n").unwrap();
        std::fs::write(wt.path().join("tracked.txt"), "tracked\n").unwrap();

        let globs = vec![
            ".env".to_string(),
            "config/*.local".to_string(),
            "tracked.txt".to_string(),
            "../escape".to_string(),
        ];
        let mut copied = copy_untracked(p, wt.path(), &globs);
        copied.sort();
        assert_eq!(copied, vec![".env".to_string(), "config/dev.local".to_string()]);
        assert_eq!(std::fs::read_to_string(wt.path().join(".env")).unwrap(), "SECRET=1\n");
        assert_eq!(
            std::fs::read_to_string(wt.path().join("config/keep.local")).unwrap(),
            "already here\n",
            "existing file is never overwritten"
        );
        assert_eq!(std::fs::read_to_string(wt.path().join("tracked.txt")).unwrap(), "tracked\n");
        assert!(!wt.path().join("node_modules").exists(), "`.env` is top-level only");
        assert!(!wt.path().join("unrelated.tmp").exists());

        // `**/` reaches nested files.
        let copied = copy_untracked(p, wt.path(), &["**/.env".to_string()]);
        assert_eq!(copied, vec!["node_modules/pkg/.env".to_string()]);
        assert!(copy_untracked(p, wt.path(), &[]).is_empty());
    }

    #[test]
    fn base_and_branch_resolution_follow_precedence() {
        let mut setup = TaskSetup::defaults("r");
        assert_eq!(setup.base_branch(None, "main"), "main");
        setup.config.default_base_branch = Some("develop".into());
        assert_eq!(setup.base_branch(None, "main"), "develop");
        assert_eq!(setup.base_branch(Some("release"), "main"), "release");
        assert_eq!(setup.base_branch(Some("  "), "main"), "develop");

        let repo = repo();
        setup.settings.branch_prefix_template = "me/{{slug}}".into();
        assert_eq!(setup.branch_for(repo.path(), "Fix the bug", "abcd1234-ef", Some(Agent::Claude)), "me/fix-the-bug");
        setup.config.branch_prefix_template = Some("{{agent}}/{{slug}}".into());
        assert_eq!(setup.branch_for(repo.path(), "Fix the bug", "abcd1234-ef", Some(Agent::Codex)), "codex/fix-the-bug");
        // Unique against existing branches.
        git(repo.path(), &["branch", "codex/fix-the-bug"]);
        assert_eq!(setup.branch_for(repo.path(), "Fix the bug", "abcd1234-ef", Some(Agent::Codex)), "codex/fix-the-bug-2");
    }

    #[test]
    fn worktree_base_resolution_uses_repo_override_then_user_then_default() {
        let mut setup = TaskSetup::defaults("r");
        assert_eq!(setup.worktree_base(), git::default_worktree_base_path());
        setup.settings.worktree_base_path = "/user/wt".into();
        assert_eq!(setup.worktree_base(), PathBuf::from("/user/wt"));
        setup.config.worktree_base_path = Some("/repo/wt".into());
        assert_eq!(setup.worktree_base(), PathBuf::from("/repo/wt"));
        assert_eq!(
            setup.known_worktree_bases(),
            vec![PathBuf::from("/repo/wt"), PathBuf::from("/user/wt"), git::default_worktree_base_path()]
        );
    }

    #[tokio::test]
    async fn fetch_base_prefers_a_fresher_remote_and_survives_no_remote() {
        // A "remote" with a newer main, and a clone whose local main is behind.
        let upstream = repo();
        let clone_dir = tempfile::tempdir().unwrap();
        let clone = clone_dir.path().join("c");
        git(clone_dir.path(), &["clone", "-q", &upstream.path().to_string_lossy(), "c"]);
        std::fs::write(upstream.path().join("new.txt"), "n\n").unwrap();
        git(upstream.path(), &["add", "-A"]);
        git(upstream.path(), &["commit", "-qm", "upstream moves"]);

        let mut log = SetupLog::default();
        assert_eq!(fetch_base(&clone, "main", &mut log).await, "origin/main");
        assert_eq!(
            git(&clone, &["rev-parse", "origin/main"]),
            git(upstream.path(), &["rev-parse", "main"]),
            "fetched"
        );

        // Local commits the remote lacks → keep the local branch.
        git(&clone, &["config", "user.email", "t@example.com"]);
        git(&clone, &["config", "user.name", "t"]);
        git(&clone, &["merge", "-q", "--ff-only", "origin/main"]);
        std::fs::write(clone.join("local.txt"), "l\n").unwrap();
        git(&clone, &["add", "-A"]);
        git(&clone, &["commit", "-qm", "local only"]);
        assert_eq!(fetch_base(&clone, "main", &mut log).await, "main");

        // No origin at all: logged, local base.
        let lonely = repo();
        let mut log = SetupLog::default();
        assert_eq!(fetch_base(lonely.path(), "main", &mut log).await, "main");
        assert!(!log.is_empty());
    }

    #[tokio::test]
    async fn after_create_hook_output_goes_to_the_task_log() {
        let wt = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let mut log = SetupLog::default();
        run_after_create_hook(wt.path(), "echo hello from hook; touch made-by-hook; exit 3", None, &mut log).await;
        log.flush(logs.path(), "task-1");
        let written = std::fs::read_to_string(logs.path().join("task-1.log")).unwrap();
        assert!(written.contains("hello from hook\r\n"), "{written}");
        assert!(written.contains("exited with 3"), "{written}");
        assert!(wt.path().join("made-by-hook").exists(), "ran in the worktree");
    }
}
