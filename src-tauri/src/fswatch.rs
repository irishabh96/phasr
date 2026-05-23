//! Per-workspace filesystem watcher. Each registered worktree path
//! gets a debounced watcher; when any non-`.git/` file changes, we
//! emit a `worktree-changed` Tauri event so the UI can refetch
//! `git_status` without polling.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const DEBOUNCE: Duration = Duration::from_millis(300);
pub const WORKTREE_CHANGED_EVENT: &str = "worktree-changed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChangedPayload {
    pub workspace_id: String,
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
        let path_for_filter = path.clone();
        let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            // Filter out events under `.git/` — git's internal
            // bookkeeping (lockfiles, ref updates, object writes)
            // doesn't change what `git status` reports.
            let git_dir = path_for_filter.join(".git");
            let any_relevant = events.iter().any(|e| !e.path.starts_with(&git_dir));
            if !any_relevant {
                return;
            }
            let _ = app.emit(
                WORKTREE_CHANGED_EVENT,
                WorktreeChangedPayload {
                    workspace_id: ws_id_for_cb.clone(),
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
