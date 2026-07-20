//! Rich-ticket brief command surface (Phase 2, story T4).
//!
//! Two thin `#[tauri::command]` handlers over the `crate::tickets` file-service:
//!   - `read_ticket_brief` — the whole brief (text sections + mtime + local
//!     authorship) for one ticket.
//!   - `write_ticket_section` — write one section with conflict detection.
//!
//! Both are owner-scoped through the SYNCABLE repositories table
//! (`get_for_user`): the brief files live inside `repository.local_path`, so
//! owning the repo is the access boundary — a different account can never read
//! or write another user's ticket briefs. Ticket data is on-disk (not a DB
//! table), so there is NO `request_sync()` and NO migration (architect #7).

use std::path::Path;
use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::store::{RepositoryRepo, StoreError, WorkspaceRepo};
use crate::tickets::{
    read_brief, write_section, BriefSection, TicketBrief, TicketError, TicketWriteRegistry,
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
    read_ticket_brief_inner(&repository_id, &ticket_id, &current.user_id, &workspaces, &repositories)
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

// ── internals (testable without Tauri `State`) ───────────────────────────────

/// `read_ticket_brief` minus session/State wiring. Owner-scopes on the
/// repository (`get_for_user`), then reads the on-disk brief; the workspace-name
/// title fallback (§C) is best-effort (a ticket with no DB row still reads).
async fn read_ticket_brief_inner(
    repository_id: &str,
    ticket_id: &str,
    user_id: &str,
    workspaces: &WorkspaceRepo,
    repositories: &RepositoryRepo,
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

        let brief = read_ticket_brief_inner(&repo.id, "ticket-1", "user-a", &workspaces, &repos)
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
            read_ticket_brief_inner(&repo.id, "ticket-1", "user-a", &workspaces, &repos)
                .await
                .is_ok()
        );

        // Non-owner: NotFound on the repo gate for both read and write.
        assert!(matches!(
            read_ticket_brief_inner(&repo.id, "ticket-1", "user-b", &workspaces, &repos).await,
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
        let brief = read_ticket_brief_inner(&repo.id, "never-scaffolded", "user-a", &workspaces, &repos)
            .await
            .unwrap();
        assert_eq!(brief.ticket_id, "never-scaffolded");
        assert_eq!(brief.prd.content, "");
        assert_eq!(brief.comment_count, 0);
    }
}
