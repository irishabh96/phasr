//! Orphaned-worktree GC (spec E4 — deferred at P0, promoted at Phase 2 of the
//! parent roadmap, delivered in the completion program's Phase 3).
//!
//! Every subtask spawns a worktree under `~/.phasr/worktrees/<workspace_id>`,
//! and until now NOTHING ever removed one except an explicit per-workspace
//! delete — `git worktree prune` at boot only cleans git's METADATA for dirs
//! already gone. N worktrees per workflow accumulated on disk forever.
//!
//! The sweep runs ONCE at boot, from `recover_startup_state`, BEFORE the
//! orchestrator/scheduler spawn — nothing else is touching repos yet, which is
//! why it needs no per-repo lock. It is deliberately CONSERVATIVE:
//!
//! - a dir with NO live workspace row (deleted, or not a row at all) → removed
//!   — nothing can reference it;
//! - a dir whose row is ARCHIVED → removed only when the worktree is CLEAN
//!   (porcelain-empty) AND (its branch is fully merged into the repo's default
//!   branch OR it was archived more than `GC_AGE_THRESHOLD_DAYS` ago);
//! - a dir whose row is in ANY active status → never touched;
//! - any doubt (git error, missing repo, dirty tree) → kept, with a log line.
//!
//! Deleting real work requires the explicit Delete flows; the GC only ever
//! reclaims what the product itself abandoned.

use std::path::{Path, PathBuf};

use crate::git;
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo};

/// An archived-but-unmerged worktree is kept this long after `archived_at`
/// before the sweep reclaims it (founder decision #5 — conservative default).
pub const GC_AGE_THRESHOLD_DAYS: i64 = 30;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct GcOutcome {
    pub removed: usize,
    pub kept: usize,
}

/// Sweep `base` (`git::default_worktree_base_path()` in production; injected
/// so tests never touch the real `~/.phasr/worktrees`). Never errors — a GC
/// failure must not block startup; every skip/failure is logged instead.
pub async fn sweep_orphaned_worktrees(
    workspaces: &WorkspaceRepo,
    repositories: &RepositoryRepo,
    base: &Path,
) -> GcOutcome {
    let mut outcome = GcOutcome::default();
    let entries = match std::fs::read_dir(base) {
        Ok(entries) => entries,
        // No worktree dir yet (fresh install) — nothing to sweep.
        Err(_) => return outcome,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue; // .DS_Store and friends — not ours to judge.
        }
        let workspace_id = entry.file_name().to_string_lossy().into_owned();

        match workspaces.get(&workspace_id).await {
            // Deleted row (the store filters `deleted_at IS NULL`) or a dir
            // that never was a workspace: unreferenced — reclaim.
            Err(StoreError::NotFound) => {
                remove_dir(&path, &workspace_id, "no live workspace row", &mut outcome);
            }
            Err(err) => {
                log::warn!("worktree GC: lookup for {workspace_id} failed ({err}); keeping");
                outcome.kept += 1;
            }
            Ok(ws) if ws.status == crate::domain::WorkspaceStatus::Archived => {
                if archived_worktree_reclaimable(repositories, &ws, &path).await {
                    // Prefer a proper `git worktree remove` (clears metadata);
                    // fall back to a plain dir removal when the repo is gone.
                    let removed_via_git = match repo_path_of(repositories, &ws.repository_id).await
                    {
                        Some(repo_path) => git::remove_worktree(&repo_path, &path).is_ok(),
                        None => false,
                    };
                    if removed_via_git {
                        log::info!("worktree GC: removed archived worktree {workspace_id}");
                        outcome.removed += 1;
                    } else {
                        remove_dir(&path, &workspace_id, "archived (repo gone)", &mut outcome);
                    }
                } else {
                    outcome.kept += 1;
                }
            }
            // Any active status — never touched.
            Ok(_) => outcome.kept += 1,
        }
    }
    outcome
}

async fn repo_path_of(repositories: &RepositoryRepo, repository_id: &str) -> Option<PathBuf> {
    repositories
        .get(repository_id)
        .await
        .ok()
        .and_then(|r| r.local_path.map(PathBuf::from))
}

/// The archived-row safety predicate: CLEAN worktree AND (branch fully merged
/// into the default branch OR archived long enough ago). Every "keep" names
/// its reason so a user's disk-usage question is answerable from the log.
async fn archived_worktree_reclaimable(
    repositories: &RepositoryRepo,
    ws: &crate::domain::Workspace,
    worktree: &Path,
) -> bool {
    match git::status(worktree) {
        Ok(changes) if changes.is_empty() => {}
        Ok(_) => {
            log::info!("worktree GC: keeping {} — uncommitted changes", ws.id);
            return false;
        }
        Err(err) => {
            log::info!("worktree GC: keeping {} — status failed ({err})", ws.id);
            return false;
        }
    }

    let merged = match (
        repo_path_of(repositories, &ws.repository_id).await,
        ws.branch.as_deref(),
    ) {
        (Some(repo_path), Some(branch)) => {
            let default_branch = repositories
                .get(&ws.repository_id)
                .await
                .map(|r| r.default_branch)
                .unwrap_or_else(|_| "main".into());
            git::branch_fully_merged(&repo_path, branch, &default_branch)
        }
        // No branch (never produced) counts as merged-equivalent: there is no
        // work a ref could be protecting.
        (_, None) => true,
        (None, _) => false,
    };
    if merged {
        return true;
    }

    let old_enough = ws
        .archived_at
        .map(|at| chrono::Utc::now() - at > chrono::Duration::days(GC_AGE_THRESHOLD_DAYS))
        .unwrap_or(false);
    if !old_enough {
        log::info!(
            "worktree GC: keeping {} — unmerged and archived less than {GC_AGE_THRESHOLD_DAYS} days ago",
            ws.id
        );
    }
    old_enough
}

fn remove_dir(path: &Path, workspace_id: &str, reason: &str, outcome: &mut GcOutcome) {
    match std::fs::remove_dir_all(path) {
        Ok(()) => {
            log::info!("worktree GC: removed {workspace_id} ({reason})");
            outcome.removed += 1;
        }
        Err(err) => {
            log::warn!("worktree GC: failed to remove {workspace_id}: {err}");
            outcome.kept += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, Workspace, WorkspaceKind, WorkspaceStatus};
    use crate::store::{init_pool, WorkspaceUpdate};
    use std::process::Command;

    fn run(dir: &Path, args: &[&str]) {
        assert!(
            Command::new("git").args(args).current_dir(dir).status().unwrap().success(),
            "git {args:?} failed"
        );
    }

    fn init_repo(path: &Path) {
        run(path, &["init", "-q", "-b", "main"]);
        run(path, &["config", "user.email", "t@example.com"]);
        run(path, &["config", "user.name", "tester"]);
        run(path, &["config", "commit.gpgsign", "false"]);
        std::fs::write(path.join("README.md"), "hi\n").unwrap();
        run(path, &["add", "-A"]);
        run(path, &["commit", "-qm", "init"]);
    }

    struct Fixture {
        workspaces: WorkspaceRepo,
        repositories: RepositoryRepo,
        repo: Repository,
        base: PathBuf,
        _tmp: tempfile::TempDir,
    }

    async fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("gc.sqlite")).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let repositories = RepositoryRepo::new(pool.clone());
        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let mut repo = Repository::new(
            "repo".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        repositories.insert(&repo).await.unwrap();
        let base = tmp.path().join("worktrees");
        std::fs::create_dir_all(&base).unwrap();
        Fixture { workspaces, repositories, repo, base, _tmp: tmp }
    }

    /// A subtask row + a REAL worktree under `base/<id>` on branch `phasr/<id>`.
    async fn seeded_worktree(f: &Fixture, status: WorkspaceStatus) -> Workspace {
        let mut ws = Workspace::new(f.repo.id.clone(), "t".into(), "cmd".into());
        ws.workspace_kind = WorkspaceKind::Subtask;
        let branch = format!("phasr/{}", ws.id);
        let worktree = f.base.join(&ws.id);
        let repo_path = Path::new(f.repo.local_path.as_deref().unwrap());
        run(
            repo_path,
            &["worktree", "add", "-q", "-b", &branch, worktree.to_str().unwrap(), "main"],
        );
        ws.branch = Some(branch);
        ws.worktree_path = Some(worktree.to_string_lossy().into_owned());
        f.workspaces.insert(&ws).await.unwrap();
        if status != WorkspaceStatus::Pending {
            f.workspaces
                .update(&ws.id, WorkspaceUpdate { status: Some(status), ..Default::default() })
                .await
                .unwrap();
        }
        f.workspaces.get(&ws.id).await.unwrap()
    }

    async fn archive(f: &Fixture, id: &str, days_ago: i64) {
        f.workspaces
            .update(
                id,
                WorkspaceUpdate {
                    status: Some(WorkspaceStatus::Archived),
                    archived_at: Some(Some(
                        chrono::Utc::now() - chrono::Duration::days(days_ago),
                    )),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn never_touches_active_rows() {
        let f = fixture().await;
        let ws = seeded_worktree(&f, WorkspaceStatus::Running).await;
        let out = sweep_orphaned_worktrees(&f.workspaces, &f.repositories, &f.base).await;
        assert_eq!(out, GcOutcome { removed: 0, kept: 1 });
        assert!(f.base.join(&ws.id).exists(), "an active worktree must survive");
    }

    #[tokio::test]
    async fn never_removes_a_dirty_archived_worktree() {
        let f = fixture().await;
        let ws = seeded_worktree(&f, WorkspaceStatus::Running).await;
        std::fs::write(f.base.join(&ws.id).join("wip.txt"), "uncommitted work").unwrap();
        archive(&f, &ws.id, 90).await; // even WAY past the age threshold
        let out = sweep_orphaned_worktrees(&f.workspaces, &f.repositories, &f.base).await;
        assert_eq!(out, GcOutcome { removed: 0, kept: 1 });
        assert!(
            f.base.join(&ws.id).join("wip.txt").exists(),
            "dirty trees hold real work — the GC must never take them"
        );
    }

    #[tokio::test]
    async fn keeps_unmerged_recently_archived_but_reclaims_old_ones() {
        let f = fixture().await;
        let repo_path = Path::new(f.repo.local_path.as_deref().unwrap());

        // UNMERGED work: commit on the worktree branch, never merged to main.
        let recent = seeded_worktree(&f, WorkspaceStatus::Running).await;
        let recent_tree = f.base.join(&recent.id);
        std::fs::write(recent_tree.join("work.txt"), "unmerged\n").unwrap();
        run(&recent_tree, &["add", "-A"]);
        run(&recent_tree, &["commit", "-qm", "unmerged work"]);
        archive(&f, &recent.id, 1).await;

        let old = seeded_worktree(&f, WorkspaceStatus::Running).await;
        let old_tree = f.base.join(&old.id);
        std::fs::write(old_tree.join("work.txt"), "unmerged\n").unwrap();
        run(&old_tree, &["add", "-A"]);
        run(&old_tree, &["commit", "-qm", "unmerged work"]);
        archive(&f, &old.id, GC_AGE_THRESHOLD_DAYS + 1).await;

        let out = sweep_orphaned_worktrees(&f.workspaces, &f.repositories, &f.base).await;
        assert_eq!(out, GcOutcome { removed: 1, kept: 1 });
        assert!(f.base.join(&recent.id).exists(), "recent unmerged work is kept");
        assert!(!f.base.join(&old.id).exists(), "past the age threshold it's reclaimed");
        // The branch REF survives the reclaim — refs, not worktrees, protect
        // work (rev-parse --verify fails the test if the ref were gone).
        run(
            repo_path,
            &["rev-parse", "--verify", "-q", &format!("refs/heads/phasr/{}", old.id)],
        );
    }

    #[tokio::test]
    async fn reclaims_merged_archived_immediately() {
        let f = fixture().await;
        let repo_path = Path::new(f.repo.local_path.as_deref().unwrap());
        let ws = seeded_worktree(&f, WorkspaceStatus::Running).await;
        let tree = f.base.join(&ws.id);
        std::fs::write(tree.join("done.txt"), "merged\n").unwrap();
        run(&tree, &["add", "-A"]);
        run(&tree, &["commit", "-qm", "work"]);
        run(repo_path, &["merge", "-q", "--no-ff", ws.branch.as_deref().unwrap()]);
        archive(&f, &ws.id, 0).await; // JUST archived — merged needs no age
        let out = sweep_orphaned_worktrees(&f.workspaces, &f.repositories, &f.base).await;
        assert_eq!(out, GcOutcome { removed: 1, kept: 0 });
        assert!(!tree.exists());
    }

    #[tokio::test]
    async fn reclaims_rowless_dirs_and_is_idempotent() {
        let f = fixture().await;
        let orphan = f.base.join("no-such-workspace");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join("junk.txt"), "leftover").unwrap();

        let out = sweep_orphaned_worktrees(&f.workspaces, &f.repositories, &f.base).await;
        assert_eq!(out, GcOutcome { removed: 1, kept: 0 });
        assert!(!orphan.exists());

        // Second run over the now-clean base: nothing to do, no errors.
        let out = sweep_orphaned_worktrees(&f.workspaces, &f.repositories, &f.base).await;
        assert_eq!(out, GcOutcome { removed: 0, kept: 0 });
    }
}
