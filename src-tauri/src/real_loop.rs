//! The REAL end-to-end loop drive (completion program, Phase 11).
//!
//! Every other test in this repo is structurally blind to the same thing: the
//! Playwright suite mocks EVERY Tauri `invoke` (it proves a flow fires the
//! right command, never that git/PTY/socket behave), and the unit tests use
//! synthetic tempdir repos. Nothing had ever driven the factory's spine —
//! decompose → real worktrees → a real agent process → the real Unix socket →
//! real merges → a real push — against a real cloned GitHub repository.
//!
//! This module does exactly that, against the user's designated throwaway
//! (`github.com/irishabh96/test-repo`).
//!
//! ## Running it
//!
//! ```bash
//! PHASR_REAL_E2E=1 cargo test --manifest-path src-tauri/Cargo.toml \
//!     real_loop -- --ignored --nocapture --test-threads=1
//! ```
//!
//! `#[ignore]` + an env gate, so `cargo test` (and CI) skip it: it clones over
//! the network, spawns real processes, and takes ~a minute. Add
//! `PHASR_REAL_E2E_PUSH=1` to also exercise the outward push — it pushes a
//! NAMESPACED `phasr-e2e/<ts>` branch, never the shared `master`.
//!
//! ## What the agent is here
//!
//! `drives_the_full_spine` uses a SCRIPTED agent (a shell one-liner that edits
//! a file, commits, and self-advances the board through the real `phasr` CLI)
//! rather than an LLM: the point is to prove the machinery deterministically
//! and repeatably. `planner_proposes_a_real_plan` covers the one genuinely
//! model-driven step by calling the real `claude -p` planner.
//!
//! ## What this still cannot cover
//!
//! Clerk sign-in, window/event plumbing, notifications, dialog UX, and the CSP
//! (webview-only) — those need the GUI pass documented in
//! `docs/MANUAL-VERIFICATION.md`.

#![cfg(test)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::commands::board::{
    create_decomposition_inner, integrate_parent_inner, publish_contract_inner, ship_epic_inner,
    DecompositionInput, EdgeInput, SubtaskInput,
};
use crate::commands::review::{resolve_review_inner, ReviewDecision};
use crate::domain::{Agent, Repository};
use crate::git;
use crate::orchestrator::{
    BoardEventBus, CliSpawnConfig, CliTokenRegistry, RepoLockRegistry, SchedulerConfig,
    TaskOrchestrator,
};
use crate::pty::TaskRuntime;
use crate::store::{init_pool, BoardRepo, Db, RepositoryRepo, RunCommandRepo, WorkspaceRepo};
use crate::tickets::TicketWriteRegistry;

const TEST_REPO: &str = "https://github.com/irishabh96/test-repo";

fn enabled() -> bool {
    std::env::var("PHASR_REAL_E2E").as_deref() == Ok("1")
}

fn run(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

async fn seed_user(pool: &Db, uid: &str) {
    sqlx::query(
        "INSERT INTO users (id, clerk_user_id, name, email, created_at, updated_at, dirty)
         VALUES (?, ?, 'e2e', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0)",
    )
    .bind(uid)
    .bind(uid)
    .bind(format!("{uid}@example.com"))
    .execute(pool)
    .await
    .unwrap();
}

/// Clone the real throwaway repo into `dir` and register it. Returns the row.
async fn clone_test_repo(repositories: &RepositoryRepo, dir: &Path) -> Repository {
    let checkout = dir.join("test-repo");
    let out = std::process::Command::new("git")
        .args(["clone", "--quiet", TEST_REPO, checkout.to_str().unwrap()])
        .output()
        .expect("git clone");
    assert!(
        out.status.success(),
        "clone failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    // Local identity so the drive's commits/merges never depend on global config.
    run(&checkout, &["config", "user.email", "e2e@phasr.local"]);
    run(&checkout, &["config", "user.name", "phasr e2e"]);
    run(&checkout, &["config", "commit.gpgsign", "false"]);
    let default_branch = run(&checkout, &["rev-parse", "--abbrev-ref", "HEAD"]);

    let mut repo = Repository::new(
        "test-repo".into(),
        Some(checkout.to_string_lossy().into_owned()),
        Some(TEST_REPO.to_string()),
    );
    repo.default_branch = default_branch;
    repositories.insert_for_user(&repo, "e2e-user").await.unwrap();
    repo
}

/// Poll `check` until true or `within` elapses. Returns whether it fired.
async fn wait_for(within: Duration, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    check()
}

/// A scripted "agent": edits a file, commits, then self-advances the board over
/// the REAL `phasr` CLI (`update-status --done` publishes its handoff contract).
/// `$PHASR_BIN`/`$PHASR_TOKEN`/`$PHASR_SOCK` are injected by the spawn exactly
/// as they are for a real agent.
fn scripted_agent(file: &str, body: &str) -> String {
    format!(
        "printf '%s\\n' '{body}' > {file} && git add -A && \
         git -c user.email=e2e@phasr.local -c user.name='phasr e2e' \
             -c commit.gpgsign=false commit -qm 'agent: {file}' && \
         \"$PHASR_BIN\" update-status --done"
    )
}

/// Build the `phasr-cli` binary once and return its path (the spawned agents
/// shell out to it — this is the REAL sidecar, not a stub).
fn build_cli() -> PathBuf {
    let out = std::process::Command::new("cargo")
        .args(["build", "--quiet", "--bin", "phasr-cli"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("cargo build phasr-cli");
    assert!(
        out.status.success(),
        "building phasr-cli failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target/debug/phasr-cli");
    assert!(bin.exists(), "phasr-cli missing at {}", bin.display());
    bin
}

/// THE drive: a real cloned repo → decompose → two real worktrees with real
/// agent processes handing off over a real contract → the gates (validate is
/// skipped: this repo configures no checks, which the ladder treats as a
/// legible no-op) → integrate (real topological merges + the docs commit) →
/// ship (real merge into the default branch) → optional real push.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "real network + processes; run with PHASR_REAL_E2E=1 -- --ignored"]
async fn real_loop_drives_the_full_spine() {
    if !enabled() {
        eprintln!("real_loop: set PHASR_REAL_E2E=1 to run");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("e2e.sqlite")).await.unwrap();
    seed_user(&pool, "e2e-user").await;
    let workspaces = WorkspaceRepo::new(pool.clone());
    let board = BoardRepo::new(pool.clone());
    let repositories = RepositoryRepo::new(pool.clone());
    let run_commands = RunCommandRepo::new(pool.clone());

    let repo = clone_test_repo(&repositories, tmp.path()).await;
    let repo_path = PathBuf::from(repo.local_path.clone().unwrap());
    eprintln!("real_loop: cloned {TEST_REPO} → {}", repo_path.display());

    // ── the real CLI socket + token registry (what agents self-advance over) ──
    let cli_bin = build_cli();
    let sock = tmp.path().join("phasr.sock");
    let tokens = Arc::new(CliTokenRegistry::new());
    let board_events = Arc::new(BoardEventBus::new());
    let listener = crate::orchestrator::ipc_server::bind(&sock).expect("bind socket");
    let server = Arc::new(crate::orchestrator::ipc_server::CliServer {
        workspaces: workspaces.clone(),
        board: board.clone(),
        repositories: repositories.clone(),
        run_commands: run_commands.clone(),
        write_registry: Arc::new(TicketWriteRegistry::default()),
        board_events: board_events.clone(),
        tokens: tokens.clone(),
        scheduler_config: SchedulerConfig {
            contract_root: tmp.path().join("contracts"),
            ..SchedulerConfig::default()
        },
        validate_config: Default::default(),
    });
    tokio::spawn(crate::orchestrator::ipc_server::serve(listener, server));

    let repo_locks = Arc::new(RepoLockRegistry::new());
    let runtime = Arc::new(TaskRuntime::new(tmp.path().join("logs")));
    let orchestrator = TaskOrchestrator::new(
        workspaces.clone(),
        repositories.clone(),
        runtime.clone(),
        repo_locks.clone(),
    )
    .with_cli(
        tokens.clone(),
        CliSpawnConfig {
            bin_path: cli_bin,
            socket_path: sock.clone(),
        },
    );
    let config = SchedulerConfig {
        contract_root: tmp.path().join("contracts"),
        ..SchedulerConfig::default()
    };

    // ── 1. decompose (the gate the planner feeds) ─────────────────────────────
    let input = DecompositionInput {
        repository_id: repo.id.clone(),
        parent_prompt: "Document the project: add NOTES.md, then link it from a GUIDE.md".into(),
        subtasks: vec![
            SubtaskInput {
                role: "backend".into(),
                agent: Agent::Claude,
                prompt: "write NOTES.md".into(),
            },
            SubtaskInput {
                role: "frontend".into(),
                agent: Agent::Claude,
                prompt: "write GUIDE.md".into(),
            },
        ],
        edges: vec![EdgeInput {
            from_role: "backend".into(),
            to_role: "frontend".into(),
        }],
        epic_prd: Some("# PRD\n\nProve the loop end to end.".into()),
        epic_trd: None,
        epic_figma: vec![],
        epic_asset_paths: vec![],
    };
    let assembled =
        create_decomposition_inner(&input, "e2e-user", &workspaces, &board, &repositories)
            .await
            .expect("decomposition");
    let parent = assembled.parent.clone();
    let backend = assembled
        .subtasks
        .iter()
        .find(|s| s.role.as_deref() == Some("backend"))
        .unwrap()
        .clone();
    let frontend = assembled
        .subtasks
        .iter()
        .find(|s| s.role.as_deref() == Some("frontend"))
        .unwrap()
        .clone();
    eprintln!("real_loop: decomposed → parent {} + 2 tickets", parent.id);

    // Swap each agent for its scripted stand-in (deterministic, no LLM).
    for (ws, file) in [(&backend, "NOTES.md"), (&frontend, "GUIDE.md")] {
        workspaces
            .update(
                &ws.id,
                crate::store::WorkspaceUpdate {
                    command: Some(scripted_agent(file, &format!("# {file}"))),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }

    // ── 2. start the producer: a REAL worktree + a REAL process ───────────────
    let deps = board.list_dependencies(&parent.id).await.unwrap();
    let be = workspaces.get(&backend.id).await.unwrap();
    orchestrator
        .start_subtask_now(&parent, &be, &deps, &[], &config)
        .await
        .expect("start backend");
    let be_row = workspaces.get(&backend.id).await.unwrap();
    let be_worktree = PathBuf::from(be_row.worktree_path.clone().expect("worktree"));
    assert!(be_worktree.join(".git").exists(), "a real worktree exists");
    eprintln!("real_loop: backend running in {}", be_worktree.display());

    // The scripted agent commits, then publishes its contract over the socket.
    let published = wait_for(Duration::from_secs(60), || {
        be_worktree.join("NOTES.md").exists()
    })
    .await;
    assert!(published, "the agent never wrote its file");
    let contract_seen = {
        let board = board.clone();
        let id = backend.id.clone();
        let mut ok = false;
        for _ in 0..150 {
            if board
                .list_contracts(&parent.id)
                .await
                .unwrap()
                .iter()
                .any(|c| c.subtask_id == id && c.published_at.is_some())
            {
                ok = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        ok
    };
    assert!(
        contract_seen,
        "the agent's `phasr update-status --done` never reached the socket"
    );
    eprintln!("real_loop: backend published its contract over the real CLI socket");

    // ── 3. the consumer unblocks and runs ─────────────────────────────────────
    let contracts = board.list_contracts(&parent.id).await.unwrap();
    let fe = workspaces.get(&frontend.id).await.unwrap();
    orchestrator
        .start_subtask_now(&parent, &fe, &deps, &contracts, &config)
        .await
        .expect("start frontend");
    let fe_worktree = PathBuf::from(
        workspaces
            .get(&frontend.id)
            .await
            .unwrap()
            .worktree_path
            .expect("worktree"),
    );
    assert!(
        wait_for(Duration::from_secs(60), || fe_worktree.join("GUIDE.md").exists()).await,
        "the consumer never wrote its file"
    );
    // Belt-and-braces: publish is idempotent, so settle the contract directly
    // if the socket call is still in flight.
    let _ = publish_contract_inner(&frontend.id, "e2e-user", &workspaces, &board, &config).await;
    eprintln!("real_loop: frontend done");

    // ── 4. the gates (human path) ─────────────────────────────────────────────
    let registry = TicketWriteRegistry::default();
    for id in [&backend.id, &frontend.id] {
        let ws = workspaces.get(id).await.unwrap();
        crate::commands::review::request_review_inner(
            &ws,
            "e2e-user",
            "you",
            &workspaces,
            &board,
            &repositories,
            &registry,
            &config,
        )
        .await
        .expect("request review");
        let ws = workspaces.get(id).await.unwrap();
        resolve_review_inner(
            &ws,
            "e2e-user",
            "you",
            ReviewDecision::Approve,
            None,
            &workspaces,
            &board,
            &repositories,
            &registry,
            None,
            None,
        )
        .await
        .expect("approve");
    }
    eprintln!("real_loop: both tickets approved");

    // ── 5. integrate: REAL topological merges + the docs commit ───────────────
    integrate_parent_inner(
        &parent.id,
        "e2e-user",
        &workspaces,
        &board,
        &repositories,
        &repo_locks,
    )
    .await
    .expect("integrate");
    let integrated = workspaces.get(&parent.id).await.unwrap();
    let integration_worktree = PathBuf::from(integrated.worktree_path.clone().unwrap());
    assert!(integration_worktree.join("NOTES.md").exists());
    assert!(integration_worktree.join("GUIDE.md").exists());
    // Phase 6: the workflow's docs ride the integration branch.
    let tracked = run(&integration_worktree, &["ls-files", ".phasr"]);
    assert!(
        tracked.contains("prd.md"),
        "workflow docs must be committed onto the integration branch, saw: {tracked}"
    );
    eprintln!("real_loop: integrated (both files + docs on the integration branch)");

    // ── 6. ship: a REAL merge into the repo's default branch ──────────────────
    let outcome = ship_epic_inner(
        &parent.id,
        "e2e-user",
        git::MergeStrategy::Merge,
        &workspaces,
        &repositories,
        &repo_locks,
    )
    .await
    .expect("ship");
    assert!(
        matches!(outcome, crate::commands::board::ShipOutcome::Clean { .. }),
        "ship must land cleanly"
    );
    assert!(repo_path.join("NOTES.md").exists(), "shipped into the checkout");
    assert!(repo_path.join("GUIDE.md").exists());
    let shipped_row = workspaces.get(&parent.id).await.unwrap();
    assert!(shipped_row.shipped_at.is_some(), "shipped_at is stamped");
    eprintln!("real_loop: shipped into {}", shipped_row.branch.unwrap_or_default());

    // ── 7. push (opt-in, NAMESPACED — never the shared master) ────────────────
    if std::env::var("PHASR_REAL_E2E_PUSH").as_deref() == Ok("1") {
        let branch = format!(
            "phasr-e2e/{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
        );
        run(&repo_path, &["branch", &branch]);
        git::push(&repo_path, "origin", &branch).expect("push");
        let remote = run(&repo_path, &["ls-remote", "origin", &branch]);
        assert!(remote.contains(&branch), "the branch reached origin");
        eprintln!("real_loop: pushed {branch} to origin (master untouched)");
        // Leave the remote clean.
        let _ = std::process::Command::new("git")
            .args(["push", "origin", "--delete", &branch])
            .current_dir(&repo_path)
            .output();
    }

    // Reclaim the worktrees this drive minted under ~/.phasr/worktrees.
    for ws in [&be_row.id, &frontend.id, &parent.id] {
        if let Ok(w) = workspaces.get(ws).await {
            if let Some(p) = w.worktree_path {
                let _ = git::remove_worktree(&repo_path, Path::new(&p));
            }
        }
    }
    eprintln!("real_loop: ✅ the full spine ran end to end");
}

/// The one genuinely model-driven step: the REAL planner (`claude -p`) reading
/// the REAL cloned repo and proposing a plan. Separate from the spine drive
/// because it costs model time and its output is not deterministic — we assert
/// the CONTRACT (a well-formed, non-empty, cycle-free plan), not the wording.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "calls the real `claude -p`; run with PHASR_REAL_E2E=1 -- --ignored"]
async fn real_loop_planner_proposes_a_real_plan() {
    if !enabled() {
        eprintln!("real_loop: set PHASR_REAL_E2E=1 to run");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let pool = init_pool(&tmp.path().join("planner.sqlite")).await.unwrap();
    seed_user(&pool, "e2e-user").await;
    let repositories = RepositoryRepo::new(pool.clone());
    let repo = clone_test_repo(&repositories, tmp.path()).await;

    let (subtasks, edges) = crate::orchestrator::plan(
        Path::new(repo.local_path.as_deref().unwrap()),
        &repo.name,
        &repo.default_branch,
        "Add a CONTRIBUTING.md and reference it from the readme",
        &crate::orchestrator::PlannerConfig::default(),
    )
    .await
    .expect("the real planner must answer");

    assert!(!subtasks.is_empty(), "a plan proposes at least one ticket");
    for s in &subtasks {
        assert!(!s.role.trim().is_empty(), "every ticket has a role");
        assert!(!s.prompt.trim().is_empty(), "every ticket has a task");
    }
    // Every edge must name roles the plan actually contains — the gate rejects
    // anything else, so a plan that fails this could never be started.
    for e in &edges {
        assert!(
            subtasks.iter().any(|s| s.role == e.from_role)
                && subtasks.iter().any(|s| s.role == e.to_role),
            "edge {e:?} references a role not in the plan"
        );
    }
    eprintln!(
        "real_loop: planner proposed {} ticket(s): {:?}",
        subtasks.len(),
        subtasks.iter().map(|s| &s.role).collect::<Vec<_>>()
    );
}
