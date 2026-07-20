//! Per-workspace filesystem watcher. Each registered worktree path
//! gets a debounced watcher; when any non-`.git/` file changes, we
//! emit a `worktree-changed` Tauri event so the UI can refetch
//! `git_status` without polling.

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::tickets::{BriefSection, TicketWriteRegistry};

const DEBOUNCE: Duration = Duration::from_millis(300);
pub const WORKTREE_CHANGED_EVENT: &str = "worktree-changed";
/// Emitted when a ticket's brief SECTION file changes on disk by something other
/// than our own write (T7). Same `phasr://` family as `task-status` etc.
pub const TICKET_CHANGED_EVENT: &str = "phasr://ticket-changed";

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

// ── T7: per-ticket brief watcher ─────────────────────────────────────────────

/// The `phasr://ticket-changed` payload: the ticket + the brief SECTIONS that
/// changed on disk. Mirrors `WorktreeChangedPayload` (the watcher's emit shape
/// lives here, next to the machinery that fires it). Frozen §C.1 wire contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketChangedPayload {
    pub ticket_id: String,
    pub sections: Vec<BriefSection>,
}

/// Per-ticket filesystem watcher (T7). Mirrors `WorktreeWatchRegistry` but scoped
/// to one ticket dir (`<repo>/.phasr/tickets/<id>/`, watched NON-recursively so
/// `assets/` churn is ignored). On an EXTERNAL edit to a brief section file it
/// emits `phasr://ticket-changed` with the changed sections; OWN writes are
/// suppressed by hash via the SHARED `TicketWriteRegistry` (architect #2), so a
/// `write_ticket_section` save never round-trips as a phantom "changed on disk".
///
/// Honesty (architect #1): the watcher does NOT stamp `.meta.json`. The agent is
/// read-only on the brief in Phase 2, so an external edit's real author is the
/// human's editor or git — attributed NEUTRALLY (no `by:"agent"`; a section with
/// no `.meta.json` entry already reads back `lastEditedBy: null`).
pub struct TicketWatchRegistry {
    app: AppHandle,
    write_registry: Arc<TicketWriteRegistry>,
    watchers: Mutex<HashMap<String, Debouncer<notify::RecommendedWatcher>>>,
}

impl TicketWatchRegistry {
    pub fn new(app: AppHandle, write_registry: Arc<TicketWriteRegistry>) -> Self {
        Self {
            app,
            write_registry,
            watchers: Mutex::new(HashMap::new()),
        }
    }

    /// Begin watching `dir` for the given ticket. Already-watched / missing dir
    /// is a no-op, so a quick remount cycle in the UI doesn't churn the watcher
    /// (mirrors `WorktreeWatchRegistry::start`).
    pub fn start(&self, ticket_id: String, dir: PathBuf) {
        if !dir.exists() {
            return;
        }
        if self.watchers.lock().contains_key(&ticket_id) {
            return;
        }

        let app = self.app.clone();
        let write_registry = self.write_registry.clone();
        let ticket_for_cb = ticket_id.clone();
        let root = dir.clone();
        let debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let paths: Vec<PathBuf> = events.into_iter().map(|e| e.path).collect();
            let sections = changed_sections(&paths, &root, &write_registry);
            if sections.is_empty() {
                return;
            }
            let _ = app.emit(
                TICKET_CHANGED_EVENT,
                TicketChangedPayload {
                    ticket_id: ticket_for_cb.clone(),
                    sections,
                },
            );
        });

        let mut debouncer = match debouncer {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[fswatch] couldn't build ticket debouncer for {ticket_id}: {e}");
                return;
            }
        };

        // Non-recursive: we only care about the three text section files directly
        // under the ticket dir; `assets/` writes must never raise a section event.
        if let Err(e) = debouncer.watcher().watch(&dir, RecursiveMode::NonRecursive) {
            eprintln!(
                "[fswatch] ticket watch failed for {ticket_id} at {}: {e}",
                dir.display()
            );
            return;
        }

        self.watchers.lock().insert(ticket_id, debouncer);
    }

    /// Stop watching this ticket (no-op if not registered).
    pub fn stop(&self, ticket_id: &str) {
        self.watchers.lock().remove(ticket_id);
    }
}

/// Translate a debounce window's changed paths into the brief SECTIONS to emit,
/// dropping our OWN writes (hash-matched via the write registry) and any
/// non-section file. Pure over `&[PathBuf]` (not the notify event type) so the
/// suppression logic is unit-testable without an OS watcher.
fn changed_sections(
    paths: &[PathBuf],
    root: &Path,
    write_registry: &TicketWriteRegistry,
) -> Vec<BriefSection> {
    let mut sections: Vec<BriefSection> = Vec::new();
    for path in paths {
        // Only a file DIRECTLY under the ticket dir maps to a section.
        let Ok(rel) = path.strip_prefix(root) else {
            continue;
        };
        let Some(name) = rel.to_str() else { continue };
        let Some(section) = BriefSection::from_file_name(name) else {
            continue;
        };
        // Own-write suppression (architect #2): if the file currently holds
        // EXACTLY the bytes we last wrote, this is our own save echoing back —
        // drop it. A read failure (a delete) is treated as a real change.
        if let Ok(bytes) = std::fs::read(path) {
            if write_registry.matches(path, &bytes) {
                continue;
            }
        }
        if !sections.contains(&section) {
            sections.push(section);
        }
    }
    sections
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

    // T7: the co-editing crux. An EXTERNAL edit to a section file emits that
    // section, but an OWN write (recorded in the shared registry, byte-identical
    // on disk) is SUPPRESSED — the FE never sees a phantom "changed on disk" for
    // its own save (architect #2). Non-section files never map to a section.
    #[test]
    fn external_section_edit_emits_but_own_write_is_suppressed() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let prd = root.join("prd.md");
        let registry = TicketWriteRegistry::default();

        // 1. An external edit to prd.md → emitted as [Prd].
        std::fs::write(&prd, "external edit").unwrap();
        assert_eq!(
            changed_sections(&[prd.clone()], root, &registry),
            vec![BriefSection::Prd]
        );

        // 2. Our own write (registry records the exact bytes on disk) → suppressed.
        let ours = b"our own save";
        std::fs::write(&prd, ours).unwrap();
        registry.record(&prd, ours);
        assert!(
            changed_sections(&[prd.clone()], root, &registry).is_empty(),
            "an own write must not round-trip as an external change"
        );

        // 3. A later EXTERNAL edit over our own write → emitted again (hash differs).
        std::fs::write(&prd, "someone else edited").unwrap();
        assert_eq!(
            changed_sections(&[prd.clone()], root, &registry),
            vec![BriefSection::Prd]
        );

        // 4. ticket.md maps to Description; multiple changed sections dedup.
        let ticket_md = root.join("ticket.md");
        std::fs::write(&ticket_md, "# T\n\nbody").unwrap();
        let mut sections = changed_sections(&[ticket_md.clone(), prd.clone(), prd.clone()], root, &registry);
        sections.sort_by_key(|s| format!("{s:?}"));
        assert_eq!(sections, vec![BriefSection::Description, BriefSection::Prd]);

        // 5. A non-section file (figma.json) never maps to a section.
        let figma = root.join("figma.json");
        std::fs::write(&figma, "[]").unwrap();
        assert!(changed_sections(&[figma], root, &registry).is_empty());
    }
}
