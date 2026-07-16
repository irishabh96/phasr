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
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(300);
pub const WORKTREE_CHANGED_EVENT: &str = "worktree-changed";

/// Directory names whose contents never change what `git status` reports
/// for tracked work, but which an agent churns constantly (`npm install`,
/// a build, a test loop). Watching them recursively fires the whole
/// diff/status cascade off pure noise (A8), so we drop any event under one
/// of these (matched on a path *component*, so a file literally named
/// `dist.ts` is unaffected). `.git` is handled here too.
const IGNORED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist"];

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

/// True when any component of `rel` is an ignored build/vcs dir.
fn is_ignored(rel: &Path) -> bool {
    rel.components().any(|c| match c {
        Component::Normal(os) => {
            let name = os.to_string_lossy();
            IGNORED_DIRS.iter().any(|dir| *dir == name.as_ref())
        }
        _ => false,
    })
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
        let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            // Collect the worktree-relative paths of the changed files,
            // dropping git bookkeeping (`.git/`) and noisy build dirs
            // (`node_modules`, `target`, `dist`) — writes there don't move
            // tracked work and would otherwise re-fire the whole diff/status
            // cascade (A8). BTreeSet dedups and gives a stable order.
            let mut changed: BTreeSet<String> = BTreeSet::new();
            for event in &events {
                let Ok(rel) = event.path.strip_prefix(&root) else {
                    continue;
                };
                if is_ignored(rel) {
                    continue;
                }
                changed.insert(rel.to_string_lossy().into_owned());
            }
            if changed.is_empty() {
                return;
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
}
