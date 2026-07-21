//! Autopilot enable/persist + kill switch command surface (Phase 5a, Stage A —
//! spec §5).
//!
//! Three thin commands:
//!   - `set_autopilot(parent_id, enabled)` — flip an epic's per-parent
//!     `autopilot_enabled` flag (migration 0015). Owner-scoped; returns the
//!     refreshed board and emits `phasr://board-changed` so the toggle surfaces
//!     live (mirrors `request_review`/`resolve_review`).
//!   - `set_autopilot_kill_switch(halted)` — flip the GLOBAL persisted true-halt
//!     (§5). Machine-local singleton (`autopilot_state`); NOT owner-scoped.
//!   - `get_autopilot_state()` — read `{ killSwitchHalted }` for the FE halted
//!     banner.
//!
//! Autopilot is board (parent) state — LOCAL-ONLY (board rows never sync, the
//! `workspace_kind='agent'` PUSH filter), so like the other gate mutations there
//! is NO `request_sync()` and no sync change.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::commands::board::BoardState;
use crate::domain::WorkspaceKind;
use crate::orchestrator::BoardEventBus;
use crate::store::{AutopilotStateRepo, BoardRepo, StoreError, WorkspaceRepo, WorkspaceUpdate};

// ── wire DTO (camelCase on the wire) ──────────────────────────────────────────

/// The global autopilot state the FE halted-banner reads. `killSwitchHalted` is
/// the PERSISTED true-halt (§5) — while set, the driver no-ops and the FE shows a
/// persistent "Autopilot halted" banner with a single "Resume".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotState {
    pub kill_switch_halted: bool,
}

// ── error ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum AutopilotCmdError {
    Store(StoreError),
    Auth(AuthError),
    /// `set_autopilot` was called on a row that isn't an epic (`parent`). The flag
    /// is only meaningful on a decomposition container (§5).
    NotAnEpic(String),
}

impl From<StoreError> for AutopilotCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for AutopilotCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for AutopilotCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::NotAnEpic(msg) => write!(f, "{msg}"),
        }
    }
}

impl serde::Serialize for AutopilotCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Toggle an epic's autopilot. Owner-scoped: only the epic's owner can flip its
/// flag. Writes `autopilot_enabled` via the workspace repo and returns the
/// refreshed board (so the FE re-renders without a follow-up `get_board`), emitting
/// `phasr://board-changed` so an open board moves live.
#[tauri::command]
pub async fn set_autopilot(
    parent_id: String,
    enabled: bool,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    session: State<'_, Arc<SessionState>>,
    board_events: State<'_, Arc<BoardEventBus>>,
) -> Result<BoardState, AutopilotCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    // Owner-scoped gate: `NotFound` for another account's epic (the id then acts
    // as a not-found, never a cross-user leak).
    let parent = workspaces.get_for_user(&parent_id, &current.user_id).await?;
    if parent.workspace_kind != WorkspaceKind::Parent {
        return Err(AutopilotCmdError::NotAnEpic(format!(
            "workspace `{parent_id}` is not an epic; autopilot is a per-epic toggle"
        )));
    }

    // Flip the flag (the ownership gate above is the boundary; `update` keys by id).
    workspaces
        .update(
            &parent.id,
            WorkspaceUpdate {
                autopilot_enabled: Some(enabled),
                ..Default::default()
            },
        )
        .await?;

    board_events.notify(&parent_id);
    // Return the refreshed board — its `parent.autopilotEnabled` now carries the
    // new value, so the FE threads it into `worklistBucket`/`deriveNextGate`.
    let assembled = board
        .get_board_for_user(&workspaces, &parent_id, &current.user_id)
        .await?;
    Ok(assembled.into())
}

/// Flip the GLOBAL persisted kill switch — a TRUE halt that survives a
/// crash/reboot (§5). Process-wide (one panic-button stops every epic), so it is
/// NOT owner-scoped — just the signed-in gate. There is NO auto-resume; the FE
/// re-arms it explicitly.
#[tauri::command]
pub async fn set_autopilot_kill_switch(
    halted: bool,
    autopilot_state: State<'_, AutopilotStateRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<(), AutopilotCmdError> {
    session.require()?;
    autopilot_state.set_kill_switch(halted).await?;
    Ok(())
}

/// Read the global autopilot state (`{ killSwitchHalted }`) for the FE halted
/// banner. Cheap; a missing singleton row reads as "not halted" (never wedges).
#[tauri::command]
pub async fn get_autopilot_state(
    autopilot_state: State<'_, AutopilotStateRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<AutopilotState, AutopilotCmdError> {
    session.require()?;
    Ok(AutopilotState {
        kill_switch_halted: autopilot_state.kill_switch_halted().await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, Workspace};
    use crate::store::{init_pool, Db, RepositoryRepo};

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

    /// A repo owned by `user-a` with one `parent` (epic) workspace. Returns the
    /// repos + the parent id + the kept-alive pool.
    async fn setup() -> (WorkspaceRepo, BoardRepo, AutopilotStateRepo, String) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("test.sqlite")).await.unwrap();
        std::mem::forget(dir);
        let repos = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let autopilot_state = AutopilotStateRepo::new(pool.clone());
        seed_user(&pool, "user-a").await;
        seed_user(&pool, "user-b").await;

        let repo = Repository::new("repo".into(), None, None);
        repos.insert_for_user(&repo, "user-a").await.unwrap();
        let mut parent = Workspace::new(repo.id.clone(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;
        workspaces.insert_for_user(&parent, "user-a").await.unwrap();

        (workspaces, board, autopilot_state, parent.id)
    }

    // S3: set_autopilot flips the epic's `autopilot_enabled` flag through the
    // workspace repo, owner-scoped. (The Tauri-`State` wiring is thin; the
    // repo-level write is exercised here without it.)
    #[tokio::test]
    async fn set_autopilot_flips_the_epic_flag() {
        let (workspaces, _board, _state, parent_id) = setup().await;

        // Defaults off.
        assert!(!workspaces.get(&parent_id).await.unwrap().autopilot_enabled);

        // Owner-scoped write (mirrors the command body: get_for_user gate → update).
        let parent = workspaces.get_for_user(&parent_id, "user-a").await.unwrap();
        assert_eq!(parent.workspace_kind, WorkspaceKind::Parent);
        workspaces
            .update(
                &parent.id,
                WorkspaceUpdate {
                    autopilot_enabled: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(workspaces.get(&parent_id).await.unwrap().autopilot_enabled);

        // …and back off.
        workspaces
            .update(
                &parent.id,
                WorkspaceUpdate {
                    autopilot_enabled: Some(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(!workspaces.get(&parent_id).await.unwrap().autopilot_enabled);
    }

    // S3 owner-scoping: a different signed-in account can never resolve another
    // user's epic (the `get_for_user` gate returns NotFound), so it can never
    // toggle its autopilot.
    #[tokio::test]
    async fn set_autopilot_is_scoped_to_the_epic_owner() {
        let (workspaces, _board, _state, parent_id) = setup().await;
        assert!(matches!(
            workspaces.get_for_user(&parent_id, "user-b").await,
            Err(StoreError::NotFound)
        ));
    }

    // S3: the `NotAnEpic` guard — the flag is only meaningful on a `parent` row;
    // a subtask/agent workspace is rejected.
    #[tokio::test]
    async fn set_autopilot_rejects_a_non_epic_row() {
        let (workspaces, _board, _state, _parent_id) = setup().await;
        let repo_id = workspaces.get(&_parent_id).await.unwrap().repository_id;
        let agent = Workspace::new(repo_id, "solo".into(), "cmd".into());
        workspaces.insert_for_user(&agent, "user-a").await.unwrap();

        // Mirror the command's guard: a non-parent kind → NotAnEpic.
        let ws = workspaces.get_for_user(&agent.id, "user-a").await.unwrap();
        assert_ne!(ws.workspace_kind, WorkspaceKind::Parent);
    }

    // S3: the kill switch round-trips through get_autopilot_state's read path (a
    // persisted true-halt) — the FE banner reads exactly this.
    #[tokio::test]
    async fn kill_switch_state_round_trips() {
        let (_workspaces, _board, state, _parent_id) = setup().await;

        assert!(!state.kill_switch_halted().await.unwrap(), "defaults to running");
        state.set_kill_switch(true).await.unwrap();
        let dto = AutopilotState {
            kill_switch_halted: state.kill_switch_halted().await.unwrap(),
        };
        assert!(dto.kill_switch_halted, "a set halt reads back true");

        // Wire-shape check: the DTO serializes camelCase `killSwitchHalted`.
        let json = serde_json::to_value(&dto).unwrap();
        assert_eq!(json["killSwitchHalted"], true);
    }
}
