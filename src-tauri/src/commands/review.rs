//! The Review / QAS gate command surface (Story R1).
//!
//! Review is a FILE, never a `WorkspaceStatus` variant (plan invariant #10 — the
//! Review lane is FE-derived). The decision lives in `review.json` in the ticket
//! folder, layered on top of the honest board state by the FE's derive layer:
//!   - `request_review`  → `review.json{state:"requested"}`; for a PRODUCER
//!     subtask it ALSO composes `publish_contract_inner` so dependents unblock (A5).
//!   - `resolve_review`  → `approve` → `{approved}`; `bounce` →
//!     `{changes-requested, comment}` AND appends the reason to the comment thread
//!     (`add_comment`). A bounce with no comment rejects.
//!   - `get_review`      → read one ticket's `review.json` (null if none).
//!   - `get_board_gates` → ONE batch read of every subtask's `validate.json` +
//!     `review.json` for the board (spec J8), so the board renders in one round-trip.
//!
//! Owner-scoped through `get_for_user` (the subtask/board read is the boundary).
//! Gates are on-disk files, so NO `request_sync()` and NO migration; the composed
//! `publish_contract_inner` handles its own (no-op) sync. Every mutation emits
//! `phasr://board-changed` so the Review lane moves live (architect §R1).

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::commands::board::{publish_contract_inner, BoardCmdError, BoardState};
use crate::domain::Workspace;
use crate::orchestrator::{BoardEventBus, SchedulerConfig, ValidateResult};
use crate::store::{Board, BoardRepo, RepositoryRepo, StoreError, WorkspaceRepo};
use crate::tickets::{
    add_comment, read_gate_file, write_gate_file, GateFile, TicketError, TicketWriteRegistry,
};

// ── wire DTOs (the frozen §C.2 contract; camelCase on the wire) ───────────────

/// The persisted review decision. Kebab-case on the wire so `changes-requested`
/// matches the FE `ReviewState` union verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ReviewState {
    Requested,
    Approved,
    ChangesRequested,
}

/// One ticket's `review.json`. Round-trips through disk (hence `Deserialize`) and
/// returns to the caller. `validatePassed` snapshots the last Validate at the time
/// the review was written, so the reviewer sees what was true when it landed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRecord {
    pub subtask_id: String,
    pub state: ReviewState,
    /// Who wrote the decision. A human gate is always `"you"` in v1 (J9); the
    /// field carries a QAS-agent label once that persona exists (Phase 4/5).
    pub by: String,
    /// The bounce reason; required for `changes-requested`, `None` otherwise.
    pub comment: Option<String>,
    pub at_ms: i64,
    pub validate_passed: bool,
}

/// The `resolve_review` decision. Lowercase on the wire: `"approve" | "bounce"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReviewDecision {
    Approve,
    Bounce,
}

/// The batched gate side-load for a whole board (spec J8): every subtask's cached
/// `review.json` + `validate.json`, read alongside `get_board`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardGates {
    pub reviews: Vec<ReviewRecord>,
    pub validations: Vec<ValidateResult>,
}

// ── error ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum ReviewCmdError {
    Store(StoreError),
    Auth(AuthError),
    Ticket(TicketError),
    /// The composed `publish_contract_inner` failed (producer path).
    Board(BoardCmdError),
    /// The id names a row that isn't a decomposition subtask.
    NotASubtask(String),
    /// A bounce with no (or a blank) comment — the reason is required (SAFe
    /// iteration authority; the agent reads it on re-work).
    MissingComment,
}

impl From<StoreError> for ReviewCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for ReviewCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<TicketError> for ReviewCmdError {
    fn from(e: TicketError) -> Self {
        Self::Ticket(e)
    }
}

impl From<BoardCmdError> for ReviewCmdError {
    fn from(e: BoardCmdError) -> Self {
        Self::Board(e)
    }
}

impl std::fmt::Display for ReviewCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::Ticket(e) => write!(f, "{e}"),
            Self::Board(e) => write!(f, "{e}"),
            Self::NotASubtask(msg) => write!(f, "{msg}"),
            Self::MissingComment => write!(f, "a bounce-back needs a comment explaining what to change"),
        }
    }
}

impl serde::Serialize for ReviewCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Move a ticket into the Review lane. Writes `review.json{state:"requested"}` and,
/// for a producer subtask, composes `publish_contract`. Returns the refreshed board.
#[tauri::command]
pub async fn request_review(
    subtask_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    repositories: State<'_, RepositoryRepo>,
    registry: State<'_, Arc<TicketWriteRegistry>>,
    session: State<'_, Arc<SessionState>>,
    board_events: State<'_, Arc<BoardEventBus>>,
) -> Result<BoardState, ReviewCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let subtask = workspaces.get_for_user(&subtask_id, &current.user_id).await?;
    let assembled = request_review_inner(
        &subtask,
        &current.user_id,
        &workspaces,
        &board,
        &repositories,
        &registry,
        &SchedulerConfig::default(),
    )
    .await?;

    if let Some(parent_id) = subtask.parent_id.as_deref() {
        board_events.notify(parent_id);
    }
    Ok(assembled.into())
}

/// Resolve a review: `approve` → `review.json{approved}`; `bounce` →
/// `{changes-requested, comment}` plus an appended comment. `comment` is required
/// for a bounce. Returns the refreshed board.
#[tauri::command]
pub async fn resolve_review(
    subtask_id: String,
    decision: ReviewDecision,
    comment: Option<String>,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    repositories: State<'_, RepositoryRepo>,
    registry: State<'_, Arc<TicketWriteRegistry>>,
    session: State<'_, Arc<SessionState>>,
    board_events: State<'_, Arc<BoardEventBus>>,
) -> Result<BoardState, ReviewCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let subtask = workspaces.get_for_user(&subtask_id, &current.user_id).await?;
    let assembled = resolve_review_inner(
        &subtask,
        &current.user_id,
        decision,
        comment.as_deref(),
        &workspaces,
        &board,
        &repositories,
        &registry,
    )
    .await?;

    if let Some(parent_id) = subtask.parent_id.as_deref() {
        board_events.notify(parent_id);
    }
    Ok(assembled.into())
}

/// Read one ticket's `review.json` (null if none). Cheap; for the card/header on
/// load. Owner-scoped; tolerant of a malformed file (→ null).
#[tauri::command]
pub async fn get_review(
    subtask_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Option<ReviewRecord>, ReviewCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let subtask = workspaces.get_for_user(&subtask_id, &current.user_id).await?;
    let repository = repositories.get(&subtask.repository_id).await?;
    let Some(repo_root) = repository.local_path.as_deref() else {
        return Ok(None);
    };
    read_review_record(Path::new(repo_root), &subtask_id)
}

/// Batch-read every subtask's gate files for a board (spec J8): one round-trip
/// returning both `reviews` and `validations`. Owner-scoped via the board read.
#[tauri::command]
pub async fn get_board_gates(
    parent_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<BoardGates, ReviewCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let assembled = board
        .get_board_for_user(&workspaces, &parent_id, &current.user_id)
        .await?;
    read_board_gates(&assembled, &repositories).await
}

// ── internals (testable without Tauri `State`) ───────────────────────────────

/// `request_review` minus session/State/event wiring. Writes the `requested`
/// record, composes `publish_contract_inner` for a producer, and reads the board
/// back — owner-scoped throughout. `config` is injectable so tests point the
/// composed contract write at a tempdir instead of `~/.phasr/tasks`.
pub(crate) async fn request_review_inner(
    subtask: &Workspace,
    user_id: &str,
    workspaces: &WorkspaceRepo,
    board: &BoardRepo,
    repositories: &RepositoryRepo,
    registry: &TicketWriteRegistry,
    config: &SchedulerConfig,
) -> Result<Board, ReviewCmdError> {
    let parent_id = subtask_parent(subtask)?;
    let repo_root = owned_repo_root(repositories, &subtask.repository_id).await?;

    // Snapshot the last Validate so the reviewer sees what was true at request time.
    let validate_passed = read_validate_passed(&repo_root, &subtask.id);
    let record = ReviewRecord {
        subtask_id: subtask.id.clone(),
        state: ReviewState::Requested,
        by: "you".to_string(),
        comment: None,
        at_ms: chrono::Utc::now().timestamp_millis(),
        validate_passed,
    };
    write_review(registry, &repo_root, &subtask.id, &record)?;

    // For a PRODUCER (a subtask with an outgoing edge), also publish its contract
    // so dependents still unblock — the two are composed server-side (A5). A
    // consumer-only ticket has no contract to publish, so this is skipped.
    let deps = board.list_dependencies(&parent_id).await?;
    let is_producer = deps.iter().any(|e| e.from_subtask_id == subtask.id);
    if is_producer {
        publish_contract_inner(&subtask.id, user_id, workspaces, board, config).await?;
    }

    Ok(board.get_board_for_user(workspaces, &parent_id, user_id).await?)
}

/// `resolve_review` minus session/State/event wiring. Writes the approve/bounce
/// record; a bounce ALSO appends the reason to the comment thread. Owner-scoped.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn resolve_review_inner(
    subtask: &Workspace,
    user_id: &str,
    decision: ReviewDecision,
    comment: Option<&str>,
    workspaces: &WorkspaceRepo,
    board: &BoardRepo,
    repositories: &RepositoryRepo,
    registry: &TicketWriteRegistry,
) -> Result<Board, ReviewCmdError> {
    let parent_id = subtask_parent(subtask)?;
    let repo_root = owned_repo_root(repositories, &subtask.repository_id).await?;

    // Carry the last known validate snapshot forward (from the existing review if
    // present, else the current validate.json) so it isn't lost on resolve.
    let validate_passed = read_review_record(&repo_root, &subtask.id)?
        .map(|r| r.validate_passed)
        .unwrap_or_else(|| read_validate_passed(&repo_root, &subtask.id));
    let now_ms = chrono::Utc::now().timestamp_millis();

    let record = match decision {
        ReviewDecision::Approve => ReviewRecord {
            subtask_id: subtask.id.clone(),
            state: ReviewState::Approved,
            by: "you".to_string(),
            comment: None,
            at_ms: now_ms,
            validate_passed,
        },
        ReviewDecision::Bounce => {
            let reason = comment.map(str::trim).filter(|c| !c.is_empty());
            let Some(reason) = reason else {
                return Err(ReviewCmdError::MissingComment);
            };
            // Append the reason to the thread so the agent reads it on its next
            // step (SAFe iteration authority); authored "you" per the human gate.
            add_comment(&repo_root, &subtask.id, "you", reason)?;
            ReviewRecord {
                subtask_id: subtask.id.clone(),
                state: ReviewState::ChangesRequested,
                by: "you".to_string(),
                comment: Some(reason.to_string()),
                at_ms: now_ms,
                validate_passed,
            }
        }
    };
    write_review(registry, &repo_root, &subtask.id, &record)?;

    Ok(board.get_board_for_user(workspaces, &parent_id, user_id).await?)
}

/// Batch-read gates for an already-resolved (owner-scoped) board. Split out so
/// tests drive it without Tauri `State`.
async fn read_board_gates(
    assembled: &Board,
    repositories: &RepositoryRepo,
) -> Result<BoardGates, ReviewCmdError> {
    let repository = repositories.get(&assembled.parent.repository_id).await?;
    let mut reviews = Vec::new();
    let mut validations = Vec::new();
    let Some(repo_root) = repository.local_path.as_deref() else {
        // No checkout here → no gate files to read (empty, never an error).
        return Ok(BoardGates { reviews, validations });
    };
    let repo_root = Path::new(repo_root);
    for subtask in &assembled.subtasks {
        if let Some(review) = read_review_record(repo_root, &subtask.id)? {
            reviews.push(review);
        }
        if let Some(raw) = read_gate_file(repo_root, &subtask.id, GateFile::Validate)? {
            if let Ok(result) = serde_json::from_str::<ValidateResult>(&raw) {
                validations.push(result);
            }
        }
    }
    Ok(BoardGates {
        reviews,
        validations,
    })
}

/// The `(parent_id)` of a decomposition subtask, or `NotASubtask`.
fn subtask_parent(subtask: &Workspace) -> Result<String, ReviewCmdError> {
    match (subtask.parent_id.as_ref(), subtask.role.as_ref()) {
        (Some(parent_id), Some(_)) => Ok(parent_id.clone()),
        _ => Err(ReviewCmdError::NotASubtask(format!(
            "workspace `{}` is not a decomposition subtask",
            subtask.id
        ))),
    }
}

/// Resolve the repo's local checkout, where the ticket gate files live. A review
/// is a written file, so a repo with no checkout here can't hold it.
async fn owned_repo_root(
    repositories: &RepositoryRepo,
    repository_id: &str,
) -> Result<std::path::PathBuf, ReviewCmdError> {
    let repository = repositories.get(repository_id).await?;
    repository
        .local_path
        .map(std::path::PathBuf::from)
        .ok_or_else(|| ReviewCmdError::Ticket(TicketError::RepositoryHasNoLocalPath))
}

fn read_review_record(
    repo_root: &Path,
    subtask_id: &str,
) -> Result<Option<ReviewRecord>, ReviewCmdError> {
    match read_gate_file(repo_root, subtask_id, GateFile::Review)? {
        // Tolerant: a hand-corrupted review.json reads as "no review".
        Some(raw) => Ok(serde_json::from_str::<ReviewRecord>(&raw).ok()),
        None => Ok(None),
    }
}

fn read_validate_passed(repo_root: &Path, subtask_id: &str) -> bool {
    read_gate_file(repo_root, subtask_id, GateFile::Validate)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<ValidateResult>(&raw).ok())
        .map(|v| v.passed)
        .unwrap_or(false)
}

fn write_review(
    registry: &TicketWriteRegistry,
    repo_root: &Path,
    subtask_id: &str,
    record: &ReviewRecord,
) -> Result<(), ReviewCmdError> {
    let bytes = serde_json::to_vec_pretty(record).map_err(|e| TicketError::Serde(e.to_string()))?;
    write_gate_file(registry, repo_root, subtask_id, GateFile::Review, &bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::board::{
        create_decomposition_inner, DecompositionInput, EdgeInput, SubtaskInput,
    };
    use crate::domain::{Agent, Repository};
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

    /// A board (parent + backend→frontend subtasks) under a repo with an on-disk
    /// checkout, so gate files have somewhere to live. Returns the repos, board,
    /// the assembled `Board`, and the kept-alive TempDir.
    async fn setup() -> (
        WorkspaceRepo,
        BoardRepo,
        RepositoryRepo,
        Board,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("test.sqlite")).await.unwrap();
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let repos = RepositoryRepo::new(pool.clone());
        seed_user(&pool, "user-a").await;

        let checkout = dir.path().join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        let repo = Repository::new(
            "repo".into(),
            Some(checkout.to_string_lossy().into_owned()),
            None,
        );
        repos.insert_for_user(&repo, "user-a").await.unwrap();

        let input = DecompositionInput {
            repository_id: repo.id.clone(),
            parent_prompt: "build it".into(),
            subtasks: vec![
                SubtaskInput { role: "backend".into(), agent: Agent::Claude, prompt: "be".into() },
                SubtaskInput { role: "frontend".into(), agent: Agent::Claude, prompt: "fe".into() },
            ],
            edges: vec![EdgeInput { from_role: "backend".into(), to_role: "frontend".into() }],
        };
        let assembled =
            create_decomposition_inner(&input, "user-a", &workspaces, &board, &repos)
                .await
                .unwrap();
        (workspaces, board, repos, assembled, dir)
    }

    fn subtask_by_role<'a>(board: &'a Board, role: &str) -> &'a Workspace {
        board
            .subtasks
            .iter()
            .find(|s| s.role.as_deref() == Some(role))
            .unwrap()
    }

    fn repo_root(repos_dir: &tempfile::TempDir) -> std::path::PathBuf {
        repos_dir.path().join("checkout")
    }

    fn scheduler_config(dir: &tempfile::TempDir) -> SchedulerConfig {
        let mut config = SchedulerConfig::default();
        // Point the composed contract write at a tempdir, NOT `~/.phasr/tasks`.
        config.contract_root = dir.path().join("contracts");
        config
    }

    // R1: request_review writes review.json{requested}.
    #[tokio::test]
    async fn request_review_writes_requested() {
        let (workspaces, board, repos, assembled, dir) = setup().await;
        let frontend = subtask_by_role(&assembled, "frontend"); // consumer-only
        let registry = TicketWriteRegistry::default();

        request_review_inner(
            frontend, "user-a", &workspaces, &board, &repos, &registry, &scheduler_config(&dir),
        )
        .await
        .unwrap();

        let review = read_review_record(&repo_root(&dir), &frontend.id).unwrap().unwrap();
        assert_eq!(review.state, ReviewState::Requested);
        assert_eq!(review.by, "you");
    }

    // R1: request_review on a PRODUCER also publishes its contract (dependents
    // unblock) — the compose in A5.
    #[tokio::test]
    async fn request_review_on_producer_publishes_contract() {
        let (workspaces, board, repos, assembled, dir) = setup().await;
        let backend = subtask_by_role(&assembled, "backend"); // has outgoing edge
        let registry = TicketWriteRegistry::default();

        request_review_inner(
            backend, "user-a", &workspaces, &board, &repos, &registry, &scheduler_config(&dir),
        )
        .await
        .unwrap();

        let contract = board.find_contract(&backend.id).await.unwrap();
        assert!(
            contract.map(|c| c.published_at.is_some()).unwrap_or(false),
            "a producer's request-review must publish its contract"
        );
    }

    // R1: approve → review.json{approved}.
    #[tokio::test]
    async fn resolve_review_approve_writes_approved() {
        let (workspaces, board, repos, assembled, dir) = setup().await;
        let frontend = subtask_by_role(&assembled, "frontend");
        let registry = TicketWriteRegistry::default();

        resolve_review_inner(
            frontend, "user-a", ReviewDecision::Approve, None, &workspaces, &board, &repos, &registry,
        )
        .await
        .unwrap();

        let review = read_review_record(&repo_root(&dir), &frontend.id).unwrap().unwrap();
        assert_eq!(review.state, ReviewState::Approved);
    }

    // R1: bounce → review.json{changes-requested, comment} AND the reason is
    // appended to the comment thread.
    #[tokio::test]
    async fn resolve_review_bounce_writes_changes_requested_and_appends_comment() {
        let (workspaces, board, repos, assembled, dir) = setup().await;
        let frontend = subtask_by_role(&assembled, "frontend");
        let registry = TicketWriteRegistry::default();

        resolve_review_inner(
            frontend,
            "user-a",
            ReviewDecision::Bounce,
            Some("fix the empty state"),
            &workspaces,
            &board,
            &repos,
            &registry,
        )
        .await
        .unwrap();

        let review = read_review_record(&repo_root(&dir), &frontend.id).unwrap().unwrap();
        assert_eq!(review.state, ReviewState::ChangesRequested);
        assert_eq!(review.comment.as_deref(), Some("fix the empty state"));

        let comments = crate::tickets::list_comments(&repo_root(&dir), &frontend.id).unwrap();
        assert!(
            comments.iter().any(|c| c.body == "fix the empty state"),
            "a bounce must append its reason to the thread"
        );
    }

    // R1: a bounce with no comment (or a blank one) rejects — the reason is
    // required.
    #[tokio::test]
    async fn bounce_without_comment_rejects() {
        let (workspaces, board, repos, assembled, _dir) = setup().await;
        let frontend = subtask_by_role(&assembled, "frontend");
        let registry = TicketWriteRegistry::default();

        assert!(matches!(
            resolve_review_inner(
                frontend, "user-a", ReviewDecision::Bounce, None, &workspaces, &board, &repos, &registry,
            )
            .await,
            Err(ReviewCmdError::MissingComment)
        ));
        assert!(matches!(
            resolve_review_inner(
                frontend, "user-a", ReviewDecision::Bounce, Some("   "), &workspaces, &board, &repos, &registry,
            )
            .await,
            Err(ReviewCmdError::MissingComment)
        ));
    }

    // A non-subtask id rejects `NotASubtask`.
    #[tokio::test]
    async fn rejects_non_subtask() {
        let (workspaces, board, repos, assembled, dir) = setup().await;
        let _ = &assembled;
        let registry = TicketWriteRegistry::default();
        let agent = Workspace::new("repo".into(), "solo".into(), "cmd".into());

        assert!(matches!(
            request_review_inner(
                &agent, "user-a", &workspaces, &board, &repos, &registry, &scheduler_config(&dir),
            )
            .await,
            Err(ReviewCmdError::NotASubtask(_))
        ));
    }

    // J8: get_board_gates batch-reads each subtask's review.json + validate.json.
    #[tokio::test]
    async fn board_gates_batch_reads_reviews_and_validations() {
        let (workspaces, board, repos, assembled, dir) = setup().await;
        let backend = subtask_by_role(&assembled, "backend");
        let frontend = subtask_by_role(&assembled, "frontend");
        let registry = TicketWriteRegistry::default();

        // Approve the frontend; write a validate.json for the backend by hand.
        resolve_review_inner(
            frontend, "user-a", ReviewDecision::Approve, None, &workspaces, &board, &repos, &registry,
        )
        .await
        .unwrap();
        let validate = ValidateResult {
            subtask_id: backend.id.clone(),
            checks: vec![],
            passed: false,
            ran_at_ms: 0,
        };
        let bytes = serde_json::to_vec_pretty(&validate).unwrap();
        write_gate_file(&registry, &repo_root(&dir), &backend.id, GateFile::Validate, &bytes).unwrap();

        let gates = read_board_gates(&assembled, &repos).await.unwrap();
        assert_eq!(gates.reviews.len(), 1, "one review (frontend)");
        assert_eq!(gates.reviews[0].subtask_id, frontend.id);
        assert_eq!(gates.validations.len(), 1, "one validation (backend)");
        assert_eq!(gates.validations[0].subtask_id, backend.id);
    }
}
