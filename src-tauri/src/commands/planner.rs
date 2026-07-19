//! Planner command surface — one thin `#[tauri::command]`.
//!
//! `plan_decomposition` turns a one-line goal into a proposed subtask DAG by
//! running phasr's own `claude` CLI read-only over the repository (delegated to
//! `orchestrator::planner`). It is a PURE read/compute: it resolves the repo's
//! local path, runs the planner, and returns a `ProposedPlan` DRAFT. It persists
//! NOTHING — no worktree, no rows, no sync (spec A4 / claim #11). The frontend
//! edits the draft in the form and only the unchanged `start_decomposition` gate
//! ever writes anything.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::auth::{AuthError, SessionState};
use crate::commands::board::{EdgeInput, SubtaskInput};
use crate::orchestrator::{plan, PlannerConfig, PlannerError};
use crate::store::{RepositoryRepo, StoreError};

// ── response shape (the frozen §C wire contract) ────────────────────────────

/// The planner's proposed decomposition — `DecompositionInput` minus
/// `repositoryId` + `parentPrompt`. Reuses `SubtaskInput`/`EdgeInput` verbatim,
/// so the wire is `{ subtasks: [{ role, agent, prompt }], edges: [{ fromRole,
/// toRole }] }` (camelCase). The frontend edits this, then submits the whole
/// plan through the unchanged `start_decomposition` gate.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedPlan {
    pub subtasks: Vec<SubtaskInput>,
    pub edges: Vec<EdgeInput>,
}

// ── error ───────────────────────────────────────────────────────────────────

/// Serializes to a plain string across IPC, like `BoardCmdError`. Each variant
/// maps to honest, `humanizeError`-friendly copy; the planner-subprocess detail
/// (spawn/timeout/agent-error/parse/validate) rides in `Planner(PlannerError)`.
#[derive(Debug)]
pub enum PlannerCmdError {
    /// The goal was empty (a backend guard behind the frontend's disabled button).
    EmptyGoal,
    /// The repository row has no local path on disk, so there is nothing for the
    /// read-only planner to inspect.
    NoRepoPath,
    Auth(AuthError),
    Store(StoreError),
    Planner(PlannerError),
}

impl From<AuthError> for PlannerCmdError {
    fn from(e: AuthError) -> Self {
        Self::Auth(e)
    }
}

impl From<StoreError> for PlannerCmdError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}

impl From<PlannerError> for PlannerCmdError {
    fn from(e: PlannerError) -> Self {
        Self::Planner(e)
    }
}

impl std::fmt::Display for PlannerCmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::EmptyGoal => write!(f, "a goal is required to plan a decomposition"),
            Self::NoRepoPath => write!(f, "this repository has no local path to inspect"),
            Self::Auth(e) => write!(f, "{e}"),
            Self::Store(e) => write!(f, "{e}"),
            Self::Planner(e) => write!(f, "{e}"),
        }
    }
}

impl serde::Serialize for PlannerCmdError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

// ── command ──────────────────────────────────────────────────────────────────

/// Draft a decomposition for `goal` against `repository_id`. Owner-scoped, and
/// persists NOTHING — returns a `ProposedPlan` the frontend edits before the gate.
#[tauri::command]
pub async fn plan_decomposition(
    repository_id: String,
    goal: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<ProposedPlan, PlannerCmdError> {
    // Owner-scoped: resolve the repo through the signed-in account so one user
    // can never plan against another account's repository path.
    let current = session.require()?.ok_or(AuthError::NotSignedIn)?;
    plan_decomposition_inner(
        &repository_id,
        &goal,
        &current.user_id,
        &repositories,
        &PlannerConfig::default(),
    )
    .await
}

/// The command's logic, minus session wiring + the default config, so tests can
/// drive it against a stub `claude` (an injected `PlannerConfig`) and a real
/// `RepositoryRepo` — and assert that nothing was persisted.
async fn plan_decomposition_inner(
    repository_id: &str,
    goal: &str,
    user_id: &str,
    repositories: &RepositoryRepo,
    config: &PlannerConfig,
) -> Result<ProposedPlan, PlannerCmdError> {
    // Guard the empty goal up front (the frontend also disables the button, but
    // the backend never trusts that) — no subprocess for an empty goal.
    if goal.trim().is_empty() {
        return Err(PlannerCmdError::EmptyGoal);
    }

    let repository = repositories.get_for_user(repository_id, user_id).await?;
    let repo_dir = repository
        .local_path
        .as_deref()
        .map(PathBuf::from)
        .ok_or(PlannerCmdError::NoRepoPath)?;

    let (subtasks, edges) = plan(
        &repo_dir,
        &repository.name,
        &repository.default_branch,
        goal,
        config,
    )
    .await?;

    Ok(ProposedPlan { subtasks, edges })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::Repository;
    use crate::store::{init_pool, Db, WorkspaceRepo};
    use std::path::{Path, PathBuf};
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

    /// A repo row owned by `user-a` whose `local_path` is a real dir the stub
    /// `claude` can be `current_dir`'d into, plus a `WorkspaceRepo` to prove the
    /// planner writes no rows.
    async fn fresh() -> (RepositoryRepo, WorkspaceRepo, Repository, tempfile::TempDir) {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("test.sqlite")).await.unwrap();
        let repos = RepositoryRepo::new(pool.clone());
        let workspaces = WorkspaceRepo::new(pool.clone());
        seed_user(&pool, "user-a").await;

        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        let repo = Repository::new(
            "repo".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repos.insert_for_user(&repo, "user-a").await.unwrap();
        (repos, workspaces, repo, tmp)
    }

    #[cfg(unix)]
    fn write_stub(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("claude-stub.sh");
        std::fs::write(&path, body).unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[cfg(unix)]
    fn stub_config(dir: &Path, plan_json: &str) -> PlannerConfig {
        let body = format!(
            "#!/bin/sh\ncat <<'PHASR_STUB_EOF'\n{plan_json}\nPHASR_STUB_EOF\n"
        );
        let binary = write_stub(dir, &body);
        PlannerConfig {
            binary: binary.to_string_lossy().into_owned(),
            timeout: Duration::from_secs(5),
        }
    }

    // BE-3 AC: a valid repo + goal returns a ProposedPlan AND persists nothing —
    // a follow-up workspace list shows zero rows.
    #[cfg(unix)]
    #[tokio::test]
    async fn plan_decomposition_persists_nothing() {
        let (repos, workspaces, repo, tmp) = fresh().await;
        let plan_json = r#"{"subtasks":[{"role":"backend","agent":"claude","prompt":"api"},{"role":"frontend","agent":"codex","prompt":"ui"}],"edges":[{"fromRole":"backend","toRole":"frontend"}]}"#;
        let config = stub_config(tmp.path(), plan_json);

        let proposed =
            plan_decomposition_inner(&repo.id, "build a widget", "user-a", &repos, &config)
                .await
                .expect("the planner returns a draft");

        assert_eq!(proposed.subtasks.len(), 2);
        assert_eq!(proposed.edges.len(), 1);
        assert_eq!(proposed.subtasks[1].agent, crate::domain::Agent::Codex);

        // The whole point of B2: NO row is written before "Start N agents".
        assert!(
            workspaces
                .list_by_repository(&repo.id)
                .await
                .unwrap()
                .is_empty(),
            "planning must persist no workspace rows"
        );
    }

    // BE-3 AC: an empty (or whitespace-only) goal is rejected before any
    // subprocess runs.
    #[tokio::test]
    async fn plan_decomposition_rejects_empty_goal() {
        let (repos, _workspaces, repo, _tmp) = fresh().await;
        // A binary that would fail if it ever ran — proving the guard short-circuits.
        let config = PlannerConfig {
            binary: "/nonexistent/claude".into(),
            timeout: Duration::from_secs(5),
        };
        assert!(matches!(
            plan_decomposition_inner(&repo.id, "   ", "user-a", &repos, &config).await,
            Err(PlannerCmdError::EmptyGoal)
        ));
    }

    // Owner scoping: a repo owned by another account is NotFound (Store error),
    // never planned against.
    #[tokio::test]
    async fn plan_decomposition_is_owner_scoped() {
        let (repos, _workspaces, repo, _tmp) = fresh().await;
        let config = PlannerConfig {
            binary: "/nonexistent/claude".into(),
            timeout: Duration::from_secs(5),
        };
        assert!(matches!(
            plan_decomposition_inner(&repo.id, "build it", "user-b", &repos, &config).await,
            Err(PlannerCmdError::Store(StoreError::NotFound))
        ));
    }

    // A repo with no local path can't be inspected → NoRepoPath (never a panic).
    #[tokio::test]
    async fn plan_decomposition_without_local_path_is_no_repo_path() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("test.sqlite")).await.unwrap();
        let repos = RepositoryRepo::new(pool.clone());
        seed_user(&pool, "user-a").await;
        let repo = Repository::new("no-path".into(), None, None);
        repos.insert_for_user(&repo, "user-a").await.unwrap();

        let config = PlannerConfig {
            binary: "/nonexistent/claude".into(),
            timeout: Duration::from_secs(5),
        };
        assert!(matches!(
            plan_decomposition_inner(&repo.id, "build it", "user-a", &repos, &config).await,
            Err(PlannerCmdError::NoRepoPath)
        ));
    }
}
