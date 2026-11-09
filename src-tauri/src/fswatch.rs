//! Per-workspace filesystem watcher. Each registered worktree path
//! gets a debounced watcher; when any non-`.git/` file changes, we
//! emit a `worktree-changed` Tauri event so the UI can refetch
//! `git_status` without polling.

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const DEBOUNCE: Duration = Duration::from_millis(300);
pub const WORKTREE_CHANGED_EVENT: &str = "worktree-changed";

/// Directory names whose contents never change what `git status` reports
/// for tracked work, but which an agent churns constantly (`npm install`,
/// a build, a test loop). Watching them recursively fires the whole
/// diff/status cascade off pure noise (A8), so we drop any event under one
/// of these (matched on a path *component*, so a file literally named
/// `dist.ts` is unaffected). `.git` is handled here too. This is the free
/// first pass; whatever survives it is checked against the repo's own
/// ignore rules (`IgnoreFilter`).
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".next", ".turbo"];
/// Build-output names that are also common source folder names
/// (`src/build/`, `tests/coverage/`): ignored only at the worktree root.
const IGNORED_ROOT_DIRS: &[&str] = &["build", "coverage"];
/// Remembered ignore answers per watcher before the memo starts over.
const IGNORE_MEMO_CAP: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChangedPayload {
    pub workspace_id: String,
    /// Worktree-relative paths that changed in this debounce window, so the
    /// frontend can invalidate only the affected diff queries instead of
    /// the whole set (A3). Best-effort: empty when paths can't be made
    /// relative, in which case the frontend should fall back to a full
    /// refresh.
    pub paths: Vec<String>,
}

/// True when any component of `rel` is an ignored build/vcs dir, or its
/// first one is a root-only one.
fn is_ignored(rel: &Path) -> bool {
    rel.components().enumerate().any(|(i, c)| match c {
        Component::Normal(os) => {
            let name = os.to_string_lossy();
            IGNORED_DIRS.contains(&name.as_ref())
                || (i == 0 && IGNORED_ROOT_DIRS.contains(&name.as_ref()))
        }
        _ => false,
    })
}

/// Drops changes to paths the repository ignores. Ignored files are
/// exactly what the task's diff (`ls-files -o --exclude-standard`) and the
/// Files tree leave out, so a change there moves nothing either one shows.
/// That covers every project's own build dirs (`.svelte-kit/`, `out/`,
/// `*.log`), not just the static list.
///
/// One `git check-ignore` per debounce batch, for the paths it hasn't seen
/// before. Answers are memoized per path and forgotten when a
/// `.gitignore` changes.
struct IgnoreFilter {
    root: PathBuf,
    memo: HashMap<String, bool>,
    #[cfg(test)]
    checks: usize,
}

impl IgnoreFilter {
    fn new(root: PathBuf) -> Self {
        Self {
            root,
            memo: HashMap::new(),
            #[cfg(test)]
            checks: 0,
        }
    }

    /// `changed` minus what the repo ignores. If git can't answer (not a
    /// repository, git missing), everything is kept: a spurious refresh is
    /// cheaper than a missed one.
    fn retain_relevant(&mut self, changed: BTreeSet<String>) -> BTreeSet<String> {
        if changed
            .iter()
            .any(|p| p == ".gitignore" || p.ends_with("/.gitignore"))
        {
            self.memo.clear();
        }
        let unknown: Vec<&str> = changed
            .iter()
            .map(String::as_str)
            .filter(|p| !self.memo.contains_key(*p))
            .collect();
        if !unknown.is_empty() {
            #[cfg(test)]
            {
                self.checks += 1;
            }
            match crate::git::check_ignored(&self.root, &unknown) {
                Ok(ignored) => {
                    if self.memo.len() + unknown.len() > IGNORE_MEMO_CAP {
                        self.memo.clear();
                    }
                    for path in unknown {
                        self.memo.insert(path.to_string(), ignored.contains(path));
                    }
                }
                Err(_) => return changed,
            }
        }
        changed
            .into_iter()
            .filter(|p| !self.memo.get(p).copied().unwrap_or(false))
            .collect()
    }
}

/// Maps `workspace_id → Debouncer`. Dropping a debouncer stops the
/// watcher; we just remove it from the map.
pub struct WorktreeWatchRegistry {
    app: AppHandle,
    watchers: Mutex<HashMap<String, Debouncer<notify::RecommendedWatcher>>>,
}

impl WorktreeWatchRegistry {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Begin watching `path` for the given workspace. If the
    /// workspace is already being watched, this is a no-op so quick
    /// remount cycles in the UI don't churn the underlying watcher.
    pub fn start(&self, workspace_id: String, path: PathBuf) {
        if !path.exists() {
            return;
        }
        if self.watchers.lock().contains_key(&workspace_id) {
            return;
        }

        let app = self.app.clone();
        let ws_id_for_cb = workspace_id.clone();
        let root = path.clone();
        let mut ignore = IgnoreFilter::new(path.clone());
        let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            // Collect the worktree-relative paths of the changed files,
            // dropping git bookkeeping (`.git/`), noisy build dirs and
            // anything the repo ignores: writes there don't move tracked
            // work and would otherwise re-fire the whole diff/status
            // cascade (A8). BTreeSet dedups and gives a stable order.
            let mut changed: BTreeSet<String> = BTreeSet::new();
            for event in &events {
                let Ok(rel) = event.path.strip_prefix(&root) else {
                    continue;
                };
                if rel.as_os_str().is_empty() || is_ignored(rel) {
                    continue;
                }
                changed.insert(rel.to_string_lossy().into_owned());
            }
            if changed.is_empty() {
                return;
            }
            // Runs on the debouncer's own thread, so the git call is fine.
            let changed = ignore.retain_relevant(changed);
            if changed.is_empty() {
                return;
            }
            // The task's board card shows its diff: drop the cached one.
            if let Some(board) = app.try_state::<crate::orchestrator::TaskBoard>() {
                board.invalidate_diff(&ws_id_for_cb);
            }
            let _ = app.emit(
                WORKTREE_CHANGED_EVENT,
                WorktreeChangedPayload {
                    workspace_id: ws_id_for_cb.clone(),
                    paths: changed.into_iter().collect(),
                },
            );
        });

        let mut debouncer = match debouncer {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[fswatch] couldn't build debouncer for {workspace_id}: {e}");
                return;
            }
        };

        if let Err(e) = debouncer.watcher().watch(&path, RecursiveMode::Recursive) {
            eprintln!(
                "[fswatch] watch failed for {workspace_id} at {}: {e}",
                path.display()
            );
            return;
        }

        self.watchers.lock().insert(workspace_id, debouncer);
    }

    /// Stop watching this workspace (no-op if not registered).
    pub fn stop(&self, workspace_id: &str) {
        self.watchers.lock().remove(workspace_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_build_and_vcs_dirs_by_component() {
        assert!(is_ignored(Path::new("node_modules/foo/bar.js")));
        assert!(is_ignored(Path::new("target/debug/phasr")));
        assert!(is_ignored(Path::new("dist/index.html")));
        assert!(is_ignored(Path::new(".git/index")));
        assert!(is_ignored(Path::new("crates/x/target/out")));
    }

    #[test]
    fn keeps_real_source_files() {
        assert!(!is_ignored(Path::new("src/main.rs")));
        // `dist` only matches a whole component, not a filename prefix.
        assert!(!is_ignored(Path::new("src/dist.ts")));
        assert!(!is_ignored(Path::new("README.md")));
    }

    #[test]
    fn framework_caches_anywhere_build_and_coverage_only_at_the_root() {
        assert!(is_ignored(Path::new(".next/cache/x")));
        assert!(is_ignored(Path::new("apps/web/.next/server/a.js")));
        assert!(is_ignored(Path::new(".turbo/cookies/1")));
        assert!(is_ignored(Path::new("build/index.js")));
        assert!(is_ignored(Path::new("coverage/lcov.info")));
        // Common source folder names further down are real work.
        assert!(!is_ignored(Path::new("src/build/config.ts")));
        assert!(!is_ignored(Path::new("tests/coverage/thresholds.ts")));
        assert!(!is_ignored(Path::new("build.rs")));
    }

    fn set(paths: &[&str]) -> BTreeSet<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn the_repos_own_ignore_rules_drop_changes_and_are_memoized() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let git = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .args(args)
                .current_dir(p)
                .status()
                .unwrap()
                .success())
        };
        git(&["init", "-q"]);
        std::fs::write(p.join(".gitignore"), ".svelte-kit/\n*.log\n").unwrap();
        let mut filter = IgnoreFilter::new(p.to_path_buf());

        let batch = set(&[".svelte-kit/output/a.js", "debug.log", "src/app.ts"]);
        assert_eq!(filter.retain_relevant(batch.clone()), set(&["src/app.ts"]));
        assert_eq!(filter.checks, 1);
        // Same paths again: answered from the memo, no git.
        assert_eq!(filter.retain_relevant(batch), set(&["src/app.ts"]));
        assert_eq!(filter.checks, 1);

        // A .gitignore edit forgets every answer.
        std::fs::write(p.join(".gitignore"), "*.log\n").unwrap();
        let out =
            filter.retain_relevant(set(&[".gitignore", ".svelte-kit/output/a.js", "debug.log"]));
        assert_eq!(out, set(&[".gitignore", ".svelte-kit/output/a.js"]));
        assert_eq!(filter.checks, 2);
    }

    #[test]
    fn without_git_answers_every_change_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let mut filter = IgnoreFilter::new(dir.path().to_path_buf());
        let batch = set(&["a.log", "b.ts"]);
        assert_eq!(filter.retain_relevant(batch.clone()), batch);
    }
}
