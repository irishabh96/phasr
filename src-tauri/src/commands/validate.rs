//! The Validate gate command surface (Story V1).
//!
//! Two thin `#[tauri::command]` handlers over `orchestrator::validate`:
//!   - `validate_ticket` — run every opted-in `RunCommand` (`run_in_validate`) as
//!     a CAPTURED subprocess in the ticket's worktree, aggregate pass/fail, write
//!     the result to `validate.json` in the ticket folder, and return it. Emits
//!     `phasr://board-changed` so the card's pass/fail chip moves live.
//!   - `get_validate_result` — read the cached `validate.json` back (no run), for
//!     the card chip on load.
//!
//! Owner-scoped through the SYNCABLE workspaces/repositories tables
//! (`get_for_user`): the subtask read is the access boundary. The gate lives on
//! disk (`validate.json`), NOT in a table, so there is NO `request_sync()` and NO
//! migration for the result itself — board/gate state stays OUT of
//! `WorkspaceStatus` (spec invariant #10). The one schema change is the
//! `run_command.run_in_validate` opt-in flag (its own migration).

use std::sync::Arc;

use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::domain::Workspace;
use crate::orchestrator::{run_validate, BoardEventBus, ValidateConfig, ValidateResult};
use crate::store::{RepositoryRepo, RunCommandRepo, StoreError, WorkspaceRepo};
use crate::tickets::{read_gate_file, write_gate_file, GateFile, TicketError, TicketWriteRegistry};

// ── error ────────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum ValidateCmdError {
    Store(StoreError),
    Auth(AuthError),
    Ticket(TicketError),
    /// The id names a row that isn't a decomposition subtask (no `parent_id`/
    /// `role`) — there is no ticket worktree to validate.
    NotASubtask(String),
    /// The subtask has no worktree yet (never spawned / pending) — nothing to run
    /// a check against. A legible reject, not a silent empty pass.
    NoWorktree(String),
}

impl From<StoreError> for ValidateCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<AuthError> for ValidateCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<TicketError> for ValidateCmdError {
    fn from(e: TicketError) -> Self {
        Self::Ticket(e)
    }
}

impl std::fmt::Display for ValidateCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(e) => write!(f, "{e}"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::Ticket(e) => write!(f, "{e}"),
            Self::NotASubtask(msg) => write!(f, "{msg}"),
            Self::NoWorktree(msg) => write!(f, "{msg}"),
        }
    }
}

impl serde::Serialize for ValidateCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── commands ─────────────────────────────────────────────────────────────────

/// Run the ticket's Validate checks (captured, per-worktree), persist
/// `validate.json`, and return the result. Owner-scoped; emits
/// `phasr://board-changed` on completion.
#[tauri::command]
pub async fn validate_ticket(
    subtask_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    run_commands: State<'_, RunCommandRepo>,
    registry: State<'_, Arc<TicketWriteRegistry>>,
    session: State<'_, Arc<SessionState>>,
    board_events: State<'_, Arc<BoardEventBus>>,
) -> Result<ValidateResult, ValidateCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    // Owner-scoped read: the subtask fetch is the access boundary.
    let subtask = workspaces.get_for_user(&subtask_id, &current.user_id).await?;
    let result = run_and_persist_validate(
        &subtask,
        &current.user_id,
        &repositories,
        &run_commands,
        &registry,
        &ValidateConfig::default(),
    )
    .await?;

    // Move the card's pass/fail chip live (architect §R1). Keyed on the parent so
    // the whole board re-fetches — a validate can be triggered from anywhere.
    if let Some(parent_id) = subtask.parent_id.as_deref() {
        board_events.notify(parent_id);
    }
    Ok(result)
}

/// Read the last cached `validate.json` (no run). `None` when the ticket was
/// never validated (or its repo has no checkout here). Owner-scoped; tolerant of
/// a malformed file (treated as "no result").
#[tauri::command]
pub async fn get_validate_result(
    subtask_id: String,
    workspaces: State<'_, WorkspaceRepo>,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<Option<ValidateResult>, ValidateCmdError> {
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    let subtask = workspaces.get_for_user(&subtask_id, &current.user_id).await?;
    let repository = repositories.get(&subtask.repository_id).await?;
    let Some(repo_root) = repository.local_path.as_deref() else {
        return Ok(None);
    };
    let Some(raw) = read_gate_file(std::path::Path::new(repo_root), &subtask_id, GateFile::Validate)?
    else {
        return Ok(None);
    };
    // A hand-corrupted `validate.json` reads as "no result" rather than erroring —
    // the FE just offers a fresh run.
    Ok(serde_json::from_str::<ValidateResult>(&raw).ok())
}

// ── internals (testable without Tauri `State`) ───────────────────────────────

/// Run + persist Validate for an already-resolved (owner-scoped) subtask. Split
/// out so tests drive it against a real worktree + a tempdir checkout without
/// Tauri `State`. Runs the opted-in checks, writes `validate.json` (atomic +
/// registry-recorded to suppress the watch echo), and returns the result.
pub(crate) async fn run_and_persist_validate(
    subtask: &Workspace,
    user_id: &str,
    repositories: &RepositoryRepo,
    run_commands: &RunCommandRepo,
    registry: &TicketWriteRegistry,
    config: &ValidateConfig,
) -> Result<ValidateResult, ValidateCmdError> {
    // A handoff/worktree only exists for a decomposition subtask.
    if subtask.parent_id.is_none() || subtask.role.is_none() {
        return Err(ValidateCmdError::NotASubtask(format!(
            "workspace `{}` is not a decomposition subtask",
            subtask.id
        )));
    }
    let worktree = subtask.worktree_path.as_deref().ok_or_else(|| {
        ValidateCmdError::NoWorktree(format!(
            "subtask `{}` has no worktree yet — nothing to validate",
            subtask.id
        ))
    })?;

    // The opted-in checks (`run_in_validate`), owner-scoped, in the user's
    // configured order. Empty → a legible empty result (never an error).
    let checks: Vec<(String, String)> = run_commands
        .list_by_repository_for_user(&subtask.repository_id, user_id)
        .await?
        .into_iter()
        .filter(|rc| rc.run_in_validate)
        .map(|rc| (rc.name, rc.command))
        .collect();

    let result = run_validate(
        &subtask.id,
        std::path::Path::new(worktree),
        &checks,
        config,
    )
    .await;

    // Persist to `validate.json` in the ticket folder (docs-as-files). Best-effort
    // location: a repo with no checkout has nowhere to write, so we return the
    // result unpersisted rather than fail the run.
    let repository = repositories.get(&subtask.repository_id).await?;
    if let Some(repo_root) = repository.local_path.as_deref() {
        let bytes =
            serde_json::to_vec_pretty(&result).map_err(|e| TicketError::Serde(e.to_string()))?;
        write_gate_file(
            registry,
            std::path::Path::new(repo_root),
            &subtask.id,
            GateFile::Validate,
            &bytes,
        )?;
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Repository, WorkspaceKind};
    use crate::store::{init_pool, Db};
    use std::time::Duration;

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

    /// A repo owned by `user-a` with an on-disk checkout, plus a worktree dir the
    /// checks will `cwd` into. Keeps the TempDir alive.
    async fn setup() -> (
        RepositoryRepo,
        RunCommandRepo,
        Repository,
        std::path::PathBuf,
        tempfile::TempDir,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let pool = init_pool(&dir.path().join("test.sqlite")).await.unwrap();
        let repos = RepositoryRepo::new(pool.clone());
        let run_commands = RunCommandRepo::new(pool.clone());
        seed_user(&pool, "user-a").await;

        let checkout = dir.path().join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        let worktree = dir.path().join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();

        let repo = Repository::new(
            "repo".into(),
            Some(checkout.to_string_lossy().into_owned()),
            None,
        );
        repos.insert_for_user(&repo, "user-a").await.unwrap();
        (repos, run_commands, repo, worktree, dir)
    }

    fn subtask_for(repo_id: &str, worktree: &std::path::Path) -> Workspace {
        let mut s = Workspace::new(repo_id.to_string(), "backend".into(), "cmd".into());
        s.workspace_kind = WorkspaceKind::Subtask;
        s.parent_id = Some("parent-1".into());
        s.role = Some("backend".into());
        s.worktree_path = Some(worktree.to_string_lossy().into_owned());
        s
    }

    fn config() -> ValidateConfig {
        ValidateConfig {
            shell: "/bin/sh".into(),
            timeout: Duration::from_secs(5),
        }
    }

    async fn add_check(run_commands: &RunCommandRepo, repo_id: &str, name: &str, command: &str) {
        let mut rc = crate::domain::RunCommand::new(repo_id.into(), name.into(), command.into());
        rc.run_in_validate = true;
        run_commands.insert_for_user(&rc, "user-a").await.unwrap();
    }

    // V1: a passing + a failing check run captured in the worktree, and the
    // aggregate + exit codes are written to `validate.json` (PATH-augmented env).
    #[tokio::test]
    async fn validate_writes_result_with_exit_codes() {
        let (repos, run_commands, repo, worktree, _dir) = setup().await;
        add_check(&run_commands, &repo.id, "pass", "exit 0").await;
        add_check(&run_commands, &repo.id, "fail", "exit 2").await;
        let subtask = subtask_for(&repo.id, &worktree);
        let registry = TicketWriteRegistry::default();

        let result = run_and_persist_validate(
            &subtask, "user-a", &repos, &run_commands, &registry, &config(),
        )
        .await
        .unwrap();

        assert_eq!(result.checks.len(), 2);
        assert!(!result.passed, "a failing check fails the aggregate");
        let fail = result.checks.iter().find(|c| c.name == "fail").unwrap();
        assert_eq!(fail.exit_code, Some(2));

        // validate.json was written into the ticket folder and round-trips.
        let checkout = std::path::Path::new(repo.local_path.as_deref().unwrap());
        let raw = read_gate_file(checkout, &subtask.id, GateFile::Validate)
            .unwrap()
            .expect("validate.json is written");
        let round: ValidateResult = serde_json::from_str(&raw).unwrap();
        assert_eq!(round.subtask_id, subtask.id);
        assert_eq!(round.checks.len(), 2);
        assert!(!round.passed);
    }

    // No checks configured → a legible empty result (`passed:false`), NOT an
    // error; still persisted so `get_validate_result` is consistent.
    #[tokio::test]
    async fn validate_with_no_checks_is_empty_not_error() {
        let (repos, run_commands, repo, worktree, _dir) = setup().await;
        let subtask = subtask_for(&repo.id, &worktree);
        let registry = TicketWriteRegistry::default();

        let result = run_and_persist_validate(
            &subtask, "user-a", &repos, &run_commands, &registry, &config(),
        )
        .await
        .unwrap();
        assert!(result.checks.is_empty());
        assert!(!result.passed);
    }

    // A run command NOT opted into validate is ignored (only `run_in_validate`
    // rows are checks).
    #[tokio::test]
    async fn non_opted_in_run_commands_are_ignored() {
        let (repos, run_commands, repo, worktree, _dir) = setup().await;
        // A pinned dev server the user did NOT opt into validate.
        let rc = crate::domain::RunCommand::new(repo.id.clone(), "dev".into(), "exit 1".into());
        run_commands.insert_for_user(&rc, "user-a").await.unwrap();
        let subtask = subtask_for(&repo.id, &worktree);
        let registry = TicketWriteRegistry::default();

        let result = run_and_persist_validate(
            &subtask, "user-a", &repos, &run_commands, &registry, &config(),
        )
        .await
        .unwrap();
        assert!(result.checks.is_empty(), "an un-opted command is not a check");
    }

    // A non-subtask id rejects `NotASubtask`; a subtask with no worktree rejects
    // `NoWorktree`.
    #[tokio::test]
    async fn rejects_non_subtask_and_missing_worktree() {
        let (repos, run_commands, repo, _worktree, _dir) = setup().await;
        let registry = TicketWriteRegistry::default();

        // A plain agent workspace (no parent/role).
        let agent = Workspace::new(repo.id.clone(), "solo".into(), "cmd".into());
        assert!(matches!(
            run_and_persist_validate(&agent, "user-a", &repos, &run_commands, &registry, &config())
                .await,
            Err(ValidateCmdError::NotASubtask(_))
        ));

        // A real subtask but with no worktree yet.
        let mut pending = Workspace::new(repo.id.clone(), "backend".into(), "cmd".into());
        pending.workspace_kind = WorkspaceKind::Subtask;
        pending.parent_id = Some("parent-1".into());
        pending.role = Some("backend".into());
        assert!(matches!(
            run_and_persist_validate(&pending, "user-a", &repos, &run_commands, &registry, &config())
                .await,
            Err(ValidateCmdError::NoWorktree(_))
        ));
    }
}
