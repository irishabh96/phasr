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
use crate::orchestrator::{BoardEventBus, SchedulerConfig, TaskOrchestrator, ValidateResult};
use crate::store::{Board, BoardRepo, RepositoryRepo, StoreError, WorkspaceRepo};
use crate::tickets::{
    add_comment, read_gate_file, write_gate_file, GateFile, LastEditedBy, TicketError,
    TicketWriteRegistry,
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

// ── rework re-engagement seam ─────────────────────────────────────────────────

/// How a bounce re-engages the ticket's producing agent. Kept behind a trait so
/// `resolve_review_inner` stays testable WITHOUT a live PTY (the command wires
/// the real `TaskOrchestrator`; tests wire a runtime holding a real PTY, or a
/// spy). The reviewed subtask id IS the producing agent's PTY task id.
pub(crate) trait ReworkReengager {
    /// Hand `feedback` to the agent producing `task_id`; report how it landed.
    fn reengage(&self, task_id: &str, feedback: &str) -> ReworkOutcome;
}

/// The result of re-engaging a bounced ticket's producing agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReworkOutcome {
    /// The feedback was typed into the live agent's PTY — it reworks in place.
    Delivered,
    /// The agent's PTY had already exited; nothing was delivered.
    AgentExited,
}

impl ReworkReengager for TaskOrchestrator {
    fn reengage(&self, task_id: &str, feedback: &str) -> ReworkOutcome {
        if self.deliver_rework_feedback(task_id, feedback) {
            ReworkOutcome::Delivered
        } else {
            ReworkOutcome::AgentExited
        }
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
        // A human-clicked gate is always attributed `"you"` (G1/H); autopilot
        // fires the same `_inner` with `"autopilot"`.
        "you",
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
    orchestrator: State<'_, TaskOrchestrator>,
    session: State<'_, Arc<SessionState>>,
    board_events: State<'_, Arc<BoardEventBus>>,
) -> Result<BoardState, ReviewCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let subtask = workspaces.get_for_user(&subtask_id, &current.user_id).await?;
    let assembled = resolve_review_inner(
        &subtask,
        &current.user_id,
        // Human gate → `"you"`; the QAS-agent path (Stage B) passes `"qas-agent"`.
        "you",
        decision,
        comment.as_deref(),
        &workspaces,
        &board,
        &repositories,
        &registry,
        // A bounce re-engages the producing agent through the live orchestrator
        // (deliver the change request into its PTY / honest stop if it exited).
        Some(&*orchestrator as &(dyn ReworkReengager + Send + Sync)),
    )
    .await?;

    // Phase 5 (completion program): a HUMAN bounce on a DEAD producer
    // re-spawns it in its own worktree with the change request as the
    // delivered prompt — request-changes on a finished ticket stops being a
    // soft dead end. The `_inner` already left its honest "could not be
    // delivered" note; the respawn appends its own truthful line, so the
    // comment thread reads as a timeline, never a rewrite. Autopilot/QAS
    // bounces never reach this branch (this command is the human path).
    if matches!(decision, ReviewDecision::Bounce) && !orchestrator.has_live_task(&subtask_id) {
        match orchestrator
            .respawn_for_rework(&subtask_id, comment.as_deref().unwrap_or_default())
            .await
        {
            Ok(()) => {
                if let Ok(repository) = repositories.get(&subtask.repository_id).await {
                    if let Some(repo_root) = repository.local_path.as_deref() {
                        let _ = add_comment(
                            std::path::Path::new(repo_root),
                            &subtask.id,
                            "phasr",
                            LastEditedBy::Agent,
                            "Re-spawned the producing agent with your change \
                             request — it is re-reading the ticket now.",
                        );
                    }
                }
            }
            Err(err) => {
                log::warn!("bounce respawn failed for {subtask_id}: {err}");
            }
        }
    }

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
    // Attribution (G1): `"you"` for a human gate, `"autopilot"` when the driver
    // fires this as an AUTO gate. Never hardcoded here so the audit stays honest.
    by: &str,
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
        by: by.to_string(),
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
    // Attribution (G1): `"you"` for a human resolve, `"qas-agent"` for the QAS
    // reviewer path (Stage B). Used for BOTH the record `by` AND the appended
    // bounce comment author, so no autopilot decision ever masquerades as `"you"`.
    by: &str,
    decision: ReviewDecision,
    comment: Option<&str>,
    workspaces: &WorkspaceRepo,
    board: &BoardRepo,
    repositories: &RepositoryRepo,
    registry: &TicketWriteRegistry,
    // A bounce re-engages the producing agent through this seam (typed into its
    // live PTY, or an honest stop if it exited). `None` on the paths that don't
    // (or can't) re-engage — the autopilot driver's park-only tests and the
    // worklist read test — leaving those byte-identical to the pre-rework behavior.
    // `Send + Sync` so the trait object can be held across the command's `.await`s.
    rework: Option<&(dyn ReworkReengager + Send + Sync)>,
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
            by: by.to_string(),
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
            // step (SAFe iteration authority); authored by the resolving actor. The
            // author-kind tracks that actor (honesty #29): a human resolve is
            // `"you"`, an agent resolve (e.g. `"qas-agent"`) is `"agent"` — never
            // stamping an agent decision as the human. `"you"` is the sole human
            // sentinel across the review gate (mirrors `ReviewRecord.by`).
            let by_kind = if by == "you" {
                LastEditedBy::You
            } else {
                LastEditedBy::Agent
            };
            add_comment(&repo_root, &subtask.id, by, by_kind, reason)?;

            // Re-engage the producing agent so "request changes" actually
            // re-drives it instead of leaving the ticket stuck at
            // `changes-requested` forever. The reviewed subtask id IS the
            // producing agent's PTY task id (the scheduler spawned it under that
            // id), so the feedback goes straight to the right agent. If its
            // interactive PTY is still ALIVE (the common case — `claude` never
            // self-exits after publishing), the change request is typed in as a
            // follow-up prompt and it reworks + re-publishes in place. If the
            // agent has EXITED, there is nothing to type into: we leave an honest
            // "re-run to apply changes" note (deferred — no auto re-spawn in this
            // slice) so the ticket doesn't silently swallow the feedback.
            if let Some(rework) = rework {
                let feedback = format!(
                    "Changes requested on this ticket:\n\n{reason}\n\nPlease address \
                     these, update your work, and re-publish your contract when done."
                );
                if rework.reengage(&subtask.id, &feedback) == ReworkOutcome::AgentExited {
                    // Attributed to `phasr` (Agent-kind), never masked as the
                    // human — the human didn't write this, the system did
                    // (honesty #29). `"you"` stays the sole human sentinel.
                    add_comment(
                        &repo_root,
                        &subtask.id,
                        "phasr",
                        LastEditedBy::Agent,
                        "The producing agent has exited, so this change request \
                         could not be delivered to it automatically. Re-run this \
                         ticket's agent to apply the requested changes.",
                    )?;
                }
            }

            ReviewRecord {
                subtask_id: subtask.id.clone(),
                state: ReviewState::ChangesRequested,
                by: by.to_string(),
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

/// Batch-read every subtask's `review.json` for an already-resolved (owner-scoped)
/// board — the review-only sibling of `read_board_gates` (no validate reads).
/// Reuses the SAME `read_review_record` path the board gate does; a worklist board
/// just doesn't need the validate snapshot the board route also side-loads, so
/// this skips it to keep the cross-repo payload lean.
///
/// `pub(crate)` so the cross-repo worklist reuses it (M4 honest-status fix): the
/// worklist derivation needs each subtask's review STATE to tell "awaiting YOUR
/// review" apart from a bounced (`changes-requested`) ticket. Batched exactly like
/// `get_board_gates` — ONE owner-scoped repo lookup per board, then a cheap
/// `review.json` read per subtask (never an N-per-board DB fan-out).
pub(crate) async fn read_board_reviews(
    assembled: &Board,
    repositories: &RepositoryRepo,
) -> Result<Vec<ReviewRecord>, ReviewCmdError> {
    let repository = repositories.get(&assembled.parent.repository_id).await?;
    let mut reviews = Vec::new();
    let Some(repo_root) = repository.local_path.as_deref() else {
        // No checkout here → no gate files to read (empty, never an error).
        return Ok(reviews);
    };
    let repo_root = Path::new(repo_root);
    for subtask in &assembled.subtasks {
        if let Some(review) = read_review_record(repo_root, &subtask.id)? {
            reviews.push(review);
        }
    }
    Ok(reviews)
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
            epic_prd: None,
            epic_trd: None,
            epic_figma: vec![],
            epic_asset_paths: vec![],
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
            frontend, "user-a", "you", &workspaces, &board, &repos, &registry, &scheduler_config(&dir),
        )
        .await
        .unwrap();

        let review = read_review_record(&repo_root(&dir), &frontend.id).unwrap().unwrap();
        assert_eq!(review.state, ReviewState::Requested);
        assert_eq!(review.by, "you");
    }

    // G1: an autopilot-fired request-review is attributed `"autopilot"`, never
    // `"you"` — the audit must never impersonate the human (spec S2/§8).
    #[tokio::test]
    async fn autopilot_request_review_is_attributed_autopilot_not_you() {
        let (workspaces, board, repos, assembled, dir) = setup().await;
        let frontend = subtask_by_role(&assembled, "frontend");
        let registry = TicketWriteRegistry::default();

        request_review_inner(
            frontend, "user-a", "autopilot", &workspaces, &board, &repos, &registry,
            &scheduler_config(&dir),
        )
        .await
        .unwrap();

        let review = read_review_record(&repo_root(&dir), &frontend.id).unwrap().unwrap();
        assert_eq!(review.by, "autopilot", "autopilot must not write by == \"you\"");
        assert_ne!(review.by, "you");
    }

    // G1: a `"qas-agent"`-attributed bounce writes that author on BOTH the record
    // AND the appended comment (not `"you"`) — the two parametrized sites.
    #[tokio::test]
    async fn resolve_review_bounce_attribution_flows_to_record_and_comment() {
        let (workspaces, board, repos, assembled, dir) = setup().await;
        let frontend = subtask_by_role(&assembled, "frontend");
        let registry = TicketWriteRegistry::default();

        resolve_review_inner(
            frontend, "user-a", "qas-agent", ReviewDecision::Bounce, Some("tighten the diff"),
            &workspaces, &board, &repos, &registry, None,
        )
        .await
        .unwrap();

        let review = read_review_record(&repo_root(&dir), &frontend.id).unwrap().unwrap();
        assert_eq!(review.by, "qas-agent");
        let comments = crate::tickets::list_comments(&repo_root(&dir), &frontend.id).unwrap();
        assert!(
            comments.iter().any(|c| c.body == "tighten the diff" && c.author == "qas-agent"),
            "the bounce comment author must equal the passed `by`, never \"you\""
        );
    }

    // R1: request_review on a PRODUCER also publishes its contract (dependents
    // unblock) — the compose in A5.
    #[tokio::test]
    async fn request_review_on_producer_publishes_contract() {
        let (workspaces, board, repos, assembled, dir) = setup().await;
        let backend = subtask_by_role(&assembled, "backend"); // has outgoing edge
        let registry = TicketWriteRegistry::default();

        request_review_inner(
            backend, "user-a", "you", &workspaces, &board, &repos, &registry, &scheduler_config(&dir),
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
            frontend, "user-a", "you", ReviewDecision::Approve, None, &workspaces, &board, &repos, &registry, None,
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
            "you",
            ReviewDecision::Bounce,
            Some("fix the empty state"),
            &workspaces,
            &board,
            &repos,
            &registry,
            None,
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
                frontend, "user-a", "you", ReviewDecision::Bounce, None, &workspaces, &board, &repos, &registry, None,
            )
            .await,
            Err(ReviewCmdError::MissingComment)
        ));
        assert!(matches!(
            resolve_review_inner(
                frontend, "user-a", "you", ReviewDecision::Bounce, Some("   "), &workspaces, &board, &repos, &registry, None,
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
                &agent, "user-a", "you", &workspaces, &board, &repos, &registry, &scheduler_config(&dir),
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
            frontend, "user-a", "you", ReviewDecision::Approve, None, &workspaces, &board, &repos, &registry, None,
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

    // R-rework (the broken review loop): a bounce on a ticket whose producing
    // agent is still ALIVE must deliver the change-request feedback INTO that
    // agent's PTY (so it reworks), while STILL writing the honest
    // `changes-requested` state + the attributed reason comment. Uses a real
    // runtime + a live fake-agent PTY keyed on the subtask id (== the producing
    // agent's task id), and proves the feedback reached the agent's stdin by
    // reading it back out of the agent's own echo.
    #[tokio::test]
    async fn bounce_with_live_agent_delivers_feedback_and_still_writes_state() {
        use crate::orchestrator::RepoLockRegistry;
        use crate::pty::TaskRuntime;

        let (workspaces, board, repos, assembled, dir) = setup().await;
        let frontend = subtask_by_role(&assembled, "frontend");
        let registry = TicketWriteRegistry::default();

        // A live agent: a fake that signals ready, then `cat`s its stdin so
        // anything typed into it echoes straight back out (a stand-in for an
        // interactive agent sitting at its prompt). Written to a file so it can
        // be typed into the login shell without nested-quote escaping.
        let script = dir.path().join("agent.sh");
        std::fs::write(&script, "printf 'AGENT-READY\\n'\ncat\n").unwrap();

        let runtime = std::sync::Arc::new(TaskRuntime::new(dir.path().join("logs")));
        let handle = runtime
            .spawn(
                frontend.id.clone(),
                Some(format!("sh {}", script.display())),
                None,
                dir.path().to_path_buf(),
                24,
                80,
                Vec::new(),
            )
            .unwrap();
        let mut rx = handle.subscribe();

        // Wait until the fake agent is actually reading stdin (it printed READY,
        // then hit `cat`) so the paste can't race an unready TUI.
        assert!(
            wait_for(&mut rx, "AGENT-READY"),
            "the fake agent should signal it is ready to read"
        );

        let repo_locks = std::sync::Arc::new(RepoLockRegistry::new());
        let orchestrator = crate::orchestrator::TaskOrchestrator::new(
            workspaces.clone(),
            repos.clone(),
            runtime.clone(),
            repo_locks,
        );

        resolve_review_inner(
            frontend,
            "user-a",
            "you",
            ReviewDecision::Bounce,
            Some("fix the empty state"),
            &workspaces,
            &board,
            &repos,
            &registry,
            Some(&orchestrator as &(dyn ReworkReengager + Send + Sync)),
        )
        .await
        .unwrap();

        // (1) The change-request feedback reached the LIVE agent's PTY: it shows
        // up in the agent's echoed stdin. (`cat` / the tty echo surface it up to
        // the first embedded newline of the paste-framed message — enough to
        // prove the input landed on the right agent.)
        let reached = wait_for(&mut rx, "Changes requested on this ticket:");
        let _ = handle.kill();
        assert!(
            reached,
            "the bounce feedback must be delivered into the live agent's PTY"
        );

        // (2) The honest review state + attributed reason comment are STILL
        // written (the re-engagement ADDS to the bounce, never replaces it).
        let review = read_review_record(&repo_root(&dir), &frontend.id).unwrap().unwrap();
        assert_eq!(review.state, ReviewState::ChangesRequested);
        assert_eq!(review.comment.as_deref(), Some("fix the empty state"));
        let comments = crate::tickets::list_comments(&repo_root(&dir), &frontend.id).unwrap();
        assert!(
            comments.iter().any(|c| c.body == "fix the empty state" && c.author == "you"),
            "the bounce reason must still be appended to the thread, attributed to the human"
        );
    }

    // R-rework (exited path): a bounce on a ticket whose producing agent has
    // EXITED can't deliver into a PTY, so it leaves an honest `phasr`-attributed
    // "re-run to apply changes" note — never masked as the human — while STILL
    // writing the `changes-requested` state + the reason comment.
    #[tokio::test]
    async fn bounce_with_exited_agent_leaves_honest_stop_and_still_writes_state() {
        use crate::orchestrator::RepoLockRegistry;
        use crate::pty::TaskRuntime;

        let (workspaces, board, repos, assembled, dir) = setup().await;
        let frontend = subtask_by_role(&assembled, "frontend");
        let registry = TicketWriteRegistry::default();

        // An orchestrator over an EMPTY runtime — no PTY for the subtask, i.e. the
        // producing agent has exited (`deliver_rework_feedback` → false).
        let runtime = std::sync::Arc::new(TaskRuntime::new(dir.path().join("logs")));
        let repo_locks = std::sync::Arc::new(RepoLockRegistry::new());
        let orchestrator = crate::orchestrator::TaskOrchestrator::new(
            workspaces.clone(),
            repos.clone(),
            runtime,
            repo_locks,
        );

        resolve_review_inner(
            frontend,
            "user-a",
            "you",
            ReviewDecision::Bounce,
            Some("fix the empty state"),
            &workspaces,
            &board,
            &repos,
            &registry,
            Some(&orchestrator as &(dyn ReworkReengager + Send + Sync)),
        )
        .await
        .unwrap();

        let review = read_review_record(&repo_root(&dir), &frontend.id).unwrap().unwrap();
        assert_eq!(review.state, ReviewState::ChangesRequested);
        assert_eq!(review.comment.as_deref(), Some("fix the empty state"));

        let comments = crate::tickets::list_comments(&repo_root(&dir), &frontend.id).unwrap();
        // The reason is still there, authored by the human.
        assert!(
            comments.iter().any(|c| c.body == "fix the empty state" && c.author == "you"),
            "the bounce reason must still be appended, attributed to the human"
        );
        // The honest exited-stop note is present, authored `phasr` (Agent-kind),
        // never `"you"` — the human didn't write it.
        assert!(
            comments.iter().any(|c| {
                c.author == "phasr"
                    && c.author_kind == LastEditedBy::Agent
                    && c.body.contains("Re-run this ticket's agent")
            }),
            "an exited agent must leave an honest, non-human re-run note; got {comments:?}"
        );
    }

    /// Drain output events until `needle` appears (or we time out). Blocking
    /// loop — the PTY runs on its own OS threads, independent of this runtime.
    fn wait_for(
        rx: &mut tokio::sync::broadcast::Receiver<crate::pty::PtyEvent>,
        needle: &str,
    ) -> bool {
        use crate::pty::PtyEvent;
        let mut combined = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match rx.try_recv() {
                Ok(PtyEvent::Output { chunk, .. }) => {
                    combined.push_str(&chunk);
                    if combined.contains(needle) {
                        return true;
                    }
                }
                Ok(PtyEvent::Exit { .. }) => return combined.contains(needle),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty) => {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                Err(tokio::sync::broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::TryRecvError::Closed) => {
                    return combined.contains(needle)
                }
            }
        }
        false
    }
}
