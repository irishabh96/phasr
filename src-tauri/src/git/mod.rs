//! Git operations. All commands shell out to the user's installed
//! `git` binary — same flags, same hooks, same auth as their CLI.

mod branch;
mod clone;
mod commit;
mod diff;
mod error;
mod files;
pub mod fs_guard;
mod hunks;
mod ignore;
mod init;
mod log;
mod merge;
mod naming;
mod pr;
mod remote;
mod review;
mod status;
mod template;
mod worktree;
mod workspace_files;

pub use branch::{branch_status, BranchStatus};
pub use clone::clone_repo;
pub use commit::{commit, discard, push, stage, unstage, CommitOutput};
pub use diff::{diff, diff_for_commit, diff_stats_vs_base, DiffScope, DiffStatCache};
pub use error::{ensure_branch_name, GitError};
pub use files::list_files;
pub use fs_guard::{is_within_roots, resolve_in_worktree};
pub use hunks::{revert_hunk, RevertHunkError};
pub use ignore::check_ignored;
pub use init::init_repo;
pub use log::{commit_files, log as git_log_query, Commit, CommitFileChange, LogOptions};
pub use merge::{
    has_unsaved_commits,
    abort as merge_abort, continue_after_resolution as merge_continue, current_branch,
    has_unpushed_commits, in_progress as merge_in_progress, merge_head_branches, merge_into,
    merge_to, set_resolution as merge_set_resolution, ConflictSide, InProgress, MergeOutcome,
    MergeStrategy,
};
pub use naming::{
    default_worktree_base_path, render_branch_name, resolve_worktree_base, short_id, slugify,
    unique_branch_name,
};
pub use pr::{build_pull_request_target, parse_remote_url, resolve_base_branch};
pub use remote::{get_default_branch, get_remote_url, list_local_branches, ref_exists};
pub use review::{diff_vs_base, fingerprint_key, review_files, worktree_fingerprint};
pub use status::{is_dirty, status, FileChange};
pub use template::init_from_template;
pub use workspace_files::{
    list_tree as list_workspace_tree, read_file as read_workspace_file,
    write_file as write_workspace_file, FileContents, WorkspaceFileError, WorkspaceTree,
};
pub use worktree::{
    branch_delete, create_worktree, list_worktrees, prune_worktrees, remove_worktree, WorktreeRef,
};
