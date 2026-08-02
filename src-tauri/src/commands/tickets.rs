//! Rich-ticket brief command surface (Phase 2, stories T4/T5-BE/T7).
//!
//! Thin `#[tauri::command]` handlers over the `crate::tickets` file-service:
//!   - `read_ticket_brief` / `write_ticket_section` (T4) — the whole brief, and
//!     one section written with conflict detection.
//!   - `list_ticket_assets` / `add_ticket_asset` / `remove_ticket_asset` (T5-BE)
//!     — the storage-split attachments (small → in-repo, large → app-data).
//!   - `add_ticket_figma_link` / `remove_ticket_figma_link` (T5-BE) — link-only
//!     Figma refs persisted in `figma.json`.
//!   - `list_ticket_comments` / `add_ticket_comment` (T5-BE) — the append-only
//!     `comments.jsonl` thread (Phase 2 only ever appends "you", honesty #1).
//!   - `watch_ticket` / `unwatch_ticket` (T7) — the co-editing fs-watcher that
//!     emits `phasr://ticket-changed` on an EXTERNAL section edit (own writes are
//!     hash-suppressed, architect #2).
//!
//! Every handler is owner-scoped through the SYNCABLE repositories table
//! (`get_for_user`): the brief files live inside `repository.local_path`, so
//! owning the repo is the access boundary — a different account can never read
//! or write another user's ticket data. Ticket data is on-disk (not a DB table),
//! so there is NO `request_sync()` and NO migration (architect #7).

use std::path::Path;
use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::fswatch::TicketWatchRegistry;
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo};
use crate::tickets::{
    add_asset, add_comment, add_figma_link, default_ticket_assets_root, list_assets, list_comments,
    read_brief, remove_asset, remove_figma_link, ticket_dir, write_section, BriefSection, FigmaLink,
    LastEditedBy, TicketAsset, TicketBrief, TicketComment, TicketError, TicketWriteRegistry,
    WriteSectionResult,
};

// ── error ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum TicketCmdError {
    Store(StoreError),
    Auth(AuthError),
    Ticket(TicketError),
}

impl From<StoreError> for TicketCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for TicketCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<TicketError> for TicketCmdError {
    fn from(e: TicketError) -> Self {
        Self::Ticket(e)
    }
}

impl std::fmt::Display for TicketCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::Ticket(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for TicketCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Read the full brief for one ticket. Owner-scoped via the repository. Missing
/// files → empty sections; a not-yet-scaffolded ticket → an empty brief keyed by
/// the id (never an error, so the Brief tab always has something to render).
#[tauri::command]
pub async fn read_ticket_brief(
    repository_id: String,
    ticket_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<TicketBrief, TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    read_ticket_brief_inner(
        &repository_id,
        &ticket_id,
        &current.user_id,
        &workspaces,
        &repositories,
        &default_ticket_assets_root(),
    )
    .await
}

/// Write one section, with optimistic-concurrency conflict detection. Owner-
/// scoped via the repository. Returns `{ kind: "saved", section }` on a clean
/// write, or `{ kind: "conflict", onDisk }` when the on-disk bytes diverged from
/// the caller's stale `baseMtimeMs` (Reload / Keep-mine on the FE).
#[tauri::command]
pub async fn write_ticket_section(
    repository_id: String,
    ticket_id: String,
    section: BriefSection,
    content: String,
    base_mtime_ms: Option<i64>,
    repositories: State<'_, RepositoryRepo>,
    registry: State<'_, Arc<TicketWriteRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<WriteSectionResult, TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    write_ticket_section_inner(
        &registry,
        &repository_id,
        &ticket_id,
        &current.user_id,
        section,
        &content,
        base_mtime_ms,
        &repositories,
    )
    .await
    // No `request_sync()`: ticket briefs live on-disk, not in a syncable table.
}

// ── E5: the epic-brief edit surface (Phase 8, completion program) ────────────

/// Read the workflow-level brief (PRD/TRD + assets/figma). Owner-scoped via
/// the repository; a repo with no local checkout → an empty brief (never an
/// error). Until now these docs were WRITE-ONCE at decompose time — the Rust
/// halves existed with a single gate caller and no read/edit surface.
#[tauri::command]
pub async fn read_epic_brief(
    repository_id: String,
    parent_id: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<crate::tickets::EpicBrief, TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let repo_root = owned_repo_root(&repositories, &repository_id, &current.user_id).await?;
    Ok(crate::tickets::read_epic_brief(
        repo_root.as_deref(),
        &parent_id,
        &default_ticket_assets_root(),
    )?)
}

/// Write one workflow-brief section with the SAME optimistic-concurrency
/// contract as `write_ticket_section` (`saved` | `conflict{onDisk}` — nothing
/// is ever clobbered on a stale base).
#[tauri::command]
pub async fn write_epic_section(
    repository_id: String,
    parent_id: String,
    section: BriefSection,
    content: String,
    base_mtime_ms: Option<i64>,
    repositories: State<'_, RepositoryRepo>,
    registry: State<'_, Arc<TicketWriteRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<WriteSectionResult, TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let Some(repo_root) =
        owned_repo_root(&repositories, &repository_id, &current.user_id).await?
    else {
        return Err(TicketCmdError::Ticket(
            crate::tickets::TicketError::RepositoryHasNoLocalPath,
        ));
    };
    // Ensure the dir exists for an epic created before scaffolding (or whose
    // docs were never attached) — an edit must not fail on a missing folder.
    let _ = crate::tickets::ensure_epic_dir(&repo_root, &parent_id);
    Ok(crate::tickets::write_epic_section(
        &registry,
        &repo_root,
        &parent_id,
        section,
        &content,
        base_mtime_ms,
    )?)
}

// ── T5-BE: assets ────────────────────────────────────────────────────────────

/// List every asset for a ticket (in-repo + app-data), owner-scoped. A repo with
/// no checkout on this machine → an empty list (never an error).
#[tauri::command]
pub async fn list_ticket_assets(
    repository_id: String,
    ticket_id: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<TicketAsset>, TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let Some(repo_root) =
        owned_repo_root(&repositories, &repository_id, &current.user_id).await?
    else {
        return Ok(Vec::new());
    };
    Ok(list_assets(&repo_root, &ticket_id, &default_ticket_assets_root())?)
}

/// Copy a picked/dropped file into the ticket, routing small → in-repo and large
/// → app-data (§B). Owner-scoped; a repo with no checkout has nowhere to store
/// the in-repo copy, so it surfaces `RepositoryHasNoLocalPath`.
#[tauri::command]
pub async fn add_ticket_asset(
    repository_id: String,
    ticket_id: String,
    source_path: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<TicketAsset, TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let repo_root = owned_repo_root(&repositories, &repository_id, &current.user_id)
        .await?
        .ok_or(TicketError::RepositoryHasNoLocalPath)?;
    Ok(add_asset(
        &repo_root,
        &ticket_id,
        Path::new(&source_path),
        &default_ticket_assets_root(),
    )?)
}

/// Remove one asset by id from whichever store holds it. Owner-scoped; idempotent
/// (a gone asset / no checkout is a no-op, never an error).
#[tauri::command]
pub async fn remove_ticket_asset(
    repository_id: String,
    ticket_id: String,
    asset_id: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let Some(repo_root) =
        owned_repo_root(&repositories, &repository_id, &current.user_id).await?
    else {
        return Ok(());
    };
    remove_asset(&repo_root, &ticket_id, &asset_id, &default_ticket_assets_root())?;
    Ok(())
}

// ── T5-BE: figma links ───────────────────────────────────────────────────────

/// Append a Figma link (link-only v1) to `figma.json`. Author is always "you"
/// (honesty #1). A malformed URL is rejected. Owner-scoped.
#[tauri::command]
pub async fn add_ticket_figma_link(
    repository_id: String,
    ticket_id: String,
    url: String,
    label: Option<String>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<FigmaLink, TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let repo_root = owned_repo_root(&repositories, &repository_id, &current.user_id)
        .await?
        .ok_or(TicketError::RepositoryHasNoLocalPath)?;
    Ok(add_figma_link(&repo_root, &ticket_id, &url, label.as_deref())?)
}

/// Remove a Figma link by id. Owner-scoped; idempotent.
#[tauri::command]
pub async fn remove_ticket_figma_link(
    repository_id: String,
    ticket_id: String,
    link_id: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let Some(repo_root) =
        owned_repo_root(&repositories, &repository_id, &current.user_id).await?
    else {
        return Ok(());
    };
    remove_figma_link(&repo_root, &ticket_id, &link_id)?;
    Ok(())
}

// ── T5-BE: comments ──────────────────────────────────────────────────────────

/// List a ticket's comment thread from `comments.jsonl`, owner-scoped. No
/// checkout → an empty thread.
#[tauri::command]
pub async fn list_ticket_comments(
    repository_id: String,
    ticket_id: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<TicketComment>, TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let Some(repo_root) =
        owned_repo_root(&repositories, &repository_id, &current.user_id).await?
    else {
        return Ok(Vec::new());
    };
    Ok(list_comments(&repo_root, &ticket_id)?)
}

/// Append the signed-in user's comment (`authorKind: "you"`, honesty #1) to
/// `comments.jsonl`. The author display name is the session's name. Owner-scoped.
#[tauri::command]
pub async fn add_ticket_comment(
    repository_id: String,
    ticket_id: String,
    body: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<TicketComment, TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let repo_root = owned_repo_root(&repositories, &repository_id, &current.user_id)
        .await?
        .ok_or(TicketError::RepositoryHasNoLocalPath)?;
    // A UI comment is the signed-in human — stamped `"you"` (honesty #29).
    Ok(add_comment(&repo_root, &ticket_id, &current.name, LastEditedBy::You, &body)?)
}

// ── T7: co-editing fs-watcher ────────────────────────────────────────────────

/// Start watching a ticket's dir for EXTERNAL section edits (T7). Owner-scoped;
/// a repo with no checkout has nothing on disk to watch (no-op). Pairs with
/// `unwatch_ticket` on unmount so only the open ticket is watched at a time
/// (mirror `watch_workspace`).
#[tauri::command]
pub async fn watch_ticket(
    repository_id: String,
    ticket_id: String,
    repositories: State<'_, RepositoryRepo>,
    watchers: State<'_, Arc<TicketWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), TicketCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let Some(repo_root) =
        owned_repo_root(&repositories, &repository_id, &current.user_id).await?
    else {
        return Ok(());
    };
    // Traversal-safe dir resolution (rejects a crafted ticket id before watching).
    let dir = ticket_dir(&repo_root, &ticket_id)?;
    watchers.start(ticket_id, dir);
    Ok(())
}

/// Stop watching a ticket (mirror `unwatch_workspace`). Sync — no fs/DB work.
#[tauri::command]
pub fn unwatch_ticket(
    repository_id: String,
    ticket_id: String,
    watchers: State<'_, Arc<TicketWatchRegistry>>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), TicketCmdError> {
    session.require()?;
    // `repositoryId` rides the frozen §C.1 signature; the watcher is keyed by the
    // globally-unique ticket id, so teardown needs only that.
    let _ = &repository_id;
    watchers.stop(&ticket_id);
    Ok(())
}

// ── internals (testable without Tauri `State`) ───────────────────────────────

/// Owner-scoped resolution of a repo's local checkout path. `get_for_user` is
/// the access boundary (`NotFound` for a non-owner). Returns `None` when the repo
/// exists but has no checkout on this machine — reads degrade to empty, writes
/// surface `RepositoryHasNoLocalPath`.
async fn owned_repo_root(
    repositories: &RepositoryRepo,
    repository_id: &str,
    user_id: &str,
) -> Result<Option<std::path::PathBuf>, TicketCmdError> {
    let repository = repositories.get_for_user(repository_id, user_id).await?;
    Ok(repository.local_path.map(std::path::PathBuf::from))
}

/// `read_ticket_brief` minus session/State wiring. Owner-scopes on the
/// repository (`get_for_user`), then reads the on-disk brief; the workspace-name
/// title fallback (§C) is best-effort (a ticket with no DB row still reads).
async fn read_ticket_brief_inner(
    repository_id: &str,
    ticket_id: &str,
    user_id: &str,
    workspaces: &WorkspaceRepo,
    repositories: &RepositoryRepo,
    assets_app_data_root: &Path,
) -> Result<TicketBrief, TicketCmdError> {
    let repository = repositories.get_for_user(repository_id, user_id).await?;
    let title_fallback = workspaces
        .get_for_user(ticket_id, user_id)
        .await
        .ok()
        .map(|w| w.name);
    Ok(read_brief(
        repository.local_path.as_deref().map(Path::new),
        ticket_id,
        title_fallback.as_deref(),
        assets_app_data_root,
    )?)
}

/// `write_ticket_section` minus session/State wiring. Owner-scopes on the
/// repository, then delegates to the conflict-aware file-service. A repo with no
/// checkout has nowhere to store the single physical copy (architect #2).
#[allow(clippy::too_many_arguments)]
async fn write_ticket_section_inner(
    registry: &TicketWriteRegistry,
    repository_id: &str,
    ticket_id: &str,
    user_id: &str,
    section: BriefSection,
    content: &str,
    base_mtime_ms: Option<i64>,
    repositories: &RepositoryRepo,
) -> Result<WriteSectionResult, TicketCmdError> {
    let repository = repositories.get_for_user(repository_id, user_id).await?;
    let repo_root = repository
        .local_path
        .as_deref()
        .ok_or(TicketError::RepositoryHasNoLocalPath)?;
    Ok(write_section(
        registry,
        Path::new(repo_root),
        ticket_id,
        section,
        content,
        base_mtime_ms,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Repository;
    use crate::store::{init_pool, Db};

    async fn seed_user(pool: &Db, uid: &str) {
        sqlx::query(
            "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
             VALUES (?, ?, 'n', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
        )
        .bind(uid)
        .bind(uid)
        .bind(format!("{uid}@example.com"))
        .execute(pool)
        .await
        .unwrap();
    }

    /// A repo owned by `user-a` with a real on-disk checkout dir (tickets need a
    /// directory, not a git repo). Keeps the TempDir alive for the test.
    async fn setup() -> (RepositoryRepo, WorkspaceRepo, Repository, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("test.sqlite")).await.unwrap();
        let repos = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        seed_user(&pool, "user-a").await;
        seed_user(&pool, "user-b").await;

        let checkout = dir.path().join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        let repo = Repository::new(
            "repo".into(),
            Some(checkout.to_string_lossy().into_owned()),
            None,
        );
        repos.insert_for_user(&repo, "user-a").await.unwrap();
        (repos, workspaces, repo, dir)
    }

    // T4: a read/write round-trip through the command inners against a scaffolded
    // ticket — write a section, read it back.
    #[tokio::test]
    async fn read_write_round_trip() {
        let (repos, workspaces, repo, _dir) = setup().await;
        let checkout = Path::new(repo.local_path.as_deref().unwrap());
        crate::tickets::scaffold_ticket(checkout, "ticket-1", "My Ticket", "desc body").unwrap();
        let registry = TicketWriteRegistry::default();

        let saved = write_ticket_section_inner(
            &registry,
            &repo.id,
            "ticket-1",
            "user-a",
            BriefSection::Prd,
            "the requirements",
            None,
            &repos,
        )
        .await
        .unwrap();
        assert!(matches!(saved, WriteSectionResult::Saved { .. }));

        let brief = read_ticket_brief_inner(&repo.id, "ticket-1", "user-a", &workspaces, &repos, &_dir.path().join("app-data"))
            .await
            .unwrap();
        assert_eq!(brief.title, "My Ticket");
        assert_eq!(brief.description.content, "desc body");
        assert_eq!(brief.prd.content, "the requirements");
        assert_eq!(brief.prd.last_edited_by, Some(crate::tickets::LastEditedBy::You));
    }

    // T4 / owner-scoping: a different signed-in account can neither read nor
    // write another user's ticket brief — the repo `get_for_user` gate returns
    // NotFound, so the read/write never touches the fs.
    #[tokio::test]
    async fn ticket_access_is_scoped_to_the_repo_owner() {
        let (repos, workspaces, repo, _dir) = setup().await;
        let checkout = Path::new(repo.local_path.as_deref().unwrap());
        crate::tickets::scaffold_ticket(checkout, "ticket-1", "T", "d").unwrap();
        let registry = TicketWriteRegistry::default();

        // Owner: OK.
        assert!(
            read_ticket_brief_inner(&repo.id, "ticket-1", "user-a", &workspaces, &repos, &_dir.path().join("app-data"))
                .await
                .is_ok()
        );

        // Non-owner: NotFound on the repo gate for both read and write.
        assert!(matches!(
            read_ticket_brief_inner(&repo.id, "ticket-1", "user-b", &workspaces, &repos, &_dir.path().join("app-data")).await,
            Err(TicketCmdError::Store(StoreError::NotFound))
        ));
        assert!(matches!(
            write_ticket_section_inner(
                &registry,
                &repo.id,
                "ticket-1",
                "user-b",
                BriefSection::Prd,
                "sneaky",
                None,
                &repos,
            )
            .await,
            Err(TicketCmdError::Store(StoreError::NotFound))
        ));
    }

    // T4: an unknown ticket id under an OWNED repo is a graceful empty brief, not
    // an error (a not-yet-scaffolded ticket still renders).
    #[tokio::test]
    async fn unknown_ticket_under_owned_repo_is_an_empty_brief() {
        let (repos, workspaces, repo, _dir) = setup().await;
        let brief = read_ticket_brief_inner(&repo.id, "never-scaffolded", "user-a", &workspaces, &repos, &_dir.path().join("app-data"))
            .await
            .unwrap();
        assert_eq!(brief.ticket_id, "never-scaffolded");
        assert_eq!(brief.prd.content, "");
        assert_eq!(brief.comment_count, 0);
    }
}
