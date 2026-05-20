//! Per-repository serializer for shared `.git` operations.
//!
//! N tasks can run concurrently in the same repository — each has its
//! own worktree and its own branch — but the *git index* is shared
//! across all worktrees. Two `git worktree add` or `git branch -D`
//! invocations racing on the same repo can corrupt `.git/index.lock`
//! and leave the repo in a partially-modified state.
//!
//! The plan calls for "a workspace-level Tokio Mutex when touching the
//! shared `.git`" (Worktree Strategy → Concurrency rules). This
//! registry hands out an `Arc<Mutex<()>>` keyed by repository id —
//! callers `lock()` it across the duration of their git operation.
//! It's async-aware (held across `.await`) and cheap to clone.
//!
//! Locks are kept alive for the lifetime of the process: a repo's
//! lock is created on first use and lives in the registry until the
//! app exits. Garbage-collecting them would require ref-counting on
//! the Arcs handed out, which isn't worth the complexity for a map
//! whose keys are user-controlled and bounded by reasonable usage.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex as SyncMutex;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct RepoLockRegistry {
    inner: SyncMutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl RepoLockRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get-or-create the lock for `repository_id`. The returned Arc is
    /// cheap to clone; pass it to a worker if you need to hold the
    /// guard across a spawned task.
    pub fn for_repository(&self, repository_id: &str) -> Arc<Mutex<()>> {
        let mut map = self.inner.lock();
        if let Some(existing) = map.get(repository_id) {
            return existing.clone();
        }
        let lock = Arc::new(Mutex::new(()));
        map.insert(repository_id.to_string(), lock.clone());
        lock
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_same_lock_for_same_repo() {
        let registry = RepoLockRegistry::new();
        let a = registry.for_repository("repo-1");
        let b = registry.for_repository("repo-1");
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn returns_distinct_locks_for_distinct_repos() {
        let registry = RepoLockRegistry::new();
        let a = registry.for_repository("repo-1");
        let b = registry.for_repository("repo-2");
        assert!(!Arc::ptr_eq(&a, &b));
    }

    #[tokio::test]
    async fn lock_is_held_across_await() {
        let registry = RepoLockRegistry::new();
        let lock = registry.for_repository("repo-x");
        let _g = lock.lock().await;
        // If we got the guard, the second try should fail with
        // try_lock — proving exclusivity at the runtime level.
        let same = registry.for_repository("repo-x");
        assert!(same.try_lock().is_err());
    }
}
