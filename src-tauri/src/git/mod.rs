//! Git operations. All commands shell out to the user's installed
//! `git` binary — same flags, same hooks, same auth as their CLI.
//!
//! - `worktree`: create / remove per-task worktrees
//! - `status`:   parse `git status --porcelain` into typed records
//! - `diff`:     compute textual diffs (staged / unstaged / HEAD)
//! - `commit`:   stage / unstage / discard / commit / push

mod commit;
mod diff;
mod error;
mod status;
mod worktree;

pub use commit::{commit, discard, push, stage, unstage, CommitOutput};
pub use diff::{diff, DiffScope};
pub use error::GitError;
pub use status::{status, FileChange, FileStatus};
pub use worktree::{create_worktree, list_worktrees, prune_worktrees, remove_worktree, WorktreeRef};
