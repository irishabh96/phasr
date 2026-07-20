//! Worklist cross-repo query (Phase 2, story T6) — `commands/worklist.rs`.
//!
//! `list_worklist()` is the single call that powers the "Worklist / Home"
//! surface: the cross-repo JOIN of every repository, every epic's board, and
//! every loose (non-decomposition) agent for the SIGNED-IN user. It computes NO
//! attention state — the frontend derives every bucket (Needs-you / Running /
//! Waiting / Recent) in ONE place (`deriveWorklist.ts::worklistBucket`), exactly
//! how the board derives its lanes (spec §A4). Keeping "what's true" defined
//! frontend-side is what keeps `blocked`/`needs-review` OUT of the stored
//! `WorkspaceStatus` (spec claim #10 / plan invariant).
//!
//! ## Owner scoping (`#EXPORT_CRITICAL`)
//!
//! Every read is `_for_user`: `list_for_user` (repos), `list_by_repository_for_user`
//! (top-level rows), `get_board_for_user` (each epic). A different signed-in
//! account can NEVER see another user's repos, boards, or agents — the invariant
//! `get_board_for_user` already enforces (`store/board.rs`). NEVER the unscoped
//! `list_parents()` — it carries no `user_id` (spec §0 claim #5), so it would
//! leak another account's epics.
//!
//! ## Cost
//!
//! O(repos + parents) local SQLite: one `list_for_user`, one
//! `list_by_repository_for_user` per repo, one `get_board_for_user` per epic
//! (each a handful of small indexed reads). No new store query is required
//! (architect #3) — the whole join reuses the existing owner-scoped methods.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::{Workspace, WorkspaceKind};
use crate::store::{BoardRepo, RepositoryRepo, StoreError, WorkspaceRepo};

use super::board::BoardState;

// ── wire DTOs (the frozen §C.3 contract; camelCase on the wire) ──────────────

/// A repository trimmed to what the worklist needs: the filter chips + the
/// repo-name label on each row. (The full `Repository` carries paths/urls the
/// worklist never renders.)
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoBrief {
    pub id: String,
    pub name: String,
}

/// Everything the worklist buckets, cross-repo, for the signed-in user.
///
/// The frontend derives every row's attention state from `boards[*].subtasks`
/// (via `deriveBoardState`) + `looseAgents` (via `deriveAgentState`) layered
/// over the GLOBAL liveness stream (`phasr://task-status` → `useAllAgentLiveness()`,
/// spec §0 claim #8). So each row's `status` rides on its `Workspace` here, while
/// live `lastActivity` comes from that stream — NOT this payload (which computes
/// no state). Epic grouping is `boards` (each carries its parent + subtasks +
/// deps + contracts); single-agent rows are `looseAgents`.
// No `Clone`: `BoardState` (a field via `boards`) is not `Clone`, and the
// worklist is assembled once per query then serialized straight to the wire.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorklistState {
    /// Every repo for the user — for the filter chips + repo-name labels. A repo
    /// with no epics/agents still appears here (so its filter chip renders).
    pub repositories: Vec<RepoBrief>,
    /// Every epic (`parent`) for the user, cross-repo, each WITH its
    /// subtasks/deps/contracts (the same `BoardState` the board route renders).
    pub boards: Vec<BoardState>,
    /// `agent`/`local` workspaces NOT part of any decomposition (single-agent
    /// work) — the loose rows the worklist buckets alongside the epics' subtasks.
    pub loose_agents: Vec<Workspace>,
}

// ── error ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum WorklistCmdError {
    Store(StoreError),
    Auth(AuthError),
}

impl From<StoreError> for WorklistCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for WorklistCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl std::fmt::Display for WorklistCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for WorklistCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── command ──────────────────────────────────────────────────────────────────

/// The cross-repo attention home's single query. Owner-scoped throughout. Read
/// only: no repo lock, no store write, no sync. See the module doc for the shape
/// contract and cost.
#[tauri::command]
pub async fn list_worklist(
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<WorklistState, WorklistCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    list_worklist_inner(&current.user_id, &workspaces, &board, &repositories).await
}

// ── internals (testable without Tauri `State`) ───────────────────────────────

/// `list_worklist` minus session/State wiring, so the cross-repo join can be
/// exercised directly. Fans out over the EXISTING owner-scoped methods: list the
/// user's repos, then per repo list its top-level rows (which already exclude
/// parented `subtask` rows), partitioning parents (→ assembled boards) from loose
/// agents (`agent`/`local`).
async fn list_worklist_inner(
    user_id: &str,
    workspaces: &WorkspaceRepo,
    board: &BoardRepo,
    repositories: &RepositoryRepo,
) -> Result<WorklistState, WorklistCmdError> {
    let repos = repositories.list_for_user(user_id).await?;

    let mut repositories_out = Vec::with_capacity(repos.len());
    let mut parent_ids: Vec<String> = Vec::new();
    let mut loose_agents: Vec<Workspace> = Vec::new();

    for repo in &repos {
        repositories_out.push(RepoBrief {
            id: repo.id.clone(),
            name: repo.name.clone(),
        });
        // Top-level rows only (the `parent_id IS NULL` filter excludes every
        // `subtask`), AND owner-scoped — a subtask is reached only through its
        // parent's board below, never as a stray loose row.
        let top = workspaces
            .list_by_repository_for_user(&repo.id, user_id)
            .await?;
        for ws in top {
            match ws.workspace_kind {
                // Each parent (epic container) is assembled into a full board.
                WorkspaceKind::Parent => parent_ids.push(ws.id),
                // Single-agent work: a standalone agent, or the always-present
                // `local` row. The frozen §C.3 contract includes both — the FE's
                // derivation decides how to bucket/hide a `local`.
                WorkspaceKind::Agent | WorkspaceKind::Local => loose_agents.push(ws),
                // Unreachable (the `parent_id IS NULL` filter drops subtasks);
                // matched exhaustively so a new kind can't silently slip through.
                WorkspaceKind::Subtask => {}
            }
        }
    }

    // Assemble each epic's board owner-scoped: parent + subtasks + edges +
    // contracts. Same shape the board route returns, so the worklist reuses the
    // exact `deriveBoardState` the board does.
    let mut boards = Vec::with_capacity(parent_ids.len());
    for parent_id in parent_ids {
        let assembled = board
            .get_board_for_user(workspaces, &parent_id, user_id)
            .await?;
        boards.push(assembled.into());
    }

    Ok(WorklistState {
        repositories: repositories_out,
        boards,
        loose_agents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, Workspace, WorkspaceDependency};
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

    async fn fresh() -> (WorkspaceRepo, BoardRepo, RepositoryRepo, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("test.sqlite")).await.unwrap();
        let repos = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        seed_user(&pool, "user-a").await;
        seed_user(&pool, "user-b").await;
        (workspaces, board, repos, dir)
    }

    /// Insert an owner-stamped repo and return it.
    async fn repo_for(repos: &RepositoryRepo, name: &str, uid: &str) -> Repository {
        let r = Repository::new(name.into(), None, None);
        repos.insert_for_user(&r, uid).await.unwrap();
        r
    }

    /// Insert a parent + two subtasks + one edge (backend → frontend) under
    /// `repo`, owned by `uid`. Returns the parent id.
    async fn seed_epic(
        workspaces: &WorkspaceRepo,
        board: &BoardRepo,
        repo: &Repository,
        uid: &str,
    ) -> String {
        let mut parent = Workspace::new(repo.id.clone(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;

        let mut backend = Workspace::new(repo.id.clone(), "backend".into(), "claude".into());
        backend.workspace_kind = WorkspaceKind::Subtask;
        backend.parent_id = Some(parent.id.clone());
        backend.role = Some("backend".into());

        let mut frontend = Workspace::new(repo.id.clone(), "frontend".into(), "claude".into());
        frontend.workspace_kind = WorkspaceKind::Subtask;
        frontend.parent_id = Some(parent.id.clone());
        frontend.role = Some("frontend".into());

        let edge =
            WorkspaceDependency::new(parent.id.clone(), backend.id.clone(), frontend.id.clone());
        board
            .create_decomposition(
                &parent,
                &[backend, frontend],
                std::slice::from_ref(&edge),
                Some(uid),
            )
            .await
            .unwrap();
        parent.id
    }

    // T6: one call aggregates every repo, every epic board (with subtasks +
    // edges), and the loose agent/local rows — while subtasks stay INSIDE their
    // board and never leak into `looseAgents`.
    #[tokio::test]
    async fn worklist_aggregates_repos_boards_and_loose_agents() {
        let (workspaces, board, repos, _dir) = fresh().await;

        // repo1: an epic (parent + 2 subtasks) + a standalone agent + a local.
        let repo1 = repo_for(&repos, "repo-1", "user-a").await;
        let parent_id = seed_epic(&workspaces, &board, &repo1, "user-a").await;
        let agent = Workspace::new(repo1.id.clone(), "solo agent".into(), "cmd".into());
        workspaces.insert_for_user(&agent, "user-a").await.unwrap();
        let mut local = Workspace::new(repo1.id.clone(), "local".into(), String::new());
        local.workspace_kind = WorkspaceKind::Local;
        workspaces.insert_for_user(&local, "user-a").await.unwrap();

        // repo2: no epics/agents at all — still surfaces as a filter chip.
        let repo2 = repo_for(&repos, "repo-2", "user-a").await;

        let state = list_worklist_inner("user-a", &workspaces, &board, &repos)
            .await
            .unwrap();

        // Both repos surface (even the empty one).
        let repo_ids: Vec<_> = state.repositories.iter().map(|r| r.id.clone()).collect();
        assert!(repo_ids.contains(&repo1.id) && repo_ids.contains(&repo2.id));
        assert_eq!(state.repositories.len(), 2);

        // Exactly one board, assembled with its 2 subtasks + 1 edge.
        assert_eq!(state.boards.len(), 1);
        assert_eq!(state.boards[0].parent.id, parent_id);
        assert_eq!(state.boards[0].subtasks.len(), 2);
        assert_eq!(state.boards[0].dependencies.len(), 1);

        // Loose agents = the standalone agent + the local; the parent and the two
        // subtasks are NOT here (they live inside the board).
        let loose_ids: Vec<_> = state.loose_agents.iter().map(|w| w.id.clone()).collect();
        assert!(loose_ids.contains(&agent.id), "the standalone agent is loose");
        assert!(loose_ids.contains(&local.id), "the local row is loose");
        assert!(
            !loose_ids.contains(&parent_id),
            "the epic parent must never appear as a loose agent"
        );
        for subtask in &state.boards[0].subtasks {
            assert!(
                !loose_ids.contains(&subtask.id),
                "a subtask must never leak into looseAgents — it belongs to its board"
            );
        }
    }

    // T6 / owner-scoping (#EXPORT_CRITICAL): a different signed-in account can
    // never see another user's repos, boards, or loose agents.
    #[tokio::test]
    async fn worklist_is_scoped_to_the_signed_in_user() {
        let (workspaces, board, repos, _dir) = fresh().await;

        // user-a owns a repo with an epic + a loose agent.
        let repo_a = repo_for(&repos, "a-repo", "user-a").await;
        seed_epic(&workspaces, &board, &repo_a, "user-a").await;
        let agent_a = Workspace::new(repo_a.id.clone(), "a agent".into(), "cmd".into());
        workspaces.insert_for_user(&agent_a, "user-a").await.unwrap();

        // user-b owns a separate repo with its own agent.
        let repo_b = repo_for(&repos, "b-repo", "user-b").await;
        let agent_b = Workspace::new(repo_b.id.clone(), "b agent".into(), "cmd".into());
        workspaces.insert_for_user(&agent_b, "user-b").await.unwrap();

        // user-b sees only its own repo + agent, none of user-a's.
        let b_state = list_worklist_inner("user-b", &workspaces, &board, &repos)
            .await
            .unwrap();
        assert_eq!(b_state.repositories.len(), 1);
        assert_eq!(b_state.repositories[0].id, repo_b.id);
        assert!(b_state.boards.is_empty(), "user-b has no epics");
        let b_loose: Vec<_> = b_state.loose_agents.iter().map(|w| w.id.clone()).collect();
        assert_eq!(b_loose, vec![agent_b.id.clone()]);

        // …and symmetrically, user-a never sees user-b's repo/agent.
        let a_state = list_worklist_inner("user-a", &workspaces, &board, &repos)
            .await
            .unwrap();
        let a_repo_ids: Vec<_> = a_state.repositories.iter().map(|r| r.id.clone()).collect();
        assert!(a_repo_ids.contains(&repo_a.id) && !a_repo_ids.contains(&repo_b.id));
        assert_eq!(a_state.boards.len(), 1);
        let a_loose: Vec<_> = a_state.loose_agents.iter().map(|w| w.id.clone()).collect();
        assert!(a_loose.contains(&agent_a.id) && !a_loose.contains(&agent_b.id));
    }

    // T6: the empty case drives the first-run CTA — a user with no repos gets a
    // fully-empty worklist, never an error.
    #[tokio::test]
    async fn worklist_is_empty_when_the_user_has_no_repos() {
        let (workspaces, board, repos, _dir) = fresh().await;
        let state = list_worklist_inner("user-a", &workspaces, &board, &repos)
            .await
            .unwrap();
        assert!(state.repositories.is_empty());
        assert!(state.boards.is_empty());
        assert!(state.loose_agents.is_empty());
    }

    // Pins the FROZEN §C.3 wire shape the fe-developer already built `types.ts`
    // to: camelCase top-level keys (`repositories`/`boards`/`looseAgents`) and a
    // `RepoBrief` of exactly `{ id, name }`. A drift here breaks the worklist.
    #[tokio::test]
    async fn wire_shape_matches_the_frozen_contract() {
        let (workspaces, board, repos, _dir) = fresh().await;
        let repo = repo_for(&repos, "repo", "user-a").await;
        let agent = Workspace::new(repo.id.clone(), "solo".into(), "cmd".into());
        workspaces.insert_for_user(&agent, "user-a").await.unwrap();

        let state = list_worklist_inner("user-a", &workspaces, &board, &repos)
            .await
            .unwrap();
        let json = serde_json::to_value(&state).unwrap();
        assert!(json["repositories"].is_array());
        assert!(json["boards"].is_array());
        assert!(json["looseAgents"].is_array(), "looseAgents must be camelCase");
        // RepoBrief is exactly { id, name }.
        assert_eq!(json["repositories"][0]["id"], repo.id.as_str());
        assert_eq!(json["repositories"][0]["name"], "repo");
    }
}
