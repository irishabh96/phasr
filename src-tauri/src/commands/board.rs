//! Task-board command surface (multi-agent decomposition, P0 slice).
//!
//! Two thin `#[tauri::command]` handlers:
//!   - `start_decomposition` — the B2 approval gate. Atomically writes a
//!     `parent` + its `subtask` rows + the dependency edge(s) and returns the
//!     assembled `BoardState`. It does NOT spawn any agent: the gate only
//!     creates the DAG; the scheduler (Chunk 3) spawns ready subtasks later.
//!   - `get_board` — reads one parent's board back, owner-scoped.
//!
//! Both delegate straight down to `BoardRepo` + `WorkspaceRepo`; board/DAG
//! state stays OUT of `WorkspaceStatus` (spec claim #10) — "blocked" is derived
//! frontend-side from edges × contracts, never stored.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::{Agent, Workspace, WorkspaceContract, WorkspaceDependency, WorkspaceKind};
use crate::git::{self, FileChange, GitError, MergeOutcome, MergeStrategy};
use crate::orchestrator::{contract_file_is_ready, RepoLockRegistry, SchedulerConfig};
use crate::store::{Board, BoardRepo, RepositoryRepo, StoreError, WorkspaceRepo, WorkspaceUpdate};
use crate::sync::CloudSyncState;

// ── request / response shapes (the frozen §C wire contract) ─────────────────

/// The approved decomposition plan. The draft lives entirely in the frontend
/// form until "Start N agents"; nothing is persisted before this call (B2).
/// Topology is supplied generically (N subtasks, M edges) — the store + gate
/// are written generically and only exercised on the fixed `backend → frontend`
/// PoC shape (spec §G). NOTE: no `parentId` field — the parent id is minted
/// server-side per call (see the dedup note on `start_decomposition`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecompositionInput {
    pub repository_id: String,
    pub parent_prompt: String,
    pub subtasks: Vec<SubtaskInput>,
    pub edges: Vec<EdgeInput>,
}

/// One planned subtask: its DAG slot (`role`, also the dedup key with
/// `parent_id`), the agent to run, and its seed prompt.
///
/// `Serialize` as well as `Deserialize`: the planner (`plan_decomposition`)
/// returns these to the frontend inside a `ProposedPlan`, so the same struct
/// travels the wire in BOTH directions (`{ role, agent, prompt }`, camelCase).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskInput {
    pub role: String,
    pub agent: Agent,
    pub prompt: String,
}

/// One directed edge, addressed by role. Resolved to concrete subtask ids at
/// write time. `Serialize` for the same reason as `SubtaskInput` — the planner
/// returns edges in a `ProposedPlan` (`{ fromRole, toRole }`, camelCase).
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeInput {
    pub from_role: String,
    pub to_role: String,
}

/// Everything the board route renders. A command-layer DTO over `store::Board`;
/// its fields are domain types that already serialize camelCase. `contracts`
/// carries `publishedAt`, which drives the frontend "blocked" derivation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardState {
    pub parent: Workspace,
    pub subtasks: Vec<Workspace>,
    pub dependencies: Vec<WorkspaceDependency>,
    pub contracts: Vec<WorkspaceContract>,
}

impl From<Board> for BoardState {
    fn from(board: Board) -> Self {
        Self {
            parent: board.parent,
            subtasks: board.subtasks,
            dependencies: board.dependencies,
            contracts: board.contracts,
        }
    }
}

// ── error ───────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum BoardCmdError {
    Store(StoreError),
    Auth(AuthError),
    /// A git op failed while building the integration worktree or merging a
    /// subtask branch (`integrate_parent`). Serialized to the git error string.
    Git(GitError),
    /// A filesystem op failed while writing the manual "mark done" contract file
    /// (`publish_contract`).
    Io(std::io::Error),
    /// A malformed plan (empty, over the `MAX_SUBTASKS` cap, duplicate roles, an
    /// edge referencing an unknown role, a self-edge, or a dependency cycle). The
    /// gate rejects all of these up front (`validate_decomposition`); a clear
    /// error beats silently persisting a broken DAG the scheduler could deadlock
    /// on.
    InvalidDecomposition(String),
    /// `publish_contract` was called on a row that isn't a decomposition subtask
    /// (no `parent_id`/`role`) — nothing to publish a handoff contract for.
    NotASubtask(String),
    /// Integration stopped on a merge conflict (E3-T1). NOT a failure of the
    /// command so much as a signal: the integration worktree is left mid-merge
    /// and the parent row already points at it, so the frontend drives the
    /// EXISTING interactive conflict flow (`git_merge_in_progress` /
    /// `git_resolve_conflict` / `git_continue_merge` / `git_abort_merge`) keyed
    /// on the parent `workspace_id` (spec claim #6). The conflicting files ride
    /// the serialized error string so the UI can name them.
    IntegrationConflict { files: Vec<String> },
}

impl From<StoreError> for BoardCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for BoardCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<GitError> for BoardCmdError {
    fn from(e: GitError) -> Self {
        Self::Git(e)
    }
}

impl From<std::io::Error> for BoardCmdError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

impl std::fmt::Display for BoardCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::Git(e) => write!(f, "{e}"),
            Self::Io(e) => write!(f, "{e}"),
            Self::InvalidDecomposition(msg) => write!(f, "invalid decomposition: {msg}"),
            Self::NotASubtask(msg) => write!(f, "{msg}"),
            Self::IntegrationConflict { files } => {
                write!(f, "integration stopped on conflicts in: {}", files.join(", "))
            }
        }
    }
}

impl serde::Serialize for BoardCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

/// The B2 approval gate. Atomically persists a `parent` + its `subtask` rows +
/// the dependency edge(s) under the per-repo lock, then returns the board.
/// **Spawns nothing** — the scheduler (Chunk 3) mints worktrees/PTYs for ready
/// subtasks on its own tick, which is what decouples the gate from fan-out.
///
/// Dedup: `DecompositionInput` carries no `parentId`, so a re-submit mints a
/// FRESH independent parent (mirrors `start_task`'s "a deliberate re-run makes
/// fresh state"). There is no stable server-side key to dedup two submissions
/// against — `find_active_subtask(parent_id, role)` (Chunk 1) is the
/// scheduler's duplicate-tick guard where the parent id IS stable, not a gate
/// guard. The frontend's submit-button re-entrancy guard (the same D1 client
/// guard `start_task` relies on) is the accidental-double-click defense. What
/// the gate DOES enforce is well-formedness (`validate_decomposition`): a
/// malformed plan is a clear `InvalidDecomposition`, never a broken DAG.
#[tauri::command]
pub async fn start_decomposition(
    input: DecompositionInput,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<BoardState, BoardCmdError> {
    // Owner-scoped: parent + subtasks are stamped with this user so the board
    // can only ever be read back by the same account (`_for_user`).
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;

    // Serialize the atomic create against the shared per-repo lock, mirroring
    // start_task, so a concurrent create/start/delete on this repo can't
    // interleave with the parent+subtask+edge write. (The write is itself a
    // single DB transaction, so the lock is about ordering vs. OTHER repo
    // git/DB mutations, not intra-write atomicity.)
    let lock = repo_locks.for_repository(&input.repository_id);
    let guard = lock.lock().await;
    let assembled = create_decomposition_inner(&input, &current.user_id, &workspaces, &board).await;
    drop(guard);

    let assembled = assembled?;

    // The `workspaces` table is syncable, so honor the request-sync convention.
    // Parent/subtask rows are auto-excluded from the `workspace_kind = 'agent'`
    // push filter (spec claim #11), so this is a no-op for the board and keeps
    // it machine-local by construction — but we stay consistent with the sibling
    // workspace-mutating commands (create_workspace / start_task).
    sync_state.request_sync();

    Ok(assembled.into())
}

/// Read one parent's board back, owner-scoped. Thin wrapper over
/// `BoardRepo::get_board_for_user`.
#[tauri::command]
pub async fn get_board(
    parent_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<BoardState, BoardCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let assembled = board
        .get_board_for_user(&workspaces, &parent_id, &current.user_id)
        .await?;
    Ok(assembled.into())
}

/// The manual "mark done / publish" override (E2-T4). Publishes one subtask's
/// handoff contract — writing the contract FILE if the agent never did, then
/// stamping a `published_at` on its `workspace_contracts` row — so a forgetful
/// agent or a stuck edge is never a silent dead end (spec §8 risk / F-7). The
/// dependent unblocks on the scheduler's NEXT tick (its `ready_subtask_ids`
/// derivation keys off exactly this published row). Also the deterministic test
/// hook the scheduler tests reference. Returns the refreshed board so the
/// frontend re-renders without a follow-up `get_board`.
#[tauri::command]
pub async fn publish_contract(
    subtask_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<BoardState, BoardCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    // Production writes to the real `~/.phasr/tasks/<parent>/contracts/<role>.md`
    // — the SAME path `SchedulerConfig` polls, so the poller sees this override's
    // file and the two never disagree on location. Tests inject a tempdir root.
    let config = SchedulerConfig::default();
    let assembled =
        publish_contract_inner(&subtask_id, &current.user_id, &workspaces, &board, &config).await?;

    // The `workspaces`/contract rows are board-machine-local (auto-excluded from
    // the `workspace_kind='agent'` push filter, spec claim #11), so this is a
    // no-op for the cloud — but we stay consistent with the sibling mutating
    // board command (`start_decomposition`).
    sync_state.request_sync();
    Ok(assembled.into())
}

/// Integrate a completed decomposition (E3-T1). Mints a DEDICATED integration
/// branch + worktree off the parent's base branch (NEVER the user's checkout —
/// `create_worktree`, not `merge_to`), records them on the PARENT row's existing
/// `branch`/`worktree_path` (spec B1, no separate column), then merges each
/// completed subtask's branch into it in TOPOLOGICAL order (producers before
/// consumers) via `merge_into` under the per-repo lock.
///
/// A clean run returns the refreshed `BoardState`: the parent now carries the
/// integration `branch`/`worktreePath`, so the frontend reviews ONE combined
/// diff (existing `git_diff`/`git_status` against the parent id) and can merge to
/// main (existing `git_merge_to_main`). The FIRST conflict STOPS the merge and
/// returns `IntegrationConflict` — the worktree is left mid-merge and the parent
/// row already points at it, so the existing interactive conflict flow resolves
/// against the parent `workspace_id` with zero new commands (spec claim #6).
#[tauri::command]
pub async fn integrate_parent(
    parent_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    board: State<'_, BoardRepo>,
    repositories: State<'_, RepositoryRepo>,
    repo_locks: State<'_, Arc<RepoLockRegistry>>,
    session: State<'_, Arc<SessionState>>,
    sync_state: State<'_, Arc<CloudSyncState>>,
) -> Result<BoardState, BoardCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let assembled = integrate_parent_inner(
        &parent_id,
        &current.user_id,
        &workspaces,
        &board,
        &repositories,
        &repo_locks,
    )
    .await?;

    // The parent row's branch/worktree_path just changed; keep the sibling
    // convention even though board rows never push (spec claim #11).
    sync_state.request_sync();
    Ok(assembled.into())
}

/// The combined file LIST for the "Integration review" (P0-1). After a CLEAN
/// `integrate_parent`, every subtask merge is already committed, so the parent
/// integration worktree is CLEAN — the worktree-based `git_status` returns
/// nothing and the review would render empty. This reads the integration BRANCH
/// vs its base instead (three-dot `base...branch`), so the review shows exactly
/// what the agents produced regardless of the worktree being committed.
///
/// The "status" half of a `git_status`/`git_diff`-style pairing: this returns
/// the `Vec<FileChange>` (same shape as `git_status`); `board_integration_file_diff`
/// returns the per-file unified diff (same shape as `git_diff`). The frontend
/// points the clean-case review at this pair to reuse its existing diff
/// components. The CONFLICT case keeps the worktree `ChangesPanel` surface (a
/// mid-merge worktree correctly carries the conflict markers), so it does NOT
/// use this command. Read-only: no repo lock, no store write, no sync.
#[tauri::command]
pub async fn board_integration_diff(
    parent_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Vec<FileChange>, BoardCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let (worktree, base, branch) =
        resolve_integration_range(&parent_id, &current.user_id, &workspaces, &repositories).await?;
    // Off the blocking pool: a whole-integration diff can be large, and blocking
    // a Tokio worker for the subprocess's full duration starves unrelated IPC
    // (terminal input, sync) — the same reason `commands::git::blocking_git`
    // exists. This read holds no lock (unlike `integrate_parent`'s merges).
    blocking_board_git(move || git::diff_branch_range_status(&worktree, &base, &branch)).await
}

/// The per-file unified diff for the "Integration review" (P0-1) — the "diff"
/// half paired with `board_integration_diff`'s file list (mirrors how `git_diff`
/// pairs with `git_status`). Same `base...branch` three-dot range, scoped to one
/// `path`. Returns the raw unified-diff string the frontend's `DiffView` already
/// renders; truncates past the 16 MiB cap via the shared `capture_stdout`.
#[tauri::command]
pub async fn board_integration_file_diff(
    parent_id: String,
    path: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<String, BoardCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let (worktree, base, branch) =
        resolve_integration_range(&parent_id, &current.user_id, &workspaces, &repositories).await?;
    blocking_board_git(move || git::diff_branch_range(&worktree, &base, &branch, Some(&path))).await
}

// ── internals (testable without Tauri `State`) ──────────────────────────────

/// Run a synchronous git op off the async runtime, mapping failures into
/// `BoardCmdError::Git`. Mirrors `commands::git::blocking_git` (which returns the
/// git-command error type) but for the board's aggregate error. Used by the
/// read-only integration-diff commands, which hold no repo lock — so there is no
/// tokio guard held across the `spawn_blocking` await.
async fn blocking_board_git<T, F>(f: F) -> Result<T, BoardCmdError>
where
    F: FnOnce() -> Result<T, GitError> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        // A JoinError only happens if the blocking task panicked; surface it as a
        // git failure rather than silently dropping the command.
        .map_err(|e| BoardCmdError::Git(GitError::CommandFailed(format!("git task failed: {e}"))))?
        .map_err(BoardCmdError::Git)
}

/// Resolve the `(integration worktree, base branch, integration branch)` triple
/// for the integration review, owner-scoped. Shared by both integration-diff
/// commands. `base` is the repository's default branch (the divergence point
/// `integrate_parent` branched the integration branch off of); `branch` +
/// `worktree` are what `integrate_parent` stamped onto the parent row. Errors if
/// the parent hasn't been integrated yet (no branch/worktree) — the review is
/// only meaningful after a run populated them.
async fn resolve_integration_range(
    parent_id: &str,
    user_id: &str,
    workspaces: &WorkspaceRepo,
    repositories: &RepositoryRepo,
) -> Result<(PathBuf, String, String), BoardCmdError> {
    let parent = workspaces.get_for_user(parent_id, user_id).await?;
    let branch = parent.branch.clone().ok_or_else(|| {
        BoardCmdError::Git(GitError::CommandFailed(
            "parent has no integration branch yet — integrate first".into(),
        ))
    })?;
    let worktree = parent
        .worktree_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| {
            BoardCmdError::Git(GitError::CommandFailed(
                "parent has no integration worktree yet — integrate first".into(),
            ))
        })?;
    // Not owner-scoped: the repository row is fetched by the (already
    // owner-scoped) parent's repository_id, mirroring `integrate_parent_inner`.
    let repository = repositories.get(&parent.repository_id).await?;
    let base = repository.default_branch.clone();
    Ok((worktree, base, branch))
}

/// The gate's orchestration, minus session/lock/sync wiring, so it can be
/// exercised directly against real repos in tests. Validates, builds the rows,
/// writes them atomically, and reads the board back owner-scoped.
async fn create_decomposition_inner(
    input: &DecompositionInput,
    user_id: &str,
    workspaces: &WorkspaceRepo,
    board: &BoardRepo,
) -> Result<Board, BoardCmdError> {
    // Reject a malformed plan BEFORE any write, so nothing is persisted for a
    // bad input (the "no orphan rows" AC holds for invalid plans too). The SAME
    // validator the planner runs, so the gate and the planner never disagree.
    validate_decomposition(&input.subtasks, &input.edges)?;

    // 1. Parent = the integration container: kind=Parent, status=Pending
    //    (Workspace::new default), NO agent, NO branch/worktree, NO PTY. It
    //    gets a branch/worktree only at integration (Chunk 4, spec B1).
    let mut parent = Workspace::new(
        input.repository_id.clone(),
        parent_title(&input.parent_prompt),
        String::new(),
    );
    parent.workspace_kind = WorkspaceKind::Parent;
    parent.prompt = non_empty_prompt(&input.parent_prompt);

    // 2. Subtasks = real agents, but NOT spawned here (the scheduler does that
    //    in Chunk 3). kind=Subtask, status=Pending, parent_id + role + agent
    //    set. No branch/worktree yet — minting those is the scheduler's job.
    let mut subtasks = Vec::with_capacity(input.subtasks.len());
    let mut role_to_id: HashMap<&str, String> = HashMap::new();
    for planned in &input.subtasks {
        let mut subtask = Workspace::new(
            input.repository_id.clone(),
            planned.role.clone(),
            planned.agent.command().to_string(),
        );
        subtask.workspace_kind = WorkspaceKind::Subtask;
        subtask.parent_id = Some(parent.id.clone());
        subtask.role = Some(planned.role.clone());
        subtask.agent = Some(planned.agent);
        subtask.prompt = non_empty_prompt(&planned.prompt);
        role_to_id.insert(planned.role.as_str(), subtask.id.clone());
        subtasks.push(subtask);
    }

    // 3. Edges resolve role → freshly-minted subtask id (validated present
    //    above; the `ok_or_else` keeps this panic-free rather than `expect`).
    let mut dependencies = Vec::with_capacity(input.edges.len());
    for edge in &input.edges {
        let from = role_to_id
            .get(edge.from_role.as_str())
            .cloned()
            .ok_or_else(|| {
                BoardCmdError::InvalidDecomposition(format!(
                    "edge references unknown from-role `{}`",
                    edge.from_role
                ))
            })?;
        let to = role_to_id
            .get(edge.to_role.as_str())
            .cloned()
            .ok_or_else(|| {
                BoardCmdError::InvalidDecomposition(format!(
                    "edge references unknown to-role `{}`",
                    edge.to_role
                ))
            })?;
        dependencies.push(WorkspaceDependency::new(parent.id.clone(), from, to));
    }

    // 4. Atomic write — parent + subtasks + edges in one transaction. NO spawn.
    board
        .create_decomposition(&parent, &subtasks, &dependencies, Some(user_id))
        .await?;

    // Return the assembled board, owner-scoped, so the caller renders the same
    // shape `get_board` returns.
    Ok(board.get_board_for_user(workspaces, &parent.id, user_id).await?)
}

/// The most subtasks a single decomposition may contain (D-OQ1). A sane board
/// size that rejects a runaway plan (edges are implicitly bounded by the roles).
/// Shared by the gate AND the planner (`orchestrator::planner`), which embeds it
/// in the LLM output contract, so both agree on the ceiling.
pub(crate) const MAX_SUBTASKS: usize = 12;

/// Well-formedness check for the decomposition DAG. Enforces role uniqueness
/// (the `(parent_id, role)` invariant, checked in-memory because the gate mints
/// a fresh parent id so a DB `find_active_subtask` lookup can't help), a size cap
/// (`MAX_SUBTASKS`), edge referential integrity, no self-edges, and — the piece
/// that closes the deadlock gap — **no dependency cycle**. Kept generic (no
/// hardcoded backend/frontend topology) per spec §G.
///
/// Takes borrowed slices rather than a `&DecompositionInput` so the SAME
/// validator guards both entry points: the gate (`create_decomposition_inner`,
/// via `&input.subtasks`/`&input.edges`) and the planner (which validates the
/// LLM-proposed `{subtasks, edges}` before returning them). One validator, no
/// drift between "what the planner accepts" and "what the gate accepts".
pub(crate) fn validate_decomposition(
    subtasks: &[SubtaskInput],
    edges: &[EdgeInput],
) -> Result<(), BoardCmdError> {
    if subtasks.is_empty() {
        return Err(BoardCmdError::InvalidDecomposition(
            "a decomposition needs at least one subtask".into(),
        ));
    }
    if subtasks.len() > MAX_SUBTASKS {
        return Err(BoardCmdError::InvalidDecomposition(format!(
            "a decomposition can have at most {MAX_SUBTASKS} subtasks (got {})",
            subtasks.len()
        )));
    }
    let mut roles = HashSet::new();
    for subtask in subtasks {
        if subtask.role.trim().is_empty() {
            return Err(BoardCmdError::InvalidDecomposition(
                "every subtask needs a non-empty role".into(),
            ));
        }
        if !roles.insert(subtask.role.as_str()) {
            return Err(BoardCmdError::InvalidDecomposition(format!(
                "duplicate subtask role `{}`",
                subtask.role
            )));
        }
    }
    for edge in edges {
        if edge.from_role == edge.to_role {
            return Err(BoardCmdError::InvalidDecomposition(format!(
                "self-edge on role `{}`",
                edge.from_role
            )));
        }
        if !roles.contains(edge.from_role.as_str()) {
            return Err(BoardCmdError::InvalidDecomposition(format!(
                "edge references unknown from-role `{}`",
                edge.from_role
            )));
        }
        if !roles.contains(edge.to_role.as_str()) {
            return Err(BoardCmdError::InvalidDecomposition(format!(
                "edge references unknown to-role `{}`",
                edge.to_role
            )));
        }
    }

    // Role-keyed Kahn cycle check. Roles are unique and every edge is referential
    // by this point, so the indegree map is built straight over role strings —
    // structurally identical to the id-keyed `topological_subtask_order`, but run
    // HERE at the gate so a cyclic plan is rejected before any row is written
    // (never a DAG the scheduler could deadlock on, claim #1). The id-keyed sort
    // stays as integration-time defense-in-depth.
    let mut indegree: HashMap<&str, usize> =
        subtasks.iter().map(|s| (s.role.as_str(), 0usize)).collect();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in edges {
        adjacency
            .entry(edge.from_role.as_str())
            .or_default()
            .push(edge.to_role.as_str());
        if let Some(d) = indegree.get_mut(edge.to_role.as_str()) {
            *d += 1;
        }
    }
    let mut queue: VecDeque<&str> = subtasks
        .iter()
        .map(|s| s.role.as_str())
        .filter(|role| indegree.get(*role).copied().unwrap_or(0) == 0)
        .collect();
    let mut visited = 0usize;
    while let Some(role) = queue.pop_front() {
        visited += 1;
        if let Some(children) = adjacency.get(role) {
            for &child in children {
                if let Some(d) = indegree.get_mut(child) {
                    *d -= 1;
                    if *d == 0 {
                        queue.push_back(child);
                    }
                }
            }
        }
    }
    if visited != subtasks.len() {
        return Err(BoardCmdError::InvalidDecomposition(
            "dependency cycle detected among subtasks".into(),
        ));
    }

    Ok(())
}

/// A short, display-only title for the parent card, from the first non-empty
/// line of the approved prompt (truncated). The parent is an integration
/// container with no agent of its own, so its `name` is never a dedup key.
fn parent_title(parent_prompt: &str) -> String {
    let line = parent_prompt
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Decomposition");
    let title: String = line.chars().take(80).collect();
    if title.is_empty() {
        "Decomposition".to_string()
    } else {
        title
    }
}

/// A blank prompt stores as NULL, matching how `create_workspace` treats "no
/// prompt" — an empty string and absence shouldn't differ on the wire.
fn non_empty_prompt(prompt: &str) -> Option<String> {
    if prompt.trim().is_empty() {
        None
    } else {
        Some(prompt.to_string())
    }
}

/// `publish_contract`'s orchestration, minus session/sync wiring, so it can be
/// exercised directly against real repos + a tempdir contract root in tests
/// (the production command uses `SchedulerConfig::default()` = the real
/// `~/.phasr/tasks`). Owner-scoped: reads the subtask through `get_for_user` so
/// one account can never publish another's subtask.
async fn publish_contract_inner(
    subtask_id: &str,
    user_id: &str,
    workspaces: &WorkspaceRepo,
    board: &BoardRepo,
    config: &SchedulerConfig,
) -> Result<Board, BoardCmdError> {
    let subtask = workspaces.get_for_user(subtask_id, user_id).await?;
    // A handoff contract only makes sense for a decomposition subtask (it needs a
    // parent to belong to and a role to name the file). A standalone agent/parent
    // has neither.
    let (Some(parent_id), Some(role)) = (subtask.parent_id.clone(), subtask.role.clone()) else {
        return Err(BoardCmdError::NotASubtask(format!(
            "workspace `{subtask_id}` is not a decomposition subtask"
        )));
    };

    // 1. Ensure the contract FILE exists (the agent may never have written it —
    //    that is the whole point of the override). Only write a stub if the file
    //    is missing/empty; a real agent-authored contract is left untouched so
    //    the consumer seeds against the genuine interface, not our placeholder.
    //    tmp-then-rename so the scheduler's poller never reads a half-written file
    //    (spec §F-2 atomic-write hardening).
    let path = config.contract_file(&parent_id, &role);
    if !contract_file_is_ready(&path, config.min_contract_bytes) {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("md.tmp");
        std::fs::write(&tmp, marked_done_contract(&role, subtask.branch.as_deref()))?;
        std::fs::rename(&tmp, &path)?;
    }

    // 2. Stamp a PUBLISHED `workspace_contracts` row directly (don't wait for the
    //    poller). Idempotent, mirroring the scheduler's file→DB bridge: publish
    //    an existing unpublished row, no-op an already-published one, else insert.
    let now = chrono::Utc::now();
    match board.find_contract(subtask_id).await? {
        Some(existing) if existing.published_at.is_some() => {}
        Some(existing) => board.mark_contract_published(&existing.id, now).await?,
        None => {
            let mut contract = WorkspaceContract::new(
                parent_id.clone(),
                subtask_id.to_string(),
                role,
                path.to_string_lossy().into_owned(),
            );
            contract.published_at = Some(now);
            board.insert_contract(&contract).await?;
        }
    }

    Ok(board.get_board_for_user(workspaces, &parent_id, user_id).await?)
}

/// A minimal freeform-Markdown stub written when the user marks a subtask done
/// but its agent never authored a contract. Freeform per spec §F-2 — the
/// "contract" is a handoff note, not a structured schema (that is P1).
fn marked_done_contract(role: &str, branch: Option<&str>) -> String {
    let branch_line = branch
        .map(|b| format!("Its work is on branch `{b}`.\n"))
        .unwrap_or_default();
    format!(
        "# {role} contract\n\nMarked done via the phasr board (no agent-authored \
         contract was found).\n{branch_line}",
    )
}

/// `integrate_parent`'s orchestration, minus session/sync wiring, so it can be
/// driven directly against a real git repo + real subtask branches in tests.
/// Owner-scoped throughout (`get_for_user` / `list_by_parent_for_user`).
async fn integrate_parent_inner(
    parent_id: &str,
    user_id: &str,
    workspaces: &WorkspaceRepo,
    board: &BoardRepo,
    repositories: &RepositoryRepo,
    repo_locks: &RepoLockRegistry,
) -> Result<Board, BoardCmdError> {
    let parent = workspaces.get_for_user(parent_id, user_id).await?;
    let subtasks = workspaces
        .list_by_parent_for_user(parent_id, user_id)
        .await?;
    let deps = board.list_dependencies(parent_id).await?;

    let repository = repositories.get(&parent.repository_id).await?;
    let repo_path = repository
        .local_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or_else(|| {
            BoardCmdError::Git(GitError::CommandFailed("repository has no local path".into()))
        })?;
    let base_ref = repository.default_branch.clone();

    // Topologically order the subtasks so producers merge before consumers, then
    // keep only those that actually produced a branch (a still-blocked/pending
    // subtask was never spawned, so it has nothing to integrate). The gate's
    // `validate_decomposition` already rejects cycles, so this sort's own cycle
    // guard is integration-time defense-in-depth (e.g. a hand-edited DB).
    let ordered = topological_subtask_order(&subtasks, &deps)?;

    // Deterministic per-parent integration branch + worktree (spec F-4):
    //   branch   `phasr/integration/<parent-slug>-<short_id>`
    //   worktree `~/.phasr/worktrees/<parent_id>`
    // The worktree lives OUTSIDE the user's checkout, so integration never
    // touches their working tree (spec B1, the merge_to-vs-merge_into distinction
    // in claim #5).
    let parent_slug = git::slugify(&parent.name);
    let short = git::short_id(&parent.id);
    let branch = git::default_branch_name(&format!("integration/{parent_slug}-{short}"), short);
    let worktree_path = git::default_worktree_base_path().join(&parent.id);

    // Everything touching the shared `.git` (worktree add, branch delete, the
    // merges) serializes against the per-repo lock — same lock start_task uses.
    let lock = repo_locks.for_repository(&parent.repository_id);
    let guard = lock.lock().await;

    // Re-integration must start from a clean base: tear down any prior
    // integration worktree/branch so "Integrate & review" always reflects the
    // CURRENT subtask branches, never a stale half-merge. Both teardown helpers
    // are idempotent (no-op when nothing exists).
    if worktree_path.exists() {
        git::remove_worktree(&repo_path, &worktree_path)?;
    }
    git::branch_delete(&repo_path, &branch)?;
    git::create_worktree(&repo_path, &worktree_path, &branch, &base_ref)?;

    // Record the integration branch/worktree on the PARENT row BEFORE merging, so
    // even a conflict leaves the parent pointing at the integration worktree —
    // that is what lets the frontend drive the conflict flow (git_merge_in_progress
    // etc.) against the parent id. `update` leaves `status` untouched (the parent
    // stays Pending — it never runs a PTY).
    workspaces
        .update(
            parent_id,
            WorkspaceUpdate {
                branch: Some(Some(branch.clone())),
                worktree_path: Some(Some(worktree_path.to_string_lossy().into_owned())),
                ..Default::default()
            },
        )
        .await?;

    // Merge each branch-bearing subtask in topological order. STOP on the first
    // conflict — the worktree is left mid-merge for the interactive resolver; we
    // never clobber or silently skip a conflict.
    for subtask in &ordered {
        let Some(source_branch) = subtask.branch.as_deref() else {
            continue;
        };
        match git::merge_into(&worktree_path, source_branch, MergeStrategy::Merge)? {
            MergeOutcome::Clean { .. } => {}
            MergeOutcome::Conflicts { files } => {
                drop(guard);
                return Err(BoardCmdError::IntegrationConflict { files });
            }
        }
    }
    drop(guard);

    // Clean integration — the parent now carries the combined branch/worktree.
    Ok(board.get_board_for_user(workspaces, parent_id, user_id).await?)
}

/// Kahn topological sort of a parent's subtasks so every producer precedes its
/// consumers (`from` before `to`). Indegree-0 nodes keep the subtasks' own
/// oldest-first order for a deterministic result. Only edges whose BOTH
/// endpoints are subtasks of this parent count (defensive against a stray edge).
/// Returns `InvalidDecomposition` if a cycle leaves nodes unvisited.
fn topological_subtask_order(
    subtasks: &[Workspace],
    deps: &[WorkspaceDependency],
) -> Result<Vec<Workspace>, BoardCmdError> {
    let ids: HashSet<&str> = subtasks.iter().map(|s| s.id.as_str()).collect();
    let mut indegree: HashMap<&str, usize> =
        subtasks.iter().map(|s| (s.id.as_str(), 0usize)).collect();
    let mut adjacency: HashMap<&str, Vec<&str>> = HashMap::new();
    for edge in deps {
        let (from, to) = (edge.from_subtask_id.as_str(), edge.to_subtask_id.as_str());
        if ids.contains(from) && ids.contains(to) {
            adjacency.entry(from).or_default().push(to);
            if let Some(d) = indegree.get_mut(to) {
                *d += 1;
            }
        }
    }

    let mut queue: VecDeque<&str> = subtasks
        .iter()
        .map(|s| s.id.as_str())
        .filter(|id| indegree[id] == 0)
        .collect();
    let mut order: Vec<&str> = Vec::with_capacity(subtasks.len());
    while let Some(node) = queue.pop_front() {
        order.push(node);
        if let Some(children) = adjacency.get(node) {
            for &child in children {
                let d = indegree.get_mut(child).expect("child is a known subtask");
                *d -= 1;
                if *d == 0 {
                    queue.push_back(child);
                }
            }
        }
    }

    if order.len() != subtasks.len() {
        return Err(BoardCmdError::InvalidDecomposition(
            "dependency cycle detected among subtasks".into(),
        ));
    }
    let by_id: HashMap<&str, &Workspace> =
        subtasks.iter().map(|s| (s.id.as_str(), s)).collect();
    Ok(order.into_iter().map(|id| by_id[id].clone()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, WorkspaceStatus};
    use crate::store::{init_pool, Db, RepositoryRepo};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// Mirror of the scheduler's edge-satisfaction rule (`ready_subtask_ids` /
    /// `edge_satisfied`): a subtask is unblocked once EVERY incoming edge's
    /// producer has a PUBLISHED contract. Kept local to the test so it doesn't
    /// pull the scheduler's internals into the command layer's public surface.
    fn is_unblocked(
        subtask_id: &str,
        deps: &[WorkspaceDependency],
        contracts: &[WorkspaceContract],
    ) -> bool {
        deps.iter()
            .filter(|e| e.to_subtask_id == subtask_id)
            .all(|e| {
                contracts
                    .iter()
                    .any(|c| c.subtask_id == e.from_subtask_id && c.published_at.is_some())
            })
    }

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

    async fn fresh() -> (WorkspaceRepo, BoardRepo, Repository) {
        let dir = tempfile::tempdir().unwrap();
        let path: PathBuf = dir.path().join("test.sqlite");
        let pool = init_pool(&path).await.unwrap();
        std::mem::forget(dir);
        let repos = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());
        let r = Repository::new("repo".into(), None, None);
        repos.insert(&r).await.unwrap();
        seed_user(&pool, "user-a").await;
        seed_user(&pool, "user-b").await;
        (workspaces, board, r)
    }

    fn sample_input(repository_id: &str) -> DecompositionInput {
        DecompositionInput {
            repository_id: repository_id.to_string(),
            parent_prompt: "Build the widget\nwith tests".into(),
            subtasks: vec![
                SubtaskInput {
                    role: "backend".into(),
                    agent: Agent::Claude,
                    prompt: "do the backend".into(),
                },
                SubtaskInput {
                    role: "frontend".into(),
                    agent: Agent::Claude,
                    prompt: "do the frontend".into(),
                },
            ],
            edges: vec![EdgeInput {
                from_role: "backend".into(),
                to_role: "frontend".into(),
            }],
        }
    }

    // E2-T1: the gate creates exactly 1 parent + 2 subtasks + 1 edge and
    // SPAWNS NOTHING — every row is Pending with no branch/worktree (so no
    // PTY), and the parent has no agent.
    #[tokio::test]
    async fn start_decomposition_creates_dag_and_spawns_nothing() {
        let (workspaces, board, repo) = fresh().await;
        let b = create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
            .await
            .unwrap();

        // Parent: kind=Parent, Pending, no agent, no branch/worktree (no PTY).
        assert_eq!(b.parent.workspace_kind, WorkspaceKind::Parent);
        assert_eq!(b.parent.status, WorkspaceStatus::Pending);
        assert!(b.parent.agent.is_none());
        assert!(
            b.parent.branch.is_none() && b.parent.worktree_path.is_none(),
            "the gate must NOT create a worktree/branch for the parent"
        );

        // Subtasks: kind=Subtask, Pending, parent_id + role set, NOTHING spawned.
        assert_eq!(b.subtasks.len(), 2);
        for subtask in &b.subtasks {
            assert_eq!(subtask.workspace_kind, WorkspaceKind::Subtask);
            assert_eq!(subtask.status, WorkspaceStatus::Pending);
            assert_eq!(subtask.parent_id.as_deref(), Some(b.parent.id.as_str()));
            assert!(subtask.role.is_some());
            assert!(
                subtask.branch.is_none() && subtask.worktree_path.is_none(),
                "the gate must NOT spawn a subtask worktree/PTY"
            );
        }

        // Exactly one edge backend -> frontend, resolved to the real ids.
        let backend = b
            .subtasks
            .iter()
            .find(|s| s.role.as_deref() == Some("backend"))
            .unwrap();
        let frontend = b
            .subtasks
            .iter()
            .find(|s| s.role.as_deref() == Some("frontend"))
            .unwrap();
        assert_eq!(b.dependencies.len(), 1);
        assert_eq!(b.dependencies[0].from_subtask_id, backend.id);
        assert_eq!(b.dependencies[0].to_subtask_id, frontend.id);

        // Nothing published yet.
        assert!(b.contracts.is_empty());
    }

    // `get_board`'s read path returns the same board the gate just wrote.
    #[tokio::test]
    async fn get_board_reads_back_the_created_decomposition() {
        let (workspaces, board, repo) = fresh().await;
        let created =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();

        let read = board
            .get_board_for_user(&workspaces, &created.parent.id, "user-a")
            .await
            .unwrap();
        assert_eq!(read.parent.id, created.parent.id);
        assert_eq!(read.subtasks.len(), 2);
        assert_eq!(read.dependencies.len(), 1);
    }

    // Owner scoping: a different signed-in account can't read the board.
    #[tokio::test]
    async fn board_is_scoped_to_the_owner() {
        let (workspaces, board, repo) = fresh().await;
        let created =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();

        assert!(board
            .get_board_for_user(&workspaces, &created.parent.id, "user-a")
            .await
            .is_ok());
        assert!(
            matches!(
                board
                    .get_board_for_user(&workspaces, &created.parent.id, "user-b")
                    .await,
                Err(StoreError::NotFound)
            ),
            "a different account must get NotFound for another user's board"
        );
    }

    // Progressive disclosure (spec B6): subtasks never leak into the flat
    // top-level workspace list that backs the sidebar.
    #[tokio::test]
    async fn subtasks_do_not_leak_into_the_flat_workspace_list() {
        let (workspaces, board, repo) = fresh().await;
        let created =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();

        let top_ids: Vec<_> = workspaces
            .list_by_repository_for_user(&repo.id, "user-a")
            .await
            .unwrap()
            .into_iter()
            .map(|w| w.id)
            .collect();
        for subtask in &created.subtasks {
            assert!(
                !top_ids.contains(&subtask.id),
                "a subtask must never appear in the flat top-level workspace list"
            );
        }
    }

    // Dedup decision: a re-submit is NOT deduped (no parent_id in the input to
    // key on) — each approval mints its own parent + its own subtasks, mirroring
    // start_task's deliberate-re-run-makes-fresh-state semantics.
    #[tokio::test]
    async fn re_decompose_mints_a_fresh_independent_parent() {
        let (workspaces, board, repo) = fresh().await;
        let first =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();
        let second =
            create_decomposition_inner(&sample_input(&repo.id), "user-a", &workspaces, &board)
                .await
                .unwrap();

        assert_ne!(first.parent.id, second.parent.id);
        let first_ids: Vec<_> = first.subtasks.iter().map(|s| s.id.clone()).collect();
        for subtask in &second.subtasks {
            assert!(
                !first_ids.contains(&subtask.id),
                "a re-decompose must not reuse the first submission's subtasks"
            );
        }
    }

    // A malformed plan is a clear error, and NOTHING is persisted for it.
    #[tokio::test]
    async fn malformed_decomposition_is_rejected_and_persists_nothing() {
        let (workspaces, board, repo) = fresh().await;

        // Duplicate role.
        let mut dup = sample_input(&repo.id);
        dup.subtasks[1].role = "backend".into();
        assert!(matches!(
            create_decomposition_inner(&dup, "user-a", &workspaces, &board).await,
            Err(BoardCmdError::InvalidDecomposition(_))
        ));

        // Self-edge.
        let mut self_edge = sample_input(&repo.id);
        self_edge.edges[0] = EdgeInput {
            from_role: "backend".into(),
            to_role: "backend".into(),
        };
        assert!(matches!(
            create_decomposition_inner(&self_edge, "user-a", &workspaces, &board).await,
            Err(BoardCmdError::InvalidDecomposition(_))
        ));

        // Edge referencing an unknown role.
        let mut dangling = sample_input(&repo.id);
        dangling.edges[0] = EdgeInput {
            from_role: "backend".into(),
            to_role: "nope".into(),
        };
        assert!(matches!(
            create_decomposition_inner(&dangling, "user-a", &workspaces, &board).await,
            Err(BoardCmdError::InvalidDecomposition(_))
        ));

        // Empty subtasks.
        let empty = DecompositionInput {
            repository_id: repo.id.clone(),
            parent_prompt: "x".into(),
            subtasks: vec![],
            edges: vec![],
        };
        assert!(matches!(
            create_decomposition_inner(&empty, "user-a", &workspaces, &board).await,
            Err(BoardCmdError::InvalidDecomposition(_))
        ));

        // None of the rejected attempts persisted a top-level row.
        assert!(workspaces
            .list_by_repository(&repo.id)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn parent_title_uses_first_non_empty_line() {
        assert_eq!(parent_title("  \n  Build it\nmore"), "Build it");
        assert_eq!(parent_title("   "), "Decomposition");
        assert_eq!(parent_title(""), "Decomposition");
    }

    // ── BE-1: the shared, hardened validator ────────────────────────────────

    fn subtask(role: &str) -> SubtaskInput {
        SubtaskInput {
            role: role.into(),
            agent: Agent::Claude,
            prompt: "do the thing".into(),
        }
    }

    fn edge(from: &str, to: &str) -> EdgeInput {
        EdgeInput {
            from_role: from.into(),
            to_role: to.into(),
        }
    }

    // The valid-DAG regression: the existing PoC shape (backend → frontend)
    // still passes the hardened validator unchanged.
    #[test]
    fn validate_accepts_valid_dag() {
        let input = sample_input("r");
        assert!(validate_decomposition(&input.subtasks, &input.edges).is_ok());
    }

    // Claim #1 (the gap this story closes): a 2-node cycle a↔b is rejected.
    #[test]
    fn validate_rejects_two_node_cycle() {
        let subtasks = vec![subtask("a"), subtask("b")];
        let edges = vec![edge("a", "b"), edge("b", "a")];
        assert!(matches!(
            validate_decomposition(&subtasks, &edges),
            Err(BoardCmdError::InvalidDecomposition(_))
        ));
    }

    // A multi-hop cycle a → b → c → a is rejected too (not just the trivial pair).
    #[test]
    fn validate_rejects_multi_hop_cycle() {
        let subtasks = vec![subtask("a"), subtask("b"), subtask("c")];
        let edges = vec![edge("a", "b"), edge("b", "c"), edge("c", "a")];
        assert!(matches!(
            validate_decomposition(&subtasks, &edges),
            Err(BoardCmdError::InvalidDecomposition(_))
        ));
    }

    // The size cap: MAX_SUBTASKS + 1 subtasks (no edges — the cap fires first) is
    // rejected before any DAG work.
    #[test]
    fn validate_rejects_over_cap() {
        let subtasks: Vec<SubtaskInput> = (0..=MAX_SUBTASKS)
            .map(|i| subtask(&format!("role-{i}")))
            .collect();
        assert_eq!(subtasks.len(), MAX_SUBTASKS + 1);
        assert!(matches!(
            validate_decomposition(&subtasks, &[]),
            Err(BoardCmdError::InvalidDecomposition(_))
        ));
    }

    // A longer acyclic chain right at the cap still validates — the cycle check
    // must not false-positive on a legitimate deep DAG.
    #[test]
    fn validate_accepts_acyclic_chain_at_cap() {
        let subtasks: Vec<SubtaskInput> = (0..MAX_SUBTASKS)
            .map(|i| subtask(&format!("role-{i}")))
            .collect();
        let edges: Vec<EdgeInput> = (0..MAX_SUBTASKS - 1)
            .map(|i| edge(&format!("role-{i}"), &format!("role-{}", i + 1)))
            .collect();
        assert!(validate_decomposition(&subtasks, &edges).is_ok());
    }

    // ── E2-T4 (publish_contract) + E3-T1 (integrate_parent) ─────────────────

    /// A scheduler config wired for deterministic tests: a tempdir contract root
    /// (never the real `~/.phasr`) so `publish_contract` writes under the test
    /// dir, plus the production min-bytes threshold.
    fn test_config(contract_root: &Path) -> SchedulerConfig {
        SchedulerConfig {
            contract_root: contract_root.to_path_buf(),
            ..SchedulerConfig::default()
        }
    }

    /// One-commit git repo on `main`, with commit signing off so tests never
    /// block on a key. Mirrors the git test scaffolding in `git/merge.rs`.
    fn init_repo(path: &Path) {
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "tester"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            Command::new("git")
                .args(&args)
                .current_dir(path)
                .status()
                .unwrap();
        }
        std::fs::write(path.join("README.md"), "hi\n").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(path)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", "init"])
            .current_dir(path)
            .status()
            .unwrap();
    }

    /// Branch off `main`, write `file` with `contents`, commit, and return to
    /// `main` — leaving a real `branch` with one commit for integration to merge.
    fn commit_on_branch(repo: &Path, branch: &str, file: &str, contents: &str, msg: &str) {
        Command::new("git")
            .args(["checkout", "-q", "-b", branch, "main"])
            .current_dir(repo)
            .status()
            .unwrap();
        std::fs::write(repo.join(file), contents).unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(repo)
            .status()
            .unwrap();
        Command::new("git")
            .args(["commit", "-qm", msg])
            .current_dir(repo)
            .status()
            .unwrap();
        Command::new("git")
            .args(["checkout", "-q", "main"])
            .current_dir(repo)
            .status()
            .unwrap();
    }

    /// A git-backed board fixture: a real one-commit repo on disk (so worktree +
    /// merge ops work), the three repos, and a seeded `user-a` owner. The
    /// returned TempDir keeps the repo + DB alive for the test — but the
    /// integration worktree lands under `~/.phasr/worktrees/<parent>` (OUTSIDE
    /// it), so integration tests must `cleanup_integration` at the end.
    async fn fresh_with_git() -> (
        WorkspaceRepo,
        BoardRepo,
        RepositoryRepo,
        Repository,
        tempfile::TempDir,
    ) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("test.sqlite")).await.unwrap();
        let repos = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board = BoardRepo::new(pool.clone());

        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        init_repo(&repo_dir);
        let mut r = Repository::new(
            "repo".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        r.default_branch = "main".into();
        repos.insert(&r).await.unwrap();
        seed_user(&pool, "user-a").await;
        (workspaces, board, repos, r, tmp)
    }

    /// Insert a `parent` + two `subtask` rows (owner `user-a`) with the given
    /// real branches, plus the `backend → frontend` edge. Returns the parent and
    /// the two subtasks. Branch-bearing = "was spawned and produced work", the
    /// integration criterion.
    async fn seed_board_with_branches(
        workspaces: &WorkspaceRepo,
        board: &BoardRepo,
        repo_id: &str,
        backend_branch: Option<&str>,
        frontend_branch: Option<&str>,
    ) -> (Workspace, Workspace, Workspace) {
        let mut parent = Workspace::new(repo_id.to_string(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;
        workspaces.insert_for_user(&parent, "user-a").await.unwrap();

        let mut backend = Workspace::new(repo_id.to_string(), "backend".into(), "cmd".into());
        backend.workspace_kind = WorkspaceKind::Subtask;
        backend.parent_id = Some(parent.id.clone());
        backend.role = Some("backend".into());
        backend.branch = backend_branch.map(String::from);
        // Interactive agents rarely exit, so a "done" subtask is typically still
        // Running — integration keys off having a BRANCH, not a terminal status.
        backend.status = WorkspaceStatus::Running;
        workspaces.insert_for_user(&backend, "user-a").await.unwrap();

        let mut frontend = Workspace::new(repo_id.to_string(), "frontend".into(), "cmd".into());
        frontend.workspace_kind = WorkspaceKind::Subtask;
        frontend.parent_id = Some(parent.id.clone());
        frontend.role = Some("frontend".into());
        frontend.branch = frontend_branch.map(String::from);
        frontend.status = WorkspaceStatus::Running;
        workspaces.insert_for_user(&frontend, "user-a").await.unwrap();

        let edge =
            WorkspaceDependency::new(parent.id.clone(), backend.id.clone(), frontend.id.clone());
        board.insert_dependency(&edge).await.unwrap();
        (parent, backend, frontend)
    }

    /// Tear down the integration worktree + branch a test created under
    /// `~/.phasr/worktrees/<parent>` (outside the test TempDir).
    fn cleanup_integration(repo_path: &Path, parent: &Workspace) {
        let worktree = git::default_worktree_base_path().join(&parent.id);
        let _ = git::remove_worktree(repo_path, &worktree);
        let parent_slug = git::slugify(&parent.name);
        let branch =
            git::default_branch_name(&format!("integration/{parent_slug}-{}", git::short_id(&parent.id)), git::short_id(&parent.id));
        let _ = git::branch_delete(repo_path, &branch);
    }

    // E2-T4 AC: "Mark done" publishes the contract (writes the file + stamps the
    // row) and the dependent unblocks on the next scheduler tick — proven via the
    // SAME `ready_subtask_ids` derivation the scheduler spawns from.
    #[tokio::test]
    async fn publish_contract_marks_published_and_unblocks_dependent() {
        let (workspaces, board, _repos, repo, tmp) = fresh_with_git().await;
        let (parent, backend, frontend) =
            seed_board_with_branches(&workspaces, &board, &repo.id, None, None).await;
        let config = test_config(&tmp.path().join("contracts-root"));

        // Before: frontend's incoming edge is unsatisfied → still blocked.
        let deps = board.list_dependencies(&parent.id).await.unwrap();
        assert!(
            !is_unblocked(
                &frontend.id,
                &deps,
                &board.list_contracts(&parent.id).await.unwrap()
            ),
            "frontend must be blocked before backend publishes"
        );

        // Mark backend done.
        publish_contract_inner(&backend.id, "user-a", &workspaces, &board, &config)
            .await
            .unwrap();

        // The contract file was written (non-empty) at the polled path...
        let file = config.contract_file(&parent.id, "backend");
        assert!(
            contract_file_is_ready(&file, config.min_contract_bytes),
            "publish_contract must write a non-empty contract file"
        );
        // ...and a PUBLISHED row now mirrors it.
        let published = board.find_contract(&backend.id).await.unwrap().unwrap();
        assert!(
            published.published_at.is_some(),
            "publish_contract must stamp published_at"
        );

        // After: the dependent is unblocked (the scheduler's next tick spawns it).
        let contracts = board.list_contracts(&parent.id).await.unwrap();
        assert!(
            is_unblocked(&frontend.id, &deps, &contracts),
            "publishing backend's contract must unblock frontend for the next tick"
        );
    }

    // E2-T4: publishing is idempotent — a second "Mark done" must not create a
    // duplicate contract row, it re-stamps/keeps the existing one.
    #[tokio::test]
    async fn publish_contract_is_idempotent() {
        let (workspaces, board, _repos, repo, tmp) = fresh_with_git().await;
        let (parent, backend, _frontend) =
            seed_board_with_branches(&workspaces, &board, &repo.id, None, None).await;
        let config = test_config(&tmp.path().join("contracts-root"));

        publish_contract_inner(&backend.id, "user-a", &workspaces, &board, &config)
            .await
            .unwrap();
        publish_contract_inner(&backend.id, "user-a", &workspaces, &board, &config)
            .await
            .unwrap();

        assert_eq!(
            board.list_contracts(&parent.id).await.unwrap().len(),
            1,
            "a second publish must not create a duplicate contract row"
        );
    }

    // E2-T4 guard: publishing a contract only makes sense for a subtask. A
    // standalone agent (no parent_id/role) is rejected, not silently mishandled.
    #[tokio::test]
    async fn publish_contract_rejects_a_non_subtask() {
        let (workspaces, board, _repos, repo, tmp) = fresh_with_git().await;
        let agent = Workspace::new(repo.id.clone(), "solo".into(), "cmd".into());
        workspaces.insert_for_user(&agent, "user-a").await.unwrap();
        let config = test_config(&tmp.path().join("contracts-root"));

        assert!(matches!(
            publish_contract_inner(&agent.id, "user-a", &workspaces, &board, &config).await,
            Err(BoardCmdError::NotASubtask(_))
        ));
    }

    // E3-T1 AC: two non-overlapping subtasks (different files) merge cleanly into
    // a DEDICATED integration worktree (never the user's checkout), the parent row
    // now points at the integration branch/worktree, and the combined tree carries
    // BOTH changes.
    #[tokio::test]
    async fn integrate_parent_merges_two_subtasks_cleanly() {
        let (workspaces, board, repos, repo, _tmp) = fresh_with_git().await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        commit_on_branch(repo_path, "phasr/backend", "backend.txt", "backend\n", "backend work");
        commit_on_branch(repo_path, "phasr/frontend", "frontend.txt", "frontend\n", "frontend work");
        let (parent, _b, _f) = seed_board_with_branches(
            &workspaces,
            &board,
            &repo.id,
            Some("phasr/backend"),
            Some("phasr/frontend"),
        )
        .await;
        let repo_locks = RepoLockRegistry::new();

        let integrated = integrate_parent_inner(
            &parent.id,
            "user-a",
            &workspaces,
            &board,
            &repos,
            &repo_locks,
        )
        .await
        .expect("a non-conflicting integration must succeed");

        // The parent now carries the integration branch + worktree (spec B1).
        let integration_branch = integrated.parent.branch.clone().expect("parent has a branch");
        assert!(integration_branch.starts_with("phasr/integration/"));
        let worktree = integrated
            .parent
            .worktree_path
            .clone()
            .expect("parent has a worktree");
        let worktree = Path::new(&worktree);

        // A DEDICATED worktree under ~/.phasr/worktrees — NEVER the user's checkout.
        assert_ne!(
            worktree,
            repo_path,
            "integration must never happen in the user's checkout"
        );
        // The combined tree carries BOTH subtasks' changes.
        assert!(worktree.join("backend.txt").exists(), "backend's change is present");
        assert!(worktree.join("frontend.txt").exists(), "frontend's change is present");
        // A clean integration leaves no merge in progress.
        assert_eq!(git::merge_in_progress(worktree).unwrap(), git::InProgress::None);

        cleanup_integration(repo_path, &parent);
    }

    // E3-T1 AC: overlapping edits (both branches change the same lines) STOP on
    // `Conflicts` and leave the integration worktree mid-merge for the existing
    // interactive resolver — it must NOT silently succeed or clobber. The parent
    // row already points at the conflicted worktree so `git_merge_in_progress`
    // (keyed on the parent id) surfaces it.
    #[tokio::test]
    async fn integrate_parent_stops_on_conflict_and_leaves_worktree_conflicted() {
        let (workspaces, board, repos, repo, _tmp) = fresh_with_git().await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        // Both branches rewrite README.md's only line differently → a real conflict.
        commit_on_branch(repo_path, "phasr/backend", "README.md", "backend version\n", "backend edit");
        commit_on_branch(repo_path, "phasr/frontend", "README.md", "frontend version\n", "frontend edit");
        let (parent, _b, _f) = seed_board_with_branches(
            &workspaces,
            &board,
            &repo.id,
            Some("phasr/backend"),
            Some("phasr/frontend"),
        )
        .await;
        let repo_locks = RepoLockRegistry::new();

        let result = integrate_parent_inner(
            &parent.id,
            "user-a",
            &workspaces,
            &board,
            &repos,
            &repo_locks,
        )
        .await;

        // It surfaces Conflicts naming the file — never a silent Ok.
        match result {
            Err(BoardCmdError::IntegrationConflict { files }) => {
                assert!(files.contains(&"README.md".to_string()), "conflict names README.md");
            }
            other => panic!("expected an IntegrationConflict, got {other:?}"),
        }

        // The parent row points at the integration worktree (persisted BEFORE the
        // merge), so the conflict flow (keyed on the parent id) targets it.
        let parent_row = workspaces.get_for_user(&parent.id, "user-a").await.unwrap();
        let worktree = parent_row.worktree_path.clone().expect("parent points at the worktree");
        let worktree = Path::new(&worktree);
        assert!(
            matches!(
                git::merge_in_progress(worktree).unwrap(),
                git::InProgress::Merge { .. }
            ),
            "the integration worktree must be left mid-merge for the resolver"
        );
        // The conflict was not clobbered — the file still carries conflict markers.
        let readme = std::fs::read_to_string(worktree.join("README.md")).unwrap();
        assert!(readme.contains("<<<<<<<"), "conflict markers must remain for resolution");

        cleanup_integration(repo_path, &parent);
    }

    // E3-T1 AC: the merge is TOPOLOGICAL — the producer (`backend`) merges before
    // the consumer (`frontend`) even when the rows are stored consumer-first. The
    // pure ordering is locked by `topological_subtask_order_*`; here we prove it
    // end-to-end via the integration branch's commit graph (frontend's merge
    // commit is newer than backend's → backend merged first).
    #[tokio::test]
    async fn integrate_parent_merges_in_topological_order() {
        let (workspaces, board, repos, repo, _tmp) = fresh_with_git().await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        commit_on_branch(repo_path, "phasr/backend", "backend.txt", "backend\n", "backend work");
        commit_on_branch(repo_path, "phasr/frontend", "frontend.txt", "frontend\n", "frontend work");

        // Insert the parent, then the subtasks CONSUMER-FIRST (frontend before
        // backend), so a naive insertion-order merge would do frontend first —
        // topo sort must override that to honor the backend → frontend edge.
        let mut parent = Workspace::new(repo.id.clone(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;
        workspaces.insert_for_user(&parent, "user-a").await.unwrap();

        let mut frontend = Workspace::new(repo.id.clone(), "frontend".into(), "cmd".into());
        frontend.workspace_kind = WorkspaceKind::Subtask;
        frontend.parent_id = Some(parent.id.clone());
        frontend.role = Some("frontend".into());
        frontend.branch = Some("phasr/frontend".into());
        frontend.status = WorkspaceStatus::Running;
        workspaces.insert_for_user(&frontend, "user-a").await.unwrap();

        let mut backend = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        backend.workspace_kind = WorkspaceKind::Subtask;
        backend.parent_id = Some(parent.id.clone());
        backend.role = Some("backend".into());
        backend.branch = Some("phasr/backend".into());
        backend.status = WorkspaceStatus::Running;
        workspaces.insert_for_user(&backend, "user-a").await.unwrap();

        let edge =
            WorkspaceDependency::new(parent.id.clone(), backend.id.clone(), frontend.id.clone());
        board.insert_dependency(&edge).await.unwrap();

        let repo_locks = RepoLockRegistry::new();
        let integrated =
            integrate_parent_inner(&parent.id, "user-a", &workspaces, &board, &repos, &repo_locks)
                .await
                .expect("clean topological integration");
        let worktree = integrated.parent.worktree_path.clone().unwrap();

        // Merge-commit subjects, newest first. git's default is "Merge branch 'X'".
        let out = Command::new("git")
            .args(["log", "--format=%s"])
            .current_dir(&worktree)
            .output()
            .unwrap();
        let subjects: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect();
        let frontend_pos = subjects.iter().position(|s| s.contains("frontend"));
        let backend_pos = subjects.iter().position(|s| s.contains("backend"));
        let (frontend_pos, backend_pos) = (
            frontend_pos.expect("a frontend merge commit"),
            backend_pos.expect("a backend merge commit"),
        );
        assert!(
            frontend_pos < backend_pos,
            "frontend's merge must be NEWER (smaller index) than backend's — i.e. backend merged first"
        );

        cleanup_integration(repo_path, &parent);
    }

    // E3-T1: a parent whose subtasks have no branches yet (nothing spawned) still
    // produces a fresh integration worktree off base — an honest EMPTY combined
    // diff, not an error or a clobbered checkout.
    #[tokio::test]
    async fn integrate_parent_with_no_branches_is_an_empty_integration() {
        let (workspaces, board, repos, repo, _tmp) = fresh_with_git().await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        let (parent, _b, _f) =
            seed_board_with_branches(&workspaces, &board, &repo.id, None, None).await;
        let repo_locks = RepoLockRegistry::new();

        let integrated =
            integrate_parent_inner(&parent.id, "user-a", &workspaces, &board, &repos, &repo_locks)
                .await
                .expect("an empty integration still builds the worktree");
        let worktree = integrated.parent.worktree_path.clone().unwrap();
        // Base tree only (README from init), no subtask changes, no merge pending.
        assert!(Path::new(&worktree).join("README.md").exists());
        assert_eq!(
            git::merge_in_progress(Path::new(&worktree)).unwrap(),
            git::InProgress::None
        );

        cleanup_integration(repo_path, &parent);
    }

    // P0-1 AC: after a CLEAN integration the parent worktree is committed/clean,
    // so the worktree-based `git_status` is EMPTY — yet the branch-vs-base
    // combined diff must still list BOTH subtasks' files. This is the exact bug
    // P0-1 fixes: the reward diff comes from the integration branch, not the
    // worktree. Exercises the command's real body (`resolve_integration_range`
    // + `diff_branch_range_status`), minus the `spawn_blocking`/session plumbing.
    #[tokio::test]
    async fn board_integration_diff_lists_both_subtasks_after_clean_integration() {
        let (workspaces, board, repos, repo, _tmp) = fresh_with_git().await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        commit_on_branch(repo_path, "phasr/backend", "backend.txt", "backend\n", "backend work");
        commit_on_branch(repo_path, "phasr/frontend", "frontend.txt", "frontend\n", "frontend work");
        let (parent, _b, _f) = seed_board_with_branches(
            &workspaces,
            &board,
            &repo.id,
            Some("phasr/backend"),
            Some("phasr/frontend"),
        )
        .await;
        let repo_locks = RepoLockRegistry::new();
        integrate_parent_inner(&parent.id, "user-a", &workspaces, &board, &repos, &repo_locks)
            .await
            .expect("clean integration");

        // The integration worktree is CLEAN (everything committed) — the whole
        // premise of P0-1: the worktree status shows nothing to review.
        let (worktree, base, branch) =
            resolve_integration_range(&parent.id, "user-a", &workspaces, &repos)
                .await
                .unwrap();
        assert!(
            git::status(&worktree).unwrap().is_empty(),
            "a clean integration leaves an empty worktree status"
        );

        // ...yet the branch-vs-base combined diff lists BOTH files.
        let changes = git::diff_branch_range_status(&worktree, &base, &branch).unwrap();
        let paths: Vec<&str> = changes.iter().map(|c| c.path.as_str()).collect();
        assert!(paths.contains(&"backend.txt"), "combined diff lists backend.txt: {paths:?}");
        assert!(paths.contains(&"frontend.txt"), "combined diff lists frontend.txt: {paths:?}");

        cleanup_integration(repo_path, &parent);
    }

    // P0-1: an integration with NO subtask branches (nothing produced) yields an
    // integration branch identical to base → an honest EMPTY combined diff, not
    // an error and not the base tree.
    #[tokio::test]
    async fn board_integration_diff_is_empty_when_nothing_was_merged() {
        let (workspaces, board, repos, repo, _tmp) = fresh_with_git().await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        let (parent, _b, _f) =
            seed_board_with_branches(&workspaces, &board, &repo.id, None, None).await;
        let repo_locks = RepoLockRegistry::new();
        integrate_parent_inner(&parent.id, "user-a", &workspaces, &board, &repos, &repo_locks)
            .await
            .expect("empty integration still builds the worktree");

        let (worktree, base, branch) =
            resolve_integration_range(&parent.id, "user-a", &workspaces, &repos)
                .await
                .unwrap();
        let changes = git::diff_branch_range_status(&worktree, &base, &branch).unwrap();
        assert!(changes.is_empty(), "no merged branches => empty combined diff: {changes:?}");

        cleanup_integration(repo_path, &parent);
    }

    // P0-1 owner-scoping: another signed-in account can't resolve the range for
    // someone else's board (the diff commands read the parent via `get_for_user`).
    #[tokio::test]
    async fn board_integration_diff_range_is_scoped_to_the_owner() {
        let (workspaces, board, repos, repo, _tmp) = fresh_with_git().await;
        let repo_path = Path::new(repo.local_path.as_deref().unwrap());
        let (parent, _b, _f) =
            seed_board_with_branches(&workspaces, &board, &repo.id, None, None).await;
        let repo_locks = RepoLockRegistry::new();
        integrate_parent_inner(&parent.id, "user-a", &workspaces, &board, &repos, &repo_locks)
            .await
            .unwrap();

        // `get_for_user` filters on `user_id`, so a non-owner id resolves to
        // NotFound whether or not that account exists — reads never leak.
        assert!(
            matches!(
                resolve_integration_range(&parent.id, "user-b", &workspaces, &repos).await,
                Err(BoardCmdError::Store(StoreError::NotFound))
            ),
            "a different account must get NotFound resolving another user's integration range"
        );

        cleanup_integration(repo_path, &parent);
    }

    // Pure topo ordering: producers precede consumers regardless of the rows'
    // stored order, and a cycle is surfaced. This is the integration-time
    // defense-in-depth guard; the GATE now rejects cycles up front too
    // (see `validate_rejects_*` below).
    #[test]
    fn topological_subtask_order_puts_producers_before_consumers() {
        let repo = "r";
        let mut backend = Workspace::new(repo.into(), "backend".into(), "cmd".into());
        backend.id = "backend".into();
        let mut frontend = Workspace::new(repo.into(), "frontend".into(), "cmd".into());
        frontend.id = "frontend".into();
        let edge = WorkspaceDependency::new("p".into(), "backend".into(), "frontend".into());

        // Stored consumer-first; topo must still yield [backend, frontend].
        let order =
            topological_subtask_order(&[frontend.clone(), backend.clone()], &[edge.clone()])
                .unwrap();
        assert_eq!(
            order.iter().map(|s| s.id.clone()).collect::<Vec<_>>(),
            vec!["backend".to_string(), "frontend".to_string()]
        );

        // A cycle leaves nodes unvisited → InvalidDecomposition.
        let back_edge = WorkspaceDependency::new("p".into(), "frontend".into(), "backend".into());
        assert!(matches!(
            topological_subtask_order(&[backend, frontend], &[edge, back_edge]),
            Err(BoardCmdError::InvalidDecomposition(_))
        ));
    }
}
