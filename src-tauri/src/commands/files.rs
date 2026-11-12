//! Files: the read-only preview (`read_text_file`, by absolute path) and the
//! Files tab editor (by workspace + worktree-relative path).
//!
//! Every path is confined: the preview to the user's registered repository
//! checkouts and worktrees, the editor to one workspace's worktree via
//! `git::resolve_in_worktree` (no absolute paths, `..`, `.git/`, or
//! symlinks out). Reads cap at 1 MB and reject non-UTF-8 so the frontend can
//! render a clean "not text" state instead of OOMing the webview.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::State;
use thiserror::Error;

use crate::agent_signals::{AgentFileEdit, AgentSignals};
use crate::auth::{AuthError, SessionState};
use crate::domain::{Agent, Workspace};
use crate::git::{
    self, DiffScope, FileContents, GitError, RevertHunkError, WorkspaceFileError, WorkspaceTree,
};
use crate::orchestrator::TaskBoard;
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo};

use super::require_user;

const MAX_PREVIEW_BYTES: u64 = 1_048_576; // 1 MB

#[derive(Debug, Error)]
pub enum FilePreviewError {
    #[error("file does not exist")]
    Missing,
    #[error("path is not a regular file")]
    NotAFile,
    #[error("file is too large to preview ({0} bytes; limit is 1 MB)")]
    TooLarge(u64),
    #[error("file is not text (invalid UTF-8)")]
    NotText,
    #[error("path is outside your repositories and worktrees")]
    OutsideRoots,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Auth(#[from] AuthError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl serde::Serialize for FilePreviewError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// The directories the absolute-path commands may touch for `user_id`:
/// their repositories' checkouts and their workspaces' worktrees. Anything
/// else (`~/.ssh`, another account's repo) is refused before any IO.
pub async fn registered_roots(
    repositories: &RepositoryRepo,
    workspaces: &WorkspaceRepo,
    user_id: &str,
) -> Result<Vec<PathBuf>, StoreError> {
    let mut roots: Vec<PathBuf> = repositories
        .list_for_user(user_id)
        .await?
        .into_iter()
        .filter_map(|r| r.local_path)
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .collect();
    roots.extend(
        workspaces
            .worktree_paths_for_user(user_id)
            .await?
            .into_iter()
            .filter(|p| !p.trim().is_empty())
            .map(PathBuf::from),
    );
    Ok(roots)
}

#[tauri::command]
pub async fn read_text_file(
    path: String,
    repositories: State<'_, RepositoryRepo>,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, FilePreviewError> {
    let current = require_user(&session)?;
    let roots = registered_roots(&repositories, &workspaces, &current.user_id).await?;
    let path_buf = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || read_preview(&path_buf, &roots))
        .await
        .map_err(|e| FilePreviewError::Io(std::io::Error::other(e.to_string())))?
}

/// Resolve `path` once, check THAT path against `roots`, then open it once
/// and judge (type, size) and read the same open file.
///
/// The old code checked the canonical path but stat-ed and read the path
/// as given, three separate lookups: a symlink swapped in between could
/// get around both the roots check and the size cap. Now the only path
/// ever opened is the canonical, checked one — with `O_NOFOLLOW` so a
/// final component replaced by a symlink since is refused — and the size
/// comes from the open descriptor, with the read itself capped.
fn read_preview(path: &Path, roots: &[PathBuf]) -> Result<String, FilePreviewError> {
    use std::io::Read;

    if !git::is_within_roots(path, roots) {
        return Err(FilePreviewError::OutsideRoots);
    }
    let canonical = match std::fs::canonicalize(path) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(FilePreviewError::Missing)
        }
        Err(e) => return Err(e.into()),
    };
    if !git::is_within_roots(&canonical, roots) {
        return Err(FilePreviewError::OutsideRoots);
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // NONBLOCK: opening a FIFO must not wait for a writer (it's then
        // refused as not a file below).
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(&canonical) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(FilePreviewError::Missing)
        }
        Err(e) => return Err(e.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(FilePreviewError::NotAFile);
    }
    if metadata.len() > MAX_PREVIEW_BYTES {
        return Err(FilePreviewError::TooLarge(metadata.len()));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    // The file may grow after the fstat: never read past the cap.
    file.take(MAX_PREVIEW_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_PREVIEW_BYTES {
        return Err(FilePreviewError::TooLarge(bytes.len() as u64));
    }
    String::from_utf8(bytes).map_err(|_| FilePreviewError::NotText)
}

// ── Files tab (M9) ──────────────────────────────────────────────────────

#[derive(Debug)]
pub enum FilesCmdError {
    Store(StoreError),
    Auth(AuthError),
    File(WorkspaceFileError),
    Hunk(RevertHunkError),
    Git(GitError),
    NoWorktree,
}

impl From<StoreError> for FilesCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for FilesCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<WorkspaceFileError> for FilesCmdError {
    fn from(e: WorkspaceFileError) -> Self {
        Self::File(e)
    }
}

impl From<RevertHunkError> for FilesCmdError {
    fn from(e: RevertHunkError) -> Self {
        Self::Hunk(e)
    }
}

impl From<GitError> for FilesCmdError {
    fn from(e: GitError) -> Self {
        Self::Git(e)
    }
}

impl std::fmt::Display for FilesCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::File(e) => write!(f, "{e}"),
            Self::Hunk(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::NoWorktree => write!(f, "workspace has no worktree on this machine"),
        }
    }
}

impl serde::Serialize for FilesCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// Who last touched a file, from the agent's transcript (M6 file edits).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LastAgentEdit {
    pub agent: Agent,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub contents: String,
    /// sha256 hex; pass back as `expectedHash` when saving.
    pub hash: String,
    pub size_bytes: u64,
    pub last_agent_edit: Option<LastAgentEdit>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteWorkspaceFileResult {
    pub hash: String,
}

async fn owned_worktree(
    workspaces: &WorkspaceRepo,
    workspace_id: &str,
    user_id: &str,
) -> Result<(Workspace, PathBuf), FilesCmdError> {
    let workspace = workspaces.get_for_user(workspace_id, user_id).await?;
    let root = workspace
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .ok_or(FilesCmdError::NoWorktree)?;
    Ok((workspace, root))
}

async fn blocking<T, E, F>(f: F) -> Result<T, FilesCmdError>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: Into<FilesCmdError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| FilesCmdError::Git(GitError::CommandFailed(format!("file task failed: {e}"))))?
        .map_err(Into::into)
}

/// The worktree's files (tracked + untracked, `.gitignore` honoured, capped
/// at 50k) with one git badge each.
#[tauri::command]
pub async fn list_workspace_tree(
    workspace_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<WorkspaceTree, FilesCmdError> {
    let current = require_user(&session)?;
    let (_, root) = owned_worktree(&workspaces, &workspace_id, &current.user_id).await?;
    blocking(move || git::list_workspace_tree(&root)).await
}

#[tauri::command]
pub async fn read_workspace_file(
    workspace_id: String,
    path: String,
    workspaces: State<'_, WorkspaceRepo>,
    signals: State<'_, AgentSignals>,
    session: State<'_, Arc<SessionState>>,
) -> Result<WorkspaceFile, FilesCmdError> {
    let current = require_user(&session)?;
    let (workspace, root) = owned_worktree(&workspaces, &workspace_id, &current.user_id).await?;
    let file: FileContents = {
        let (root, path) = (root.clone(), path.clone());
        blocking(move || git::read_workspace_file(&root, &path)).await?
    };
    let last_agent_edit = match workspace.agent {
        Some(agent) => {
            let edits = signals.file_edits_for(&workspace).await;
            last_edit_of(&edits, &root, &file.path).map(|at| LastAgentEdit { agent, at })
        }
        None => None,
    };
    Ok(WorkspaceFile {
        path: file.path,
        contents: file.contents,
        hash: file.hash,
        size_bytes: file.size_bytes,
        last_agent_edit,
    })
}

/// When the agent last edited `rel`. Edits are recorded worktree-relative
/// when inside the worktree, absolute otherwise (and an absolute one can
/// still name a worktree file, e.g. via `/private/var` vs `/var`).
fn last_edit_of(edits: &[AgentFileEdit], root: &Path, rel: &str) -> Option<DateTime<Utc>> {
    let rel = rel.trim_start_matches("./");
    let absolute = root.join(rel);
    let canonical_root = std::fs::canonicalize(root).ok();
    edits
        .iter()
        .filter(|e| {
            let p = Path::new(&e.path);
            if p.is_absolute() {
                p == absolute
                    || canonical_root
                        .as_ref()
                        .and_then(|r| std::fs::canonicalize(p).ok().map(|c| c == r.join(rel)))
                        .unwrap_or(false)
            } else {
                e.path.trim_start_matches("./") == rel
            }
        })
        .map(|e| e.at)
        .max()
}

/// Atomic save. `expectedHash` = the hash `read_workspace_file` returned;
/// if the file changed since, rejects with `"file changed on disk"` and
/// writes nothing. `null` writes unconditionally (a new file, or
/// "overwrite anyway").
#[tauri::command]
pub async fn write_workspace_file(
    workspace_id: String,
    path: String,
    contents: String,
    expected_hash: Option<String>,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, TaskBoard>,
    session: State<'_, Arc<SessionState>>,
) -> Result<WriteWorkspaceFileResult, FilesCmdError> {
    let current = require_user(&session)?;
    let (workspace, root) = owned_worktree(&workspaces, &workspace_id, &current.user_id).await?;
    let hash = blocking(move || {
        git::write_workspace_file(&root, &path, &contents, expected_hash.as_deref())
    })
    .await?;
    // The card's +/− counts are cached per HEAD; an edit doesn't move HEAD.
    board.invalidate_diff(&workspace.id);
    board.notify_changed(&workspace.repository_id);
    Ok(WriteWorkspaceFileResult { hash })
}

/// Undo one hunk in the working tree. The diff is recomputed here and the
/// hunk picked by its exact header AND checked against `hunkBody` — the
/// hunk's lines as the user saw them (with or without the `@@` line). A
/// header that no longer exists, or a hunk whose lines changed since,
/// rejects with `"hunk no longer matches"` and touches nothing. `scope`:
/// `"Head"` (uncommitted) or `"Base"` (vs the task's base, committed work
/// too).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn revert_hunk(
    workspace_id: String,
    path: String,
    hunk_header: String,
    hunk_body: String,
    scope: DiffScope,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    board: State<'_, TaskBoard>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), FilesCmdError> {
    let current = require_user(&session)?;
    let (workspace, root) = owned_worktree(&workspaces, &workspace_id, &current.user_id).await?;
    // Same path rules as the editor: the hunk's file must be inside the
    // worktree (git would refuse `..` anyway; `.git/` it would not).
    {
        let (root, path) = (root.clone(), path.clone());
        blocking(move || git::resolve_in_worktree(&root, &path).map_err(WorkspaceFileError::from))
            .await?;
    }
    let base = match scope {
        DiffScope::Base => Some(match workspace.base_branch.clone() {
            Some(base) => base,
            None => {
                let repository = repositories
                    .get_for_user(&workspace.repository_id, &current.user_id)
                    .await?;
                git::resolve_base_branch(
                    repository.local_path.as_deref(),
                    &repository.default_branch,
                )
            }
        }),
        _ => None,
    };
    blocking(move || {
        git::revert_hunk(
            &root,
            &path,
            &hunk_header,
            &hunk_body,
            scope,
            base.as_deref(),
        )
    })
    .await?;
    board.invalidate_diff(&workspace.id);
    board.notify_changed(&workspace.repository_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The preview reads exactly the canonical path it checked, with one
    /// open: a symlink pointing out of the roots (or at a FIFO / device) is
    /// refused rather than followed.
    #[cfg(unix)]
    #[test]
    fn read_preview_only_reads_the_checked_path() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let roots = vec![root.path().to_path_buf()];
        std::fs::write(root.path().join("ok.txt"), "hello").unwrap();
        std::fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("link.txt"),
        )
        .unwrap();
        std::os::unix::fs::symlink("/dev/zero", root.path().join("zero")).unwrap();
        let fifo = root.path().join("pipe");
        let c = std::ffi::CString::new(fifo.to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o644) }, 0);
        std::fs::write(
            root.path().join("big.txt"),
            vec![b'a'; (MAX_PREVIEW_BYTES + 1) as usize],
        )
        .unwrap();

        assert_eq!(
            read_preview(&root.path().join("ok.txt"), &roots).unwrap(),
            "hello"
        );
        assert!(matches!(
            read_preview(&root.path().join("link.txt"), &roots),
            Err(FilePreviewError::OutsideRoots)
        ));
        assert!(matches!(
            read_preview(&outside.path().join("secret.txt"), &roots),
            Err(FilePreviewError::OutsideRoots)
        ));
        assert!(read_preview(&root.path().join("zero"), &roots).is_err());
        assert!(
            matches!(read_preview(&fifo, &roots), Err(FilePreviewError::NotAFile)),
            "no hang on a FIFO"
        );
        assert!(matches!(
            read_preview(&root.path().join("big.txt"), &roots),
            Err(FilePreviewError::TooLarge(_))
        ));
        assert!(matches!(
            read_preview(&root.path().join("nope.txt"), &roots),
            Err(FilePreviewError::Missing)
        ));
    }

    #[test]
    fn last_edit_matches_relative_and_absolute_paths_and_takes_the_newest() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.rs"), "a").unwrap();
        let t = |s: i64| DateTime::<Utc>::from_timestamp(s, 0).unwrap();
        let edits = vec![
            AgentFileEdit {
                path: "src/a.rs".into(),
                at: t(10),
                tool: "Edit".into(),
            },
            AgentFileEdit {
                path: dir.path().join("src/a.rs").to_string_lossy().into_owned(),
                at: t(20),
                tool: "Write".into(),
            },
            AgentFileEdit {
                path: "src/b.rs".into(),
                at: t(30),
                tool: "Edit".into(),
            },
            AgentFileEdit {
                path: "/elsewhere/src/a.rs".into(),
                at: t(40),
                tool: "Edit".into(),
            },
        ];
        assert_eq!(last_edit_of(&edits, dir.path(), "src/a.rs"), Some(t(20)));
        assert_eq!(last_edit_of(&edits, dir.path(), "./src/a.rs"), Some(t(20)));
        assert_eq!(last_edit_of(&edits, dir.path(), "src/c.rs"), None);
    }

    #[test]
    fn errors_serialize_as_plain_strings() {
        let err = FilesCmdError::from(WorkspaceFileError::Conflict);
        assert_eq!(serde_json::to_value(&err).unwrap(), "file changed on disk");
        let err = FilesCmdError::from(RevertHunkError::NoLongerMatches);
        assert_eq!(
            serde_json::to_value(&err).unwrap(),
            "hunk no longer matches"
        );
        let err = FilesCmdError::from(StoreError::NotFound);
        assert_eq!(serde_json::to_value(&err).unwrap(), "not found");
        assert_eq!(
            serde_json::to_value(FilePreviewError::OutsideRoots).unwrap(),
            "path is outside your repositories and worktrees"
        );
    }

    #[tokio::test]
    async fn registered_roots_are_the_users_checkouts_and_worktrees_only() {
        use crate::domain::Repository;
        let dir = tempfile::tempdir().unwrap();
        let pool = crate::store::init_pool(&dir.path().join("t.sqlite"))
            .await
            .unwrap();
        for id in ["user-a", "user-b"] {
            sqlx::query(
                "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
                 VALUES (?, ?, 'n', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
            )
            .bind(id)
            .bind(id)
            .bind(format!("{id}@example.com"))
            .execute(&pool)
            .await
            .unwrap();
        }
        let repositories = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let repo = Repository::new("r".into(), Some("/code/a".into()), None);
        repositories.insert_for_user(&repo, "user-a").await.unwrap();
        let mut ws = Workspace::new(repo.id.clone(), "t".into(), "c".into());
        ws.worktree_path = Some("/wt/a-task".into());
        workspaces.insert_for_user(&ws, "user-a").await.unwrap();

        let a = registered_roots(&repositories, &workspaces, "user-a")
            .await
            .unwrap();
        assert!(a.contains(&PathBuf::from("/code/a")));
        assert!(a.contains(&PathBuf::from("/wt/a-task")));
        assert!(registered_roots(&repositories, &workspaces, "user-b")
            .await
            .unwrap()
            .is_empty());
    }
}
