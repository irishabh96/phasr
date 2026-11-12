//! Settings → Worktrees: what's on disk for a repository, how big it is,
//! and removing it.
//!
//! "Orphaned" = a worktree git still knows about, under one of phasr's
//! worktree bases, that no live task points at (its task was deleted, or
//! the row never synced to this machine). Worktrees elsewhere were made by
//! the user and are listed but never offered for removal.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use thiserror::Error;

use crate::domain::board::Lane;
use crate::domain::{Workspace, WorkspaceKind};
use crate::git::WorktreeRef;
use crate::util::proc::run_with_timeout;

/// Per-worktree ceiling for `du`; a huge `node_modules` on a slow disk
/// reports "unknown" rather than holding up the whole list.
pub const SIZE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryWorktree {
    pub path: String,
    pub branch: Option<String>,
    pub workspace_id: Option<String>,
    pub task_name: Option<String>,
    /// The task's Board lane (filled by the command layer).
    pub lane: Option<Lane>,
    pub orphaned: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSize {
    pub path: String,
    /// `None` when `du` failed or timed out.
    pub bytes: Option<u64>,
}

#[derive(Debug, Error)]
pub enum WorktreeRemoveError {
    #[error("the repository's own checkout can't be removed")]
    MainCheckout,
    #[error("`{0}` isn't a worktree of this repository")]
    NotAWorktree(String),
    #[error("`{0}` isn't in a phasr worktree folder; remove it yourself")]
    OutsideBase(String),
    #[error("`{0}` has a running agent; stop the task first")]
    Running(String),
    /// Removal is `git worktree remove --force` + delete: uncommitted work
    /// (and commits kept nowhere else) would be destroyed. Refused unless
    /// the caller passes `force`.
    #[error("uncommitted changes or unpushed commits would be lost in: {}; remove anyway to discard them", .0.join(", "))]
    UnsavedWork(Vec<String>),
}

fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn under_any(path: &Path, bases: &[PathBuf]) -> bool {
    let path = canonical(path);
    bases.iter().any(|b| {
        let b = canonical(b);
        path != b && path.starts_with(&b)
    })
}

/// Every git worktree of the repository except its main checkout and ones
/// whose directory is gone (git calls those prunable), matched to the
/// user's tasks by path. Pure; `refs` from `git::list_worktrees`.
pub fn classify(
    main_checkout: &Path,
    bases: &[PathBuf],
    refs: &[WorktreeRef],
    tasks: &[Workspace],
) -> Vec<RepositoryWorktree> {
    let main = canonical(main_checkout);
    let by_path: HashMap<PathBuf, &Workspace> = tasks
        .iter()
        .filter(|w| w.workspace_kind == WorkspaceKind::Agent)
        .filter_map(|w| {
            w.worktree_path
                .as_deref()
                .map(|p| (canonical(Path::new(p)), w))
        })
        .collect();
    refs.iter()
        .filter_map(|r| {
            let path = PathBuf::from(&r.path);
            let real = canonical(&path);
            if real == main || !path.exists() {
                return None;
            }
            let task = by_path.get(&real);
            Some(RepositoryWorktree {
                path: r.path.clone(),
                branch: r.branch.clone(),
                workspace_id: task.map(|t| t.id.clone()),
                task_name: task.map(|t| t.name.clone()),
                lane: None,
                orphaned: task.is_none() && under_any(&path, bases),
            })
        })
        .collect()
}

/// Check every requested path before removing any: each must be a
/// worktree of this repository (per git), not its main checkout, inside a
/// phasr worktree base, and not running an agent — and, unless `force`,
/// not holding unsaved work (`unsaved`: dirty, or commits kept nowhere
/// else). Returns the canonical paths to remove, in request order.
/// All-or-nothing, so a bad entry in a multi-select never leaves a
/// half-done removal; every unsaved path is named in one error.
pub fn validate_removal(
    requested: &[String],
    main_checkout: &Path,
    bases: &[PathBuf],
    refs: &[WorktreeRef],
    running: &dyn Fn(&Path) -> bool,
    unsaved: &dyn Fn(&Path) -> bool,
    force: bool,
) -> Result<Vec<PathBuf>, WorktreeRemoveError> {
    let main = canonical(main_checkout);
    let registered: Vec<PathBuf> = refs.iter().map(|r| canonical(Path::new(&r.path))).collect();
    let mut out = Vec::with_capacity(requested.len());
    for raw in requested {
        let path = canonical(Path::new(raw));
        if path == main {
            return Err(WorktreeRemoveError::MainCheckout);
        }
        if !registered.contains(&path) {
            return Err(WorktreeRemoveError::NotAWorktree(raw.clone()));
        }
        if !under_any(&path, bases) {
            return Err(WorktreeRemoveError::OutsideBase(raw.clone()));
        }
        if running(&path) {
            return Err(WorktreeRemoveError::Running(raw.clone()));
        }
        if !out.contains(&path) {
            out.push(path);
        }
    }
    if !force {
        let at_risk: Vec<String> = out
            .iter()
            .filter(|p| unsaved(p))
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        if !at_risk.is_empty() {
            return Err(WorktreeRemoveError::UnsavedWork(at_risk));
        }
    }
    Ok(out)
}

/// `du -sk` of each path (KiB → bytes), all at once, each bounded by
/// `SIZE_TIMEOUT` (process-group kill on expiry). Async subprocesses, so
/// nothing blocks the runtime while `du` walks `node_modules`.
pub async fn sizes(paths: Vec<String>) -> Vec<WorktreeSize> {
    let mut set = tokio::task::JoinSet::new();
    for (i, path) in paths.into_iter().enumerate() {
        set.spawn(async move {
            let bytes = match run_with_timeout(
                "du",
                &["-sk", path.as_str()],
                None,
                &[],
                SIZE_TIMEOUT,
            )
            .await
            {
                Ok(out) if out.status.success() => {
                    parse_du_kib(&String::from_utf8_lossy(&out.stdout))
                        .map(|kib| kib.saturating_mul(1024))
                }
                _ => None,
            };
            (i, WorktreeSize { path, bytes })
        });
    }
    let mut out = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok(entry) = joined {
            out.push(entry);
        }
    }
    out.sort_by_key(|(i, _)| *i);
    out.into_iter().map(|(_, s)| s).collect()
}

fn parse_du_kib(stdout: &str) -> Option<u64> {
    stdout.split_whitespace().next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wt(path: &Path, branch: &str) -> WorktreeRef {
        WorktreeRef {
            path: path.to_string_lossy().into_owned(),
            branch: Some(branch.into()),
            head: None,
        }
    }

    struct Layout {
        _dir: tempfile::TempDir,
        main: PathBuf,
        base: PathBuf,
        task_wt: PathBuf,
        orphan_wt: PathBuf,
        external_wt: PathBuf,
        gone_wt: PathBuf,
    }

    fn layout() -> Layout {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("repo");
        let base = dir.path().join("wt");
        let task_wt = base.join("task-1");
        let orphan_wt = base.join("old-task");
        let external_wt = dir.path().join("elsewhere/hotfix");
        let gone_wt = base.join("pruned");
        for p in [&main, &task_wt, &orphan_wt, &external_wt] {
            std::fs::create_dir_all(p).unwrap();
        }
        Layout {
            _dir: dir,
            main,
            base,
            task_wt,
            orphan_wt,
            external_wt,
            gone_wt,
        }
    }

    fn task(path: &Path) -> Workspace {
        let mut w = Workspace::new("repo-1".into(), "Fix login".into(), "c".into());
        w.worktree_path = Some(path.to_string_lossy().into_owned());
        w
    }

    #[test]
    fn orphans_are_phasr_worktrees_without_a_task() {
        let l = layout();
        let refs = vec![
            wt(&l.main, "main"),
            wt(&l.task_wt, "phasr/fix-login"),
            wt(&l.orphan_wt, "phasr/old"),
            wt(&l.external_wt, "hotfix"),
            wt(&l.gone_wt, "phasr/gone"),
        ];
        let t = task(&l.task_wt);
        let mut local = task(&l.main);
        local.workspace_kind = WorkspaceKind::Local;
        let listed = classify(
            &l.main,
            std::slice::from_ref(&l.base),
            &refs,
            &[t.clone(), local],
        );
        assert_eq!(
            listed.len(),
            3,
            "main checkout and missing dirs are left out: {listed:?}"
        );
        let by = |p: &Path| listed.iter().find(|w| Path::new(&w.path) == p).unwrap();
        let attached = by(&l.task_wt);
        assert_eq!(attached.workspace_id.as_deref(), Some(t.id.as_str()));
        assert_eq!(attached.task_name.as_deref(), Some("Fix login"));
        assert!(!attached.orphaned);
        let orphan = by(&l.orphan_wt);
        assert!(orphan.orphaned && orphan.workspace_id.is_none());
        let external = by(&l.external_wt);
        assert!(!external.orphaned, "not phasr's: listed, never an orphan");
    }

    #[test]
    fn removal_refuses_the_main_checkout_strangers_and_out_of_base_paths() {
        let l = layout();
        let refs = vec![
            wt(&l.main, "main"),
            wt(&l.task_wt, "phasr/fix"),
            wt(&l.orphan_wt, "phasr/old"),
            wt(&l.external_wt, "hotfix"),
        ];
        let bases = vec![l.base.clone()];
        let idle = |_: &Path| false;
        let s = |p: &Path| p.to_string_lossy().into_owned();

        assert!(matches!(
            validate_removal(&[s(&l.main)], &l.main, &bases, &refs, &idle, &idle, false),
            Err(WorktreeRemoveError::MainCheckout)
        ));
        assert!(matches!(
            validate_removal(
                &[s(&l.external_wt)],
                &l.main,
                &bases,
                &refs,
                &idle,
                &idle,
                false
            ),
            Err(WorktreeRemoveError::OutsideBase(_))
        ));
        // Under the base but not one of this repository's worktrees (another
        // repo's task, or a stray dir).
        let stray = l.base.join("someone-elses");
        std::fs::create_dir_all(&stray).unwrap();
        assert!(matches!(
            validate_removal(&[s(&stray)], &l.main, &bases, &refs, &idle, &idle, false),
            Err(WorktreeRemoveError::NotAWorktree(_))
        ));
        // The base folder itself is never "under" itself.
        let with_base = [refs.clone(), vec![wt(&l.base, "x")]].concat();
        assert!(matches!(
            validate_removal(
                &[s(&l.base)],
                &l.main,
                &bases,
                &with_base,
                &idle,
                &idle,
                false
            ),
            Err(WorktreeRemoveError::OutsideBase(_))
        ));
        // A running task's worktree.
        let task_wt = canonical(&l.task_wt);
        let running = move |p: &Path| p == task_wt;
        assert!(matches!(
            validate_removal(
                &[s(&l.task_wt)],
                &l.main,
                &bases,
                &refs,
                &running,
                &idle,
                false
            ),
            Err(WorktreeRemoveError::Running(_))
        ));
        // All-or-nothing: one bad path refuses the batch.
        assert!(validate_removal(
            &[s(&l.orphan_wt), s(&l.main)],
            &l.main,
            &bases,
            &refs,
            &idle,
            &idle,
            false
        )
        .is_err());
        // Good ones pass, deduplicated.
        let ok = validate_removal(
            &[s(&l.orphan_wt), s(&l.task_wt), s(&l.orphan_wt)],
            &l.main,
            &bases,
            &refs,
            &idle,
            &idle,
            false,
        )
        .unwrap();
        assert_eq!(ok, vec![canonical(&l.orphan_wt), canonical(&l.task_wt)]);
    }

    /// Dirty / unpushed worktrees are refused (all named) unless forced.
    #[test]
    fn removal_refuses_unsaved_work_unless_forced() {
        let l = layout();
        let refs = vec![
            wt(&l.main, "main"),
            wt(&l.task_wt, "phasr/fix"),
            wt(&l.orphan_wt, "phasr/old"),
        ];
        let bases = vec![l.base.clone()];
        let idle = |_: &Path| false;
        let everything = |_: &Path| true;
        let s = |p: &Path| p.to_string_lossy().into_owned();
        let both = [s(&l.task_wt), s(&l.orphan_wt)];
        match validate_removal(&both, &l.main, &bases, &refs, &idle, &everything, false) {
            Err(WorktreeRemoveError::UnsavedWork(paths)) => {
                assert_eq!(
                    paths,
                    vec![s(&canonical(&l.task_wt)), s(&canonical(&l.orphan_wt))]
                );
            }
            other => panic!("expected UnsavedWork, got {other:?}"),
        }
        let forced =
            validate_removal(&both, &l.main, &bases, &refs, &idle, &everything, true).unwrap();
        assert_eq!(forced.len(), 2);
        // `force` never overrides the hard refusals.
        let task_wt = canonical(&l.task_wt);
        let running = move |p: &Path| p == task_wt;
        assert!(matches!(
            validate_removal(&both, &l.main, &bases, &refs, &running, &idle, true),
            Err(WorktreeRemoveError::Running(_))
        ));
    }

    #[tokio::test]
    async fn sizes_reports_bytes_and_null_for_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f"), vec![0u8; 64 * 1024]).unwrap();
        let missing = dir.path().join("missing").to_string_lossy().into_owned();
        let found = dir.path().to_string_lossy().into_owned();
        let out = sizes(vec![found.clone(), missing.clone()]).await;
        assert_eq!(out[0].path, found);
        assert!(out[0].bytes.unwrap() >= 64 * 1024, "{out:?}");
        assert_eq!(
            out[1],
            WorktreeSize {
                path: missing,
                bytes: None
            }
        );
        assert_eq!(parse_du_kib("128\t/x\n"), Some(128));
        assert_eq!(parse_du_kib(""), None);
    }
}
