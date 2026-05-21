//! Git operations. All commands shell out to the user's installed
//! `git` binary — same flags, same hooks, same auth as their CLI.

mod branch;
mod clone;
mod commit;
mod diff;
mod error;
mod files;
mod init;
mod merge;
mod pr;
mod remote;
mod status;
mod template;
mod worktree;

pub use branch::{branch_status, BranchStatus};
pub use clone::clone_repo;
pub use commit::{commit, discard, push, stage, unstage, CommitOutput};
pub use diff::{diff, DiffScope};
pub use error::GitError;
pub use files::list_files;
pub use init::init_repo;
pub use merge::{
    abort as merge_abort, continue_after_resolution as merge_continue,
    has_unpushed_commits, in_progress as merge_in_progress, merge_into, merge_to,
    set_resolution as merge_set_resolution, ConflictSide, InProgress, MergeOutcome,
    MergeStrategy,
};
pub use pr::build_pull_request_target;
pub use remote::{get_default_branch, get_remote_url, list_local_branches};
pub use status::{status, FileChange};
pub use template::init_from_template;
pub use worktree::{branch_delete, create_worktree, remove_worktree};
