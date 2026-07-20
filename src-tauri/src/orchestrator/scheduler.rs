//! Dependency-aware scheduler for multi-agent decompositions (E2-T2).
//!
//! The fan-out COUNTERPART to the liveness poller. Where
//! `spawn_liveness_poller`/`run_liveness_tick` derive honest *status* from
//! output recency, this poller drives *fan-out*: each tick it bridges published
//! contract FILES into the DB (the file→DB bridge, spec B3) and spawns each
//! subtask whose incoming DAG edges are all satisfied (spec B4/B5). It is an
//! additive background consumer — zero writes to the PTY hot path (spec claim
//! #8).
//!
//! Split (mirrors `liveness.rs` ↔ `service.rs`): this module holds the pure,
//! unit-testable pieces — the injectable config, the contract-dir paths, the
//! readiness derivation, and the prompt-seeding builders. The side-effecting
//! tick methods (`spawn_scheduler`/`run_scheduler_tick`/`spawn_ready_subtask`)
//! live on `TaskOrchestrator` in `service.rs`, so they can reach the
//! orchestrator's private deps (workspaces/repositories/runtime/repo_locks) and
//! REUSE `start_task`'s spawn internals verbatim rather than reimplementing
//! spawning.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::domain::{Workspace, WorkspaceContract, WorkspaceDependency, WorkspaceStatus};

/// How often the scheduler polls for contract publications + newly-ready
/// subtasks. 3 s per spec §D — a contract handoff becomes visible within one
/// interval. Mirrors `LIVENESS_POLL_INTERVAL`'s shape.
pub const SCHEDULER_POLL_INTERVAL: Duration = Duration::from_secs(3);

/// Max subtasks allowed to run concurrently across the whole app (spec §D). A
/// `tokio::Semaphore` cap — barely exercised at N=2/single-edge, present so the
/// shape is right when arbitrary DAGs land (spec §G).
pub const MAX_CONCURRENT_SUBTASKS: usize = 4;

/// A contract counts as published once its file exists AND is at least this many
/// bytes — i.e. non-empty (spec §D `CONTRACT_STABLE_MIN_BYTES` / §F-2). Guards
/// against reading a zero-byte file an agent has `open`ed but not yet written.
pub const MIN_CONTRACT_BYTES: u64 = 1;

/// Injectable scheduler knobs. Defaults are the production consts; tests build a
/// custom config (fast/hand-driven tick, a tiny cap, a tempdir contract root) so
/// `run_scheduler_tick` can be driven deterministically WITHOUT touching the
/// real `~/.phasr` or waiting on the 3 s clock — the same injectable-thresholds
/// pattern `LivenessThresholds` gives the liveness poller.
#[derive(Debug, Clone)]
pub struct SchedulerConfig {
    pub poll_interval: Duration,
    pub max_concurrent: usize,
    pub min_contract_bytes: u64,
    /// Root of the per-parent contract dirs: `<root>/<parent_id>/contracts/`.
    /// Default `~/.phasr/tasks` — a SIBLING of `~/.phasr/worktrees` and OUTSIDE
    /// every worktree, so `prune_worktrees` can never delete a published
    /// contract (spec §D `CONTRACT_ROOT`, F2 rationale). Overridden to a tempdir
    /// in tests so a run never writes to the developer's real home.
    pub contract_root: PathBuf,
}

impl Default for SchedulerConfig {
    fn default() -> Self {
        Self {
            poll_interval: SCHEDULER_POLL_INTERVAL,
            max_concurrent: MAX_CONCURRENT_SUBTASKS,
            min_contract_bytes: MIN_CONTRACT_BYTES,
            contract_root: default_contract_root(),
        }
    }
}

impl SchedulerConfig {
    /// The contract directory for one parent: `<root>/<parent_id>/contracts/`.
    pub fn contract_dir(&self, parent_id: &str) -> PathBuf {
        self.contract_root.join(parent_id).join("contracts")
    }

    /// The contract file a subtask with `role` writes: `<dir>/<role>.md`.
    pub fn contract_file(&self, parent_id: &str, role: &str) -> PathBuf {
        self.contract_dir(parent_id).join(format!("{role}.md"))
    }
}

/// `~/.phasr/tasks`, the parent of every decomposition's contract dir. Falls
/// back to `/tmp` if `$HOME` is unset (CI sandboxes), matching `naming.rs`.
pub fn default_contract_root() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".phasr")
        .join("tasks")
}

/// A published contract file is "ready" to bridge into the DB once it exists and
/// is at least `min_bytes` long (non-empty, spec §D). A cheap, infrequent stat.
pub fn contract_file_is_ready(path: &Path, min_bytes: u64) -> bool {
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.len() >= min_bytes)
        .unwrap_or(false)
}

// ── DAG readiness derivation (pure) ─────────────────────────────────────────

/// True once the producer `from_subtask_id` has a *published* contract — the
/// ONLY edge-satisfaction signal. It deliberately keys off contract publication,
/// NOT process exit, because interactive agents almost never exit on their own
/// (process exit != task done, spec §0.1 / B3).
pub fn edge_satisfied(from_subtask_id: &str, contracts: &[WorkspaceContract]) -> bool {
    contracts
        .iter()
        .any(|c| c.subtask_id == from_subtask_id && c.published_at.is_some())
}

/// The READY set: ids of subtasks that are `Pending` (never spawned) AND whose
/// EVERY incoming edge is satisfied. A subtask with no incoming edge (the root,
/// e.g. `backend`) is ready immediately; a dependent (`frontend`) is ready only
/// once its producer's contract is published.
///
/// Only `Pending` counts, which is also the recovery guard (E2-T3): an
/// already-running subtask, a terminal one, or a relaunch-interrupted one
/// (`Stopped` + `interrupted_at`) is never (re-)spawned — the scheduler rebuilds
/// the DAG from the DB on its first post-boot tick and blind-restarts nothing.
pub fn ready_subtask_ids(
    subtasks: &[Workspace],
    deps: &[WorkspaceDependency],
    contracts: &[WorkspaceContract],
) -> Vec<String> {
    subtasks
        .iter()
        .filter(|s| s.status == WorkspaceStatus::Pending)
        .filter(|s| {
            deps.iter()
                .filter(|e| e.to_subtask_id == s.id)
                .all(|e| edge_satisfied(&e.from_subtask_id, contracts))
        })
        .map(|s| s.id.clone())
        .collect()
}

/// True if `subtask_id` produces for some dependent (is a `from` of an edge), so
/// it must be told to WRITE its contract (B5 producer seeding).
pub fn is_producer(subtask_id: &str, deps: &[WorkspaceDependency]) -> bool {
    deps.iter().any(|e| e.from_subtask_id == subtask_id)
}

/// The producer ids feeding `subtask_id` (its incoming edges' `from`s) — the
/// contracts to inject into a consumer's prompt (B5 consumer seeding).
pub fn incoming_producer_ids(subtask_id: &str, deps: &[WorkspaceDependency]) -> Vec<String> {
    deps.iter()
        .filter(|e| e.to_subtask_id == subtask_id)
        .map(|e| e.from_subtask_id.clone())
        .collect()
}

// ── prompt seeding (pure, B5) ───────────────────────────────────────────────

/// A predecessor's published contract, ready to seed into a consumer's prompt.
#[derive(Debug, Clone)]
pub struct ContractSeed {
    pub role: String,
    pub content: String,
}

/// Instruction appended to a PRODUCER's prompt: write your handoff contract to
/// the well-known path so the scheduler can detect it and unblock dependents
/// (B5). No new template var — this rides inside the existing `{{prompt}}`.
pub fn producer_prompt_suffix(contract_path: &Path) -> String {
    format!(
        "\n\n---\nWhen your work is complete, write your interface/API contract \
         — the handoff notes a dependent task needs to build against your work — \
         to `{}`. A downstream task is waiting on that file: it is the signal \
         that unblocks them.",
        contract_path.display()
    )
}

/// Block prepended to a CONSUMER's prompt: the contracts its predecessors
/// published, so it can build against the real interface instead of guessing
/// (B5). One section per satisfied incoming edge.
pub fn consumer_prompt_prefix(seeds: &[ContractSeed]) -> String {
    let mut out = String::new();
    for seed in seeds {
        out.push_str(&format!(
            "The `{}` task you depend on published this contract:\n\n{}\n\n---\n\n",
            seed.role,
            seed.content.trim()
        ));
    }
    out
}

/// Point the agent at its ticket brief (T3). The paths are ABSOLUTE and on the
/// MAIN checkout (`<repo>/.phasr/tickets/<id>/…`), NOT the subtask's worktree:
/// the brief is authored/uncommitted on the main checkout, so a fresh worktree
/// (which only sees committed files) can't see it — the agent reads it via this
/// out-of-worktree path, exactly like the published-contract pattern (A3 /
/// architect #1). Always current, no commit needed at spawn.
pub fn brief_prompt_pointer(ticket_dir: &std::path::Path) -> String {
    let dir = ticket_dir.display();
    format!(
        "Your ticket brief (read-only reference, on the main checkout — OUTSIDE \
         your worktree, so read it directly by absolute path):\n\
         - `{dir}/prd.md` — product requirements\n\
         - `{dir}/trd.md` — technical requirements\n\
         - `{dir}/figma.json` — linked designs\n\
         - `{dir}/assets/` — attached files\n\
         Read these before you start; they define what to build. An empty file \
         just means that section hasn't been written yet.\n\n---\n\n"
    )
}

/// Tell the agent which `phasr` verbs it may run to advance its OWN ticket on the
/// board (CLI1 / §J3). Mirrors `brief_prompt_pointer`: a short orientation block
/// folded into the prompt's brief slot. Every verb goes through the app's local
/// socket (`PHASR_SOCK`) authenticated by `PHASR_TOKEN`, so the board moves LIVE.
/// Points at `"$PHASR_BIN"` (the absolute injected path) rather than a bare
/// `phasr` so it works regardless of the agent's PATH (§J4). Only injected for a
/// scheduled subtask that has an owner (the CLI env is present).
pub fn cli_commands_prompt_segment() -> String {
    "You can advance THIS ticket on the phasr board yourself — these commands \
     update the board live for the human watching:\n\
     - `\"$PHASR_BIN\" request-review` — mark your work ready for review\n\
     - `\"$PHASR_BIN\" comment \"<note>\"` — post a note to this ticket's thread\n\
     - `\"$PHASR_BIN\" update-status --done` — publish your handoff contract \
     (unblocks dependent tickets)\n\
     - `\"$PHASR_BIN\" new-ticket --role <role> --agent <agent> --prompt \"<p>\" \
     [--after <role>]` — add a sibling ticket to this same epic\n\
     - `\"$PHASR_BIN\" validate` — run the configured checks against your branch\n\
     They act on YOUR ticket only. Run them from your worktree.\n\n---\n\n"
        .to_string()
}

/// Assemble a subtask's spawn-time prompt from its base prompt plus (optional)
/// brief pointer, producer suffix, and consumer prefix. Composition order is
/// `[consumer_prefix (contracts)] [brief] [base] [producer_suffix]` (§C.2) —
/// Phase 4's persona segment will prepend before `consumer_prefix`, keeping the
/// documented final order `[persona][contracts][brief][base][producer]`. Returns
/// `None` only when everything is empty (no base, no brief, not a producer, no
/// seeds) so an all-empty prompt stays NULL — matching how the decomposition
/// gate's `non_empty_prompt` treats a blank.
pub fn augment_prompt(
    base: Option<&str>,
    brief: Option<&str>,
    producer_suffix: Option<&str>,
    consumer_prefix: Option<&str>,
) -> Option<String> {
    let mut out = String::new();
    if let Some(prefix) = consumer_prefix {
        out.push_str(prefix);
    }
    if let Some(brief) = brief {
        out.push_str(brief);
    }
    if let Some(base) = base {
        out.push_str(base);
    }
    if let Some(suffix) = producer_suffix {
        out.push_str(suffix);
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn pending(id: &str) -> Workspace {
        // A subtask-shaped row in the DEFAULT (Pending) state. Only the fields
        // the pure derivation reads (id, status) matter here.
        let mut ws = Workspace::new("repo".into(), id.into(), "cmd".into());
        ws.id = id.into();
        ws
    }

    fn edge(from: &str, to: &str) -> WorkspaceDependency {
        WorkspaceDependency::new("parent-1".into(), from.into(), to.into())
    }

    fn published(subtask_id: &str) -> WorkspaceContract {
        let mut c = WorkspaceContract::new(
            "parent-1".into(),
            subtask_id.into(),
            "role".into(),
            "/tmp/c.md".into(),
        );
        c.published_at = Some(Utc::now());
        c
    }

    // An edge is satisfied ONLY by a published contract — an unpublished row
    // (published_at = None) or no row at all leaves it unsatisfied (§0.1).
    #[test]
    fn edge_satisfaction_keys_on_publication() {
        assert!(!edge_satisfied("backend", &[]), "no contract → unsatisfied");

        let unpublished = WorkspaceContract::new(
            "parent-1".into(),
            "backend".into(),
            "backend".into(),
            "/tmp/backend.md".into(),
        );
        assert!(unpublished.published_at.is_none());
        assert!(
            !edge_satisfied("backend", std::slice::from_ref(&unpublished)),
            "an unpublished contract row must NOT satisfy the edge"
        );

        assert!(
            edge_satisfied("backend", std::slice::from_ref(&published("backend"))),
            "a published contract satisfies the edge"
        );
    }

    // The canonical PoC shape: backend (no incoming edge) is ready at once;
    // frontend (depends on backend) is blocked until backend's contract is
    // published, then becomes ready.
    #[test]
    fn ready_set_reflects_backend_then_frontend() {
        let subtasks = vec![pending("backend"), pending("frontend")];
        let deps = vec![edge("backend", "frontend")];

        // No contract yet → only backend is ready.
        let ready = ready_subtask_ids(&subtasks, &deps, &[]);
        assert_eq!(ready, vec!["backend".to_string()]);

        // Once backend publishes, frontend joins the ready set.
        let contracts = vec![published("backend")];
        let ready = ready_subtask_ids(&subtasks, &deps, &contracts);
        assert!(ready.contains(&"backend".to_string()));
        assert!(ready.contains(&"frontend".to_string()));
    }

    // Only PENDING subtasks are ready: a running/terminal/interrupted subtask is
    // never (re-)spawned — the E2-T3 recovery guard, expressed purely.
    #[test]
    fn only_pending_subtasks_are_ready() {
        let mut running = pending("backend");
        running.status = WorkspaceStatus::Running;
        let mut interrupted = pending("frontend");
        interrupted.status = WorkspaceStatus::Stopped;
        interrupted.interrupted_at = Some(Utc::now());
        let mut done = pending("docs");
        done.status = WorkspaceStatus::Completed;

        let subtasks = vec![running, interrupted, done];
        assert!(
            ready_subtask_ids(&subtasks, &[], &[]).is_empty(),
            "no pending subtask → nothing ready (never re-spawn a live/dead one)"
        );
    }

    // A fan-in: a dependent with TWO incoming edges is ready only once BOTH
    // producers have published (`all`, not `any`).
    #[test]
    fn fan_in_requires_every_incoming_edge_satisfied() {
        let subtasks = vec![pending("a"), pending("b"), pending("c")];
        let deps = vec![edge("a", "c"), edge("b", "c")];

        // Only `a` published → c still blocked; a & b (roots) ready.
        let ready = ready_subtask_ids(&subtasks, &deps, std::slice::from_ref(&published("a")));
        assert!(ready.contains(&"a".to_string()) && ready.contains(&"b".to_string()));
        assert!(!ready.contains(&"c".to_string()), "one of two edges → blocked");

        // Both published → c unblocks.
        let both = vec![published("a"), published("b")];
        let ready = ready_subtask_ids(&subtasks, &deps, &both);
        assert!(ready.contains(&"c".to_string()));
    }

    #[test]
    fn producer_and_consumer_roles_are_derived_from_edges() {
        let deps = vec![edge("backend", "frontend")];
        assert!(is_producer("backend", &deps));
        assert!(!is_producer("frontend", &deps));
        assert_eq!(incoming_producer_ids("frontend", &deps), vec!["backend".to_string()]);
        assert!(incoming_producer_ids("backend", &deps).is_empty());
    }

    // The producer instruction names the exact contract path the scheduler
    // polls for, so the agent and the poller agree on the file location.
    #[test]
    fn producer_suffix_points_at_the_polled_path() {
        let config = SchedulerConfig::default();
        let path = config.contract_file("parent-1", "backend");
        let suffix = producer_prompt_suffix(&path);
        assert!(suffix.contains(&path.display().to_string()));
        assert!(suffix.contains("backend.md"));
    }

    // A consumer's prompt carries the producer's contract CONTENTS verbatim, so
    // the dependent builds against the real interface (B5).
    #[test]
    fn consumer_prefix_embeds_the_contract_contents() {
        let seeds = vec![ContractSeed {
            role: "backend".into(),
            content: "GET /widgets -> [{id, name}]".into(),
        }];
        let prefix = consumer_prompt_prefix(&seeds);
        assert!(prefix.contains("`backend`"));
        assert!(prefix.contains("GET /widgets -> [{id, name}]"));
    }

    #[test]
    fn augment_prompt_composes_prefix_base_suffix_and_collapses_empty() {
        // Producer: base + suffix (no brief).
        let out =
            augment_prompt(Some("do the backend"), None, Some(" [WRITE CONTRACT]"), None).unwrap();
        assert_eq!(out, "do the backend [WRITE CONTRACT]");

        // Consumer: prefix + base (no brief).
        let out =
            augment_prompt(Some("do the frontend"), None, None, Some("[CONTRACT] ")).unwrap();
        assert_eq!(out, "[CONTRACT] do the frontend");

        // Nothing at all → NULL (not an empty string).
        assert_eq!(augment_prompt(None, None, None, None), None);
        assert_eq!(augment_prompt(Some("   "), None, None, None), None);
    }

    // T3: the 4-arg composition order is exactly
    // `[consumer_prefix (contracts)] [brief] [base] [producer_suffix]`.
    #[test]
    fn augment_prompt_places_brief_between_contracts_and_base() {
        let out = augment_prompt(
            Some("BASE"),
            Some("BRIEF "),
            Some(" SUFFIX"),
            Some("PREFIX "),
        )
        .unwrap();
        assert_eq!(out, "PREFIX BRIEF BASE SUFFIX");

        // Brief-only (an empty-prompt subtask with no edges) still produces a
        // prompt — an empty brief is not an error, the pointer is still useful.
        let out = augment_prompt(None, Some("BRIEF"), None, None).unwrap();
        assert_eq!(out, "BRIEF");

        // Brief + base, no contracts/producer (the common single-consumer case).
        let out = augment_prompt(Some("BASE"), Some("BRIEF "), None, None).unwrap();
        assert_eq!(out, "BRIEF BASE");
    }

    // T3: the pointer names the absolute main-repo ticket files (NOT the
    // worktree) so the agent reads the always-current brief (architect #1/A3).
    #[test]
    fn brief_pointer_names_the_absolute_main_repo_ticket_paths() {
        let dir = std::path::Path::new("/repo/.phasr/tickets/ticket-1");
        let pointer = brief_prompt_pointer(dir);
        assert!(pointer.contains("/repo/.phasr/tickets/ticket-1/prd.md"));
        assert!(pointer.contains("/repo/.phasr/tickets/ticket-1/trd.md"));
        assert!(pointer.contains("/repo/.phasr/tickets/ticket-1/figma.json"));
        assert!(pointer.contains("/repo/.phasr/tickets/ticket-1/assets/"));
    }

    // CLI1 (§J3): the "commands you can run" segment names every phasr verb via
    // the injected `$PHASR_BIN` (not a bare `phasr`, so PATH doesn't matter, §J4)
    // and mirrors the UI/CLI verb names 1:1.
    #[test]
    fn cli_commands_segment_names_every_verb_via_phasr_bin() {
        let segment = cli_commands_prompt_segment();
        assert!(segment.contains("$PHASR_BIN"), "invoke via the injected path");
        for verb in [
            "request-review",
            "comment",
            "update-status",
            "new-ticket",
            "validate",
        ] {
            assert!(segment.contains(verb), "segment must mention `{verb}`");
        }
    }

    #[test]
    fn contract_paths_live_under_the_configured_root() {
        let config = SchedulerConfig {
            contract_root: PathBuf::from("/xyz/tasks"),
            ..SchedulerConfig::default()
        };
        assert_eq!(
            config.contract_file("p1", "backend"),
            PathBuf::from("/xyz/tasks/p1/contracts/backend.md")
        );
    }

    #[test]
    fn contract_file_readiness_needs_a_nonempty_file() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.md");
        assert!(!contract_file_is_ready(&missing, 1), "no file → not ready");

        let empty = dir.path().join("empty.md");
        std::fs::write(&empty, "").unwrap();
        assert!(!contract_file_is_ready(&empty, 1), "empty file → not ready");

        let real = dir.path().join("real.md");
        std::fs::write(&real, "x").unwrap();
        assert!(contract_file_is_ready(&real, 1), "non-empty file → ready");
    }
}
