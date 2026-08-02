//! The autopilot driver (Phase 5a, Stage A — spec §4/§6). The safety-critical
//! heart: it advances an epic's gate ladder WITHOUT a human clicking each gate,
//! while stopping hard at every human-judgment / outward edge.
//!
//! ## What it does each pass (`drive_epic`)
//!
//! Under a per-parent async Mutex covering the WHOLE read→compute→fire→settle
//! span (so the event path and the 3s backstop never interleave a read-then-fire
//! TOCTOU), it: resolves the epic + its owner; re-reads the per-epic
//! `autopilot_enabled` flag AND the persisted kill switch FRESH; reads each
//! ticket's `review.json`/`validate.json` FRESH; assembles the policy's
//! `TicketGateState`/`EpicGateState` — deriving the ticket's `TicketState` from
//! the ACTUAL agent/PTY liveness + contract publication (the **I3 liveness layer,
//! which lives HERE, not in `policy.rs`**); calls the pure policy; and fires each
//! `Auto(..)` by calling the SAME `_inner` mutation the button/CLI calls
//! (`run_and_persist_validate`, `request_review_inner` attributed `"autopilot"`,
//! `integrate_parent_inner`). Every `HumanStop(..)` is PARKED (audited, never
//! fired). The `_inner`s emit no `board-changed`, so the driver calls
//! `board_events.notify(parent_id)` itself after each fire.
//!
//! ## Durable fire-once-per-(entity, state) dedup (the loop-safety fix)
//!
//! Each AUTO fire's effect FALSIFIES its own precondition (validate→`validate.json`
//! present; request-review→`review` flips to `requested`; integrate→epic
//! `integrated`), so the NEXT pass derives a DIFFERENT action and the
//! fire→notify→drive→fire chain is a bounded walk down a finite ladder that halts
//! at the first HumanStop/terminal state. That forward progress is BACKED by a
//! durable on-disk `last_fired` marker keyed to `(entity, verb, state_hash)`
//! (`<repo>/.phasr/autopilot/<parent_id>.fired.json`): a gate fires only when the
//! recomputed `state_hash` differs from the last recorded one, and the marker is
//! written BEFORE the fire settles — so a crash between fire and settle can't
//! double-fire, and the actions that do NOT advance derived state (integrate-on-
//! conflict/error) fire at most once per state even across a restart/backstop. The
//! per-parent Mutex covers only the in-process window; the durable marker survives
//! the process. Park audits are deduped by the same marker (verb `"park"`) so a
//! parked epic is logged once per distinct state, never once per 3s tick.
//!
//! ## Kill switch + per-epic flag (both gate the driver)
//!
//! The persisted kill switch (I8/§5) is a TRUE halt: `drive_epic` returns at the
//! top, before each ticket fire, and before the epic action. The per-epic
//! `autopilot_enabled` flag is re-read the SAME way, so a mid-pass disable stops
//! the NEXT gate within one pass. There is NO auto-resume — the FE re-arms both
//! explicitly.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use parking_lot::Mutex as SyncMutex;
use tokio::sync::{broadcast, Mutex as TokioMutex};

use crate::commands::board::{integrate_parent_inner, BoardCmdError};
use crate::commands::review::{request_review_inner, ReviewRecord, ReviewState};
use crate::commands::validate::run_and_persist_validate;
use crate::domain::{Workspace, WorkspaceContract, WorkspaceDependency, WorkspaceKind, WorkspaceStatus};
use crate::git;
use crate::pty::TaskRuntime;
use crate::store::{AutopilotStateRepo, BoardRepo, RepositoryRepo, RunCommandRepo, WorkspaceRepo};
use crate::tickets::{
    add_comment, read_gate_file, ticket_dir, GateFile, LastEditedBy, TicketWriteRegistry,
};

use super::super::liveness::{classify, DerivedState, LivenessThresholds};
use super::policy::{
    next_auto_action, next_epic_action, AutoAction, EpicAction, EpicGateState, ReviewLadderState,
    ReviewSnapshot, SafeVerb, StopReason, TicketGateState, TicketState, ValidateSnapshot,
};
use crate::orchestrator::{run_validate, BoardEventBus, RepoLockRegistry, SchedulerConfig, ValidateConfig};

/// The 3s belt-and-suspenders backstop cadence. Matches the scheduler's poll — it
/// must iterate ALL autopilot parents UNGATED by `has_work` (the post-work state
/// autopilot exists to finish), which the scheduler's own tick skips (§4).
const BACKSTOP_INTERVAL: Duration = Duration::from_secs(3);

/// Wall-clock ceiling on ONE driver-initiated Validate (§4 non-terminating-Validate
/// bound). A watcher/dev-server check that never returns must not wedge the epic's
/// Mutex forever — on elapse the driver treats it as a failed check and parks.
const VALIDATE_DEADLINE: Duration = Duration::from_secs(600);

/// The autopilot driver. One shared instance (managed state); its per-parent lock
/// map + the durable on-disk `last_fired` markers are consulted by BOTH the event
/// path and the 3s backstop path.
pub struct AutopilotDriver {
    workspaces: WorkspaceRepo,
    board: BoardRepo,
    repositories: RepositoryRepo,
    run_commands: RunCommandRepo,
    repo_locks: Arc<RepoLockRegistry>,
    write_registry: Arc<TicketWriteRegistry>,
    board_events: Arc<BoardEventBus>,
    autopilot_state: AutopilotStateRepo,
    /// The PTY runtime — read (never mutated) to derive each producer's honest
    /// liveness for the I3 layer (`runtime.get(id).last_activity_ms()`).
    runtime: Arc<TaskRuntime>,
    scheduler_config: SchedulerConfig,
    validate_config: ValidateConfig,
    thresholds: LivenessThresholds,
    validate_deadline: Duration,
    backstop_interval: Duration,
    /// Per-parent async serializer (the MANDATORY Mutex, §4): held across the whole
    /// read→compute→fire→settle span so a second caller always re-reads
    /// post-mutation state. Cross-epic drives run in parallel.
    parent_locks: SyncMutex<HashMap<String, Arc<TokioMutex<()>>>>,
}

impl AutopilotDriver {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        workspaces: WorkspaceRepo,
        board: BoardRepo,
        repositories: RepositoryRepo,
        run_commands: RunCommandRepo,
        repo_locks: Arc<RepoLockRegistry>,
        write_registry: Arc<TicketWriteRegistry>,
        board_events: Arc<BoardEventBus>,
        autopilot_state: AutopilotStateRepo,
        runtime: Arc<TaskRuntime>,
    ) -> Self {
        Self {
            workspaces,
            board,
            repositories,
            run_commands,
            repo_locks,
            write_registry,
            board_events,
            autopilot_state,
            runtime,
            scheduler_config: SchedulerConfig::default(),
            validate_config: ValidateConfig::default(),
            thresholds: LivenessThresholds::default(),
            validate_deadline: VALIDATE_DEADLINE,
            backstop_interval: BACKSTOP_INTERVAL,
            parent_locks: SyncMutex::new(HashMap::new()),
        }
    }

    /// Inject test configs (a tempdir contract root so a composed
    /// `publish_contract` never writes to the developer's real `~/.phasr`, a short
    /// validate timeout, tiny liveness thresholds). Prod uses the defaults.
    #[cfg(test)]
    fn with_test_config(
        mut self,
        scheduler_config: SchedulerConfig,
        validate_config: ValidateConfig,
        thresholds: LivenessThresholds,
        validate_deadline: Duration,
    ) -> Self {
        self.scheduler_config = scheduler_config;
        self.validate_config = validate_config;
        self.thresholds = thresholds;
        self.validate_deadline = validate_deadline;
        self
    }

    // ── trigger wiring (event + 3s backstop + boot sweep) ────────────────────

    /// Start the three trigger paths (spec §4). All three funnel into the one
    /// idempotent, kill-gated `drive_epic`; concurrency is made safe by the
    /// per-parent Mutex + durable dedup. Called once from
    /// `TaskOrchestrator::spawn_autopilot_driver`.
    pub fn spawn(self: Arc<Self>) {
        // Boot sweep: drive each autopilot epic ONCE at startup so an all-idle
        // (all-approved overnight, machine rebooted) epic still advances even
        // though no restored row fires a `board-changed` at boot (§4).
        let boot = self.clone();
        tokio::spawn(async move {
            boot.sweep_all().await;
        });

        // 3s backstop: iterate ALL autopilot parents every tick, UNGATED by
        // `has_work` — that guard skips exactly the post-work state autopilot
        // finishes (§4 / Open Decision A).
        let backstop = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(backstop.backstop_interval);
            loop {
                interval.tick().await;
                backstop.sweep_all().await;
            }
        });

        // Event path (low latency): each `board-changed` drives that specific
        // epic, so a driver-fired step's own `notify` advances the next gate.
        let events = self.clone();
        let mut rx = self.board_events.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => events.drive_epic(&ev.parent_id).await,
                    // A dropped burst is covered by the 3s backstop — never fatal.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// Drive every `autopilot_enabled` epic once. Shared by the boot sweep and the
    /// 3s backstop (both do the same UNGATED-by-`has_work` pass). Kill-gated up
    /// front (a cheap early-out; `drive_epic` re-checks per epic anyway).
    pub async fn sweep_all(&self) {
        if self.is_halted().await {
            return;
        }
        let parents = self.workspaces.list_parents().await.unwrap_or_default();
        for parent in parents {
            if parent.autopilot_enabled {
                self.drive_epic(&parent.id).await;
            }
        }
    }

    // ── the heart ────────────────────────────────────────────────────────────

    /// Advance ONE epic's gate ladder by (at most) one step per ticket + the epic
    /// gate. Idempotent, kill-gated, serialized per-parent, durably deduped.
    pub async fn drive_epic(&self, parent_id: &str) {
        // Kill-gate at the very top (I8/§5): a persisted halt no-ops the driver.
        if self.is_halted().await {
            return;
        }

        // Per-parent async Mutex — held across the ENTIRE read→compute→fire→settle
        // span so the event path and the 3s backstop can't interleave a
        // read-then-fire TOCTOU (§4). Cross-epic drives still run in parallel.
        let lock = self.parent_lock(parent_id);
        let _guard = lock.lock().await;

        let Ok(parent) = self.workspaces.get(parent_id).await else {
            return; // deleted / gone — nothing to drive.
        };
        if parent.workspace_kind != WorkspaceKind::Parent {
            return;
        }
        // Re-read the per-epic flag FRESH (a disabled epic fires nothing).
        if !parent.autopilot_enabled {
            return;
        }
        // Resolve the owner — a legible audited no-op for an ownerless row, never a
        // swallowed error (§4).
        let Some(user_id) = self.owner_or_audit(&parent).await else {
            return;
        };
        // Resolve the repo checkout, where the gate / marker / audit files live.
        let Some(repo_root) = self.repo_root(&parent.repository_id).await else {
            return;
        };

        // Owner-scoped board reads.
        let subtasks = match self.workspaces.list_by_parent_for_user(parent_id, &user_id).await {
            Ok(s) => s,
            Err(_) => return,
        };
        let deps = self.board.list_dependencies(parent_id).await.unwrap_or_default();
        let contracts = self.board.list_contracts(parent_id).await.unwrap_or_default();
        let checks_configured = self.checks_configured(&parent.repository_id, &user_id).await;
        let now_ms = Utc::now().timestamp_millis();

        // ── ticket ladder ──
        for subtask in &subtasks {
            // Re-check kill + per-epic flag each iteration so a mid-pass disable /
            // halt stops the NEXT fire within this pass (§4).
            if self.is_halted().await || !self.autopilot_still_on(parent_id).await {
                return;
            }

            let review = read_review(&repo_root, &subtask.id);
            let validate = read_validate(&repo_root, &subtask.id);
            // The I3 liveness layer lives HERE (not in the parity-tested ladder):
            // derive the ticket's board-card state from real PTY liveness + contract
            // publication + the review file.
            let state = self.derive_ticket_state(
                subtask,
                &contracts,
                &deps,
                review.map(|r| r.state),
                now_ms,
            );
            let gate = TicketGateState {
                state,
                review,
                validate,
                checks_configured,
                blocked_on: Vec::new(),
            };
            let hash = gate.state_hash();

            match next_auto_action(&gate) {
                None => {}
                Some(AutoAction::Auto(verb)) => {
                    let key = fired_key(&subtask.id, verb.as_str());
                    if self.already_fired(&repo_root, parent_id, &key, hash) {
                        continue; // durable dedup: this exact state already fired.
                    }
                    self.fire_ticket(&repo_root, parent_id, &user_id, subtask, verb, &key, hash)
                        .await;
                }
                // Validate-failing has a durable one-bounce hop BEFORE the park (§4).
                Some(AutoAction::HumanStop(StopReason::ValidateFailing)) => {
                    self.handle_validate_failing(&repo_root, parent_id, subtask, validate, hash)
                        .await;
                }
                Some(AutoAction::HumanStop(reason)) => {
                    self.audit_park(&repo_root, parent_id, &subtask.id, reason, hash);
                }
            }
        }

        // ── epic ladder (RE-READ gate files fresh, never off the pre-loop snapshot) ──
        if self.is_halted().await || !self.autopilot_still_on(parent_id).await {
            return;
        }
        self.drive_epic_gate(&repo_root, &parent, &user_id, &subtasks)
            .await;
    }

    /// Fire a ticket-level AUTO gate (validate | request-review) by calling the
    /// SAME `_inner` the button/CLI calls (I5). Records the durable marker BEFORE
    /// settling, audits, and emits the driver's own `notify` (the `_inner`s emit
    /// none).
    async fn fire_ticket(
        &self,
        repo_root: &Path,
        parent_id: &str,
        user_id: &str,
        subtask: &Workspace,
        verb: SafeVerb,
        key: &str,
        hash: u64,
    ) {
        match verb {
            SafeVerb::Validate => {
                // Record BEFORE the run settles so a crash mid-validate can't
                // re-fire the same pre-validate state (§4). A pass/fail result then
                // changes the state_hash, so the next pass advances regardless.
                self.record_fired(repo_root, parent_id, key, hash);
                let run = tokio::time::timeout(
                    self.validate_deadline,
                    run_and_persist_validate(
                        subtask,
                        user_id,
                        &self.repositories,
                        &self.run_commands,
                        &self.write_registry,
                        &self.validate_config,
                    ),
                )
                .await;
                match run {
                    Ok(Ok(result)) => {
                        let failing = result.checks.iter().filter(|c| !c.passed).count();
                        let msg = if result.passed {
                            format!(
                                "ran Validate on {} — passed ({} checks)",
                                subtask.id,
                                result.checks.len()
                            )
                        } else {
                            format!(
                                "ran Validate on {} — {failing} of {} checks failing",
                                subtask.id,
                                result.checks.len()
                            )
                        };
                        self.audit(repo_root, parent_id, &msg);
                    }
                    // A non-terminating check hit the wall-clock ceiling → treat as
                    // a failed check + park (does not wedge the epic Mutex, §4).
                    Err(_elapsed) => self.audit(
                        repo_root,
                        parent_id,
                        &format!("parked {} — Validate timed out, needs you", subtask.id),
                    ),
                    Ok(Err(e)) => self.audit(
                        repo_root,
                        parent_id,
                        &format!("parked {} — Validate errored: {e}", subtask.id),
                    ),
                }
                self.board_events.notify(parent_id);
            }
            SafeVerb::RequestReview => {
                match request_review_inner(
                    subtask,
                    user_id,
                    // Attribution (G1/§8): an autopilot-fired gate is NEVER "you".
                    "autopilot",
                    &self.workspaces,
                    &self.board,
                    &self.repositories,
                    &self.write_registry,
                    &self.scheduler_config,
                )
                .await
                {
                    Ok(_) => {
                        self.record_fired(repo_root, parent_id, key, hash);
                        self.audit(
                            repo_root,
                            parent_id,
                            &format!("requested review on {}", subtask.id),
                        );
                    }
                    Err(e) => {
                        // A fire error is a durable STOP (record → no retry-storm on
                        // this exact state) + a park audit.
                        self.record_fired(repo_root, parent_id, key, hash);
                        self.audit(
                            repo_root,
                            parent_id,
                            &format!("parked {} — request-review failed: {e}", subtask.id),
                        );
                    }
                }
                self.board_events.notify(parent_id);
            }
            // Integrate is epic-only; a ticket ladder never yields it.
            SafeVerb::Integrate => {}
        }
    }

    /// The durable one-bounce validate-failure hop (§4 / Open Decision D). On a
    /// `validate.json` failure: if NOT already bounced for THIS `validate.at_ms`
    /// (durable marker `autopilot/bounced-<at_ms>` in the ticket folder) AND the
    /// producer is still `Running`, append ONE `"autopilot"`-authored bounce
    /// comment + write the marker; else HUMAN-STOP (deduped park). Restart-safe:
    /// the marker is on disk, so a crash never re-fires the bounce.
    async fn handle_validate_failing(
        &self,
        repo_root: &Path,
        parent_id: &str,
        subtask: &Workspace,
        validate: Option<ValidateSnapshot>,
        hash: u64,
    ) {
        let Some(v) = validate else {
            // No snapshot but policy said ValidateFailing — shouldn't happen; park.
            self.audit_park(repo_root, parent_id, &subtask.id, StopReason::ValidateFailing, hash);
            return;
        };

        // Already auto-bounced for THIS failing result, or the producer is no longer
        // live → HUMAN-STOP (never mask a red build, never bounce a dead agent).
        if bounce_marker_exists(repo_root, &subtask.id, v.at_ms)
            || subtask.status != WorkspaceStatus::Running
        {
            self.audit_park(repo_root, parent_id, &subtask.id, StopReason::ValidateFailing, hash);
            return;
        }

        // Bounce ONCE to the still-live producer: append the comment it reads on its
        // next step, then write the durable marker so this never re-fires.
        let body = format!(
            "Autopilot: Validate failed — {} check(s) failing. Please fix and re-run \
             `phasr validate`.",
            v.failing_count
        );
        // Authored by the autopilot AGENT, never the human `"you"` (honesty #29).
        match add_comment(repo_root, &subtask.id, "autopilot", LastEditedBy::Agent, &body) {
            Ok(_) => {
                write_bounce_marker(repo_root, &subtask.id, v.at_ms);
                self.audit(
                    repo_root,
                    parent_id,
                    &format!("auto-bounced {} — Validate failing (one bounce)", subtask.id),
                );
                self.board_events.notify(parent_id);
            }
            Err(e) => log::warn!("autopilot: failed to append bounce comment: {e}"),
        }
    }

    /// The epic gate after the ticket loop. RE-READS `review.json` fresh for the
    /// STRICT all-approved predicate (I7) and probes the integration worktree for a
    /// mid-merge (I2, top precedence). Only `Auto(Integrate)` fires; every
    /// `HumanStop` (Ship / mid-merge) is a deduped park.
    async fn drive_epic_gate(
        &self,
        repo_root: &Path,
        parent: &Workspace,
        user_id: &str,
        subtasks: &[Workspace],
    ) {
        let ticket_count = subtasks.len();
        // STRICT (I7): EVERY ticket `review=approved`, re-read FRESH.
        let all_approved = ticket_count >= 1
            && subtasks.iter().all(|s| {
                read_review(repo_root, &s.id)
                    .map(|r| r.state == ReviewLadderState::Approved)
                    .unwrap_or(false)
            });
        let estate = EpicGateState {
            ticket_count,
            all_approved,
            // TOP PRECEDENCE (I2): a mid-merge integration worktree is never
            // re-derived as integrable.
            merge_in_progress: self.parent_merge_in_progress(parent),
            // The parent carries an integration branch (set by a prior integrate).
            integrated: parent.branch.is_some(),
            // The durable Ship milestone (migration 0016, stamped by `ship_epic`
            // on a clean merge). A shipped epic derives to Nothing — the driver
            // stops parking it at Ship on every boot sweep. Pre-0016 epics
            // (shipped before the column existed) still park once at Ship; the
            // durable park dedup keeps that to exactly one audit line.
            shipped: parent.shipped_at.is_some(),
        };
        let hash = estate.state_hash();

        match next_epic_action(&estate) {
            None => {}
            Some(EpicAction::Auto(SafeVerb::Integrate)) => {
                let key = fired_key(&parent.id, "integrate");
                if self.already_fired(repo_root, &parent.id, &key, hash) {
                    return; // durable integrate dedup / STOP.
                }
                self.fire_integrate(repo_root, parent, user_id, &key, hash).await;
            }
            Some(EpicAction::Auto(_)) => {} // unreachable — the epic only auto-integrates.
            Some(EpicAction::HumanStop(reason)) => {
                self.audit_park(repo_root, &parent.id, &parent.id, reason, hash);
            }
        }
    }

    /// Fire the epic Integrate (I2/I7) via `integrate_parent_inner` (the promoted
    /// `pub(crate)` — one code path, I5). On any `Err` (conflict, pre-existing
    /// mid-merge, or anything else) → durable HUMAN-STOP + audit + NO retry. A clean
    /// integration gets a post-integrate re-validate on the integration worktree.
    async fn fire_integrate(
        &self,
        repo_root: &Path,
        parent: &Workspace,
        user_id: &str,
        key: &str,
        hash: u64,
    ) {
        match integrate_parent_inner(
            &parent.id,
            user_id,
            &self.workspaces,
            &self.board,
            &self.repositories,
            &self.repo_locks,
        )
        .await
        {
            Ok(board) => {
                self.record_fired(repo_root, &parent.id, key, hash);
                self.audit(
                    repo_root,
                    &parent.id,
                    &format!("integrated {} tickets", board.subtasks.len()),
                );
                // Post-integrate re-validate on the integration worktree: a clean
                // merge that then fails checks HUMAN-STOPs ("integrated but checks
                // fail") instead of parking at Ship.
                self.post_integrate_revalidate(repo_root, &board.parent, user_id)
                    .await;
                self.board_events.notify(&parent.id);
            }
            Err(BoardCmdError::IntegrationConflict { files }) => {
                // Durable STOP: record the pre-fire state_hash so the 3s backstop
                // can't re-fire integrate; the parent is left mid-merge for the
                // existing interactive resolver, and `merge_in_progress` becomes a
                // top-precedence HumanStop on the next pass (I2). NO retry.
                self.record_fired(repo_root, &parent.id, key, hash);
                self.audit(
                    repo_root,
                    &parent.id,
                    &format!("stopped — integration conflict in {}", files.join(", ")),
                );
                self.board_events.notify(&parent.id);
            }
            Err(e) => {
                // Any other Err (a pre-existing mid-merge refusal, a git/lock/cycle
                // failure) → durable HUMAN-STOP + NO retry every tick (backoff).
                self.record_fired(repo_root, &parent.id, key, hash);
                self.audit(
                    repo_root,
                    &parent.id,
                    &format!("integration failed — needs you: {e}"),
                );
                self.board_events.notify(&parent.id);
            }
        }
    }

    /// Re-validate the integration worktree after a clean integrate. On a failing
    /// check → audit "integrated but checks fail" (the FE renders the HUMAN-STOP
    /// instead of offering Ship). No checks configured → nothing to re-validate.
    async fn post_integrate_revalidate(&self, repo_root: &Path, parent: &Workspace, user_id: &str) {
        let Some(worktree) = parent.worktree_path.as_deref() else {
            return;
        };
        let checks = self.checks(&parent.repository_id, user_id).await;
        if checks.is_empty() {
            return;
        }
        let result = run_validate(&parent.id, Path::new(worktree), &checks, &self.validate_config).await;
        if !result.passed {
            self.audit(
                repo_root,
                &parent.id,
                "integrated but checks fail — needs you (not offering Ship)",
            );
        }
    }

    // ── I3 liveness layer + board-state derivation (mirrors deriveBoardState.ts) ──

    /// Derive a ticket's board-card `TicketState` from the honest agent liveness +
    /// contract publication + `review.json`, mirroring the FE `deriveBoardState`
    /// precedence. This is the **I3 liveness layer** (kept OUT of the parity-tested
    /// pure ladder, spec §I3 note): a `needs-review`/`in-review`/`approved` ticket
    /// is past-work and advances even if its producer PTY is idle-alive; only a
    /// still-producing (`working`/`idle` with no contract) or unhealthy
    /// (`wedged`/`failed`) ticket is held/parked.
    fn derive_ticket_state(
        &self,
        subtask: &Workspace,
        contracts: &[WorkspaceContract],
        deps: &[WorkspaceDependency],
        review: Option<ReviewLadderState>,
        now_ms: i64,
    ) -> TicketState {
        // 0. The review decision layers over everything (a file, never a status).
        //    Approved = the ticket-level terminal state (FE Done lane). Policy
        //    output is unchanged — `next_auto_action` short-circuits on the raw
        //    `review=approved` before consulting the state — but the persisted
        //    `state_hash` for an approved ticket changes ("needs-review" →
        //    "done"), so one already-parked epic may re-log a single audit line
        //    after upgrade.
        match review {
            Some(ReviewLadderState::Requested) => return TicketState::InReview,
            Some(ReviewLadderState::ChangesRequested) => return TicketState::QasChangesRequested,
            Some(ReviewLadderState::Approved) => return TicketState::Done,
            None => {}
        }
        // 1. A published contract is the strongest "finished its job" signal — past
        //    work, ready for the gates regardless of whether the PTY is still up.
        if has_published_contract(&subtask.id, contracts) {
            return TicketState::NeedsReview;
        }
        // The honest liveness of the producer (the actual I3 read).
        let live = self.derive_agent_state(subtask, now_ms);
        // 2. A cleanly-exited producer is also ready for review.
        if matches!(live, DerivedState::Done) {
            return TicketState::NeedsReview;
        }
        // 3. A pending consumer whose producer hasn't published is blocked.
        if subtask.status == WorkspaceStatus::Pending && is_blocked(subtask, deps, contracts) {
            return TicketState::Blocked;
        }
        // 4. Otherwise the honest liveness state.
        match live {
            DerivedState::Working => TicketState::Working,
            DerivedState::Idle => TicketState::Idle,
            DerivedState::Wedged => TicketState::Wedged,
            DerivedState::Failed => TicketState::Failed,
            DerivedState::Done => TicketState::NeedsReview, // handled at step 2.
        }
    }

    /// The producer's honest `DerivedState`, mirroring `deriveAgentState.ts`. For a
    /// `Running` row it reads the real PTY activity stamp through the runtime and
    /// classifies it (a running row with NO live handle is an orphan → `Wedged`,
    /// never a confident `Working`).
    fn derive_agent_state(&self, subtask: &Workspace, now_ms: i64) -> DerivedState {
        match subtask.status {
            WorkspaceStatus::Completed => {
                if subtask.exit_code.map(|c| c != 0).unwrap_or(false) {
                    DerivedState::Failed
                } else {
                    DerivedState::Done
                }
            }
            WorkspaceStatus::Failed => DerivedState::Failed,
            WorkspaceStatus::Running => {
                let (has_handle, last_ms) = match self.runtime.get(&subtask.id) {
                    Some(handle) => (true, handle.last_activity_ms()),
                    None => (false, now_ms),
                };
                let elapsed = Duration::from_millis((now_ms - last_ms).max(0) as u64);
                classify(elapsed, has_handle, &self.thresholds)
            }
            // A relaunch orphan (recovery set `interrupted_at`) is honest-Wedged; a
            // calm user-stop / pending / archived isn't producing and isn't past
            // work → Idle (the policy leaves it alone, never fires).
            WorkspaceStatus::Stopped => {
                if subtask.interrupted_at.is_some() {
                    DerivedState::Wedged
                } else {
                    DerivedState::Idle
                }
            }
            WorkspaceStatus::Pending | WorkspaceStatus::Archived => DerivedState::Idle,
        }
    }

    // ── small async helpers ──────────────────────────────────────────────────

    async fn is_halted(&self) -> bool {
        // A read error must not silently un-halt a panicked founder — but the repo
        // returns `false` only on a genuinely-absent row (never wedges), so
        // `unwrap_or(false)` is the same honest default the repo already uses.
        self.autopilot_state.kill_switch_halted().await.unwrap_or(false)
    }

    async fn autopilot_still_on(&self, parent_id: &str) -> bool {
        self.workspaces
            .get(parent_id)
            .await
            .map(|p| p.autopilot_enabled)
            .unwrap_or(false)
    }

    async fn owner_or_audit(&self, parent: &Workspace) -> Option<String> {
        match self.workspaces.owner_id(&parent.id).await {
            Ok(Some(uid)) => Some(uid),
            _ => {
                // A legible no-op + audit, never a swallowed error (§4).
                if let Some(root) = self.repo_root(&parent.repository_id).await {
                    self.audit(
                        &root,
                        &parent.id,
                        "could not resolve epic owner — autopilot no-op",
                    );
                }
                None
            }
        }
    }

    async fn repo_root(&self, repository_id: &str) -> Option<PathBuf> {
        self.repositories
            .get(repository_id)
            .await
            .ok()
            .and_then(|r| r.local_path.map(PathBuf::from))
    }

    /// The opted-in Validate checks for a repo (`run_in_validate`), owner-scoped.
    async fn checks(&self, repository_id: &str, user_id: &str) -> Vec<(String, String)> {
        self.run_commands
            .list_by_repository_for_user(repository_id, user_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|rc| rc.run_in_validate)
            .map(|rc| (rc.name, rc.command))
            .collect()
    }

    async fn checks_configured(&self, repository_id: &str, user_id: &str) -> bool {
        !self.checks(repository_id, user_id).await.is_empty()
    }

    fn parent_merge_in_progress(&self, parent: &Workspace) -> bool {
        let Some(worktree) = parent.worktree_path.as_deref() else {
            return false;
        };
        let worktree = Path::new(worktree);
        if !worktree.exists() {
            return false;
        }
        !matches!(
            git::merge_in_progress(worktree).unwrap_or(git::InProgress::None),
            git::InProgress::None
        )
    }

    fn parent_lock(&self, parent_id: &str) -> Arc<TokioMutex<()>> {
        let mut map = self.parent_locks.lock();
        if let Some(existing) = map.get(parent_id) {
            return existing.clone();
        }
        let lock = Arc::new(TokioMutex::new(()));
        map.insert(parent_id.to_string(), lock.clone());
        lock
    }

    // ── durable last-fired + audit ─────────────────────────────────────────────

    fn already_fired(&self, repo_root: &Path, parent_id: &str, key: &str, hash: u64) -> bool {
        read_fired_map(repo_root, parent_id).get(key) == Some(&hash)
    }

    /// Persist the fire marker (§4: "record BEFORE releasing — never mid-flight").
    /// Best-effort but LOGGED — a write failure is surfaced, never silently
    /// dropped (a lost marker could double-fire, so it is a real signal).
    fn record_fired(&self, repo_root: &Path, parent_id: &str, key: &str, hash: u64) {
        let mut map = read_fired_map(repo_root, parent_id);
        map.insert(key.to_string(), hash);
        if let Err(e) = write_fired_map(repo_root, parent_id, &map) {
            log::error!("autopilot: failed to persist last-fired marker for {parent_id}: {e}");
        }
    }

    /// Audit a PARK, deduped by `(entity, "park", state_hash)` so a parked
    /// ticket/epic is logged ONCE per distinct state, never once per 3s backstop
    /// tick. Restart-safe (the dedup marker is on disk).
    fn audit_park(
        &self,
        repo_root: &Path,
        parent_id: &str,
        entity_id: &str,
        reason: StopReason,
        hash: u64,
    ) {
        let key = fired_key(entity_id, "park");
        if self.already_fired(repo_root, parent_id, &key, hash) {
            return;
        }
        self.record_fired(repo_root, parent_id, &key, hash);
        self.audit(
            repo_root,
            parent_id,
            &format!("parked {entity_id} — {}", reason.message()),
        );
    }

    /// Append one `"autopilot"`-authored line to `.phasr/autopilot/<parent_id>.log`
    /// (S6). Best-effort but LOGGED — a failed audit write is surfaced, never
    /// silently dropped, and NEVER blocks the mutation it records.
    fn audit(&self, repo_root: &Path, parent_id: &str, message: &str) {
        append_audit(repo_root, parent_id, message);
    }
}

// ── free helpers (pure / fs — no &self state) ─────────────────────────────────

fn fired_key(entity_id: &str, verb: &str) -> String {
    format!("{entity_id}|{verb}")
}

fn has_published_contract(subtask_id: &str, contracts: &[WorkspaceContract]) -> bool {
    contracts
        .iter()
        .any(|c| c.subtask_id == subtask_id && c.published_at.is_some())
}

/// A consumer with ANY incoming edge whose producer has not published a contract
/// is blocked (mirrors `deriveBoardState.ts::isBlocked`; the caller gates on the
/// `pending` status, matching the FE precedence).
fn is_blocked(
    subtask: &Workspace,
    deps: &[WorkspaceDependency],
    contracts: &[WorkspaceContract],
) -> bool {
    let incoming: Vec<&WorkspaceDependency> =
        deps.iter().filter(|d| d.to_subtask_id == subtask.id).collect();
    if incoming.is_empty() {
        return false;
    }
    incoming
        .iter()
        .any(|edge| !has_published_contract(&edge.from_subtask_id, contracts))
}

/// Read a ticket's `review.json` → the ladder slice the policy branches on.
/// Tolerant: a missing / corrupt file reads as "no review".
fn read_review(repo_root: &Path, ticket_id: &str) -> Option<ReviewSnapshot> {
    let raw = read_gate_file(repo_root, ticket_id, GateFile::Review).ok().flatten()?;
    let record: ReviewRecord = serde_json::from_str(&raw).ok()?;
    Some(ReviewSnapshot {
        state: review_to_ladder(record.state),
        at_ms: record.at_ms,
    })
}

/// Read a ticket's `validate.json` → the ladder slice the policy branches on.
/// Tolerant: a missing / corrupt file reads as "never validated".
fn read_validate(repo_root: &Path, ticket_id: &str) -> Option<ValidateSnapshot> {
    let raw = read_gate_file(repo_root, ticket_id, GateFile::Validate).ok().flatten()?;
    let result: crate::orchestrator::ValidateResult = serde_json::from_str(&raw).ok()?;
    let failing = result.checks.iter().filter(|c| !c.passed).count();
    Some(ValidateSnapshot {
        passed: result.passed,
        at_ms: result.ran_at_ms,
        failing_count: failing,
    })
}

fn review_to_ladder(state: ReviewState) -> ReviewLadderState {
    match state {
        ReviewState::Requested => ReviewLadderState::Requested,
        ReviewState::Approved => ReviewLadderState::Approved,
        ReviewState::ChangesRequested => ReviewLadderState::ChangesRequested,
    }
}

// ── the on-disk `.phasr/autopilot/` audit + durable markers ───────────────────

fn autopilot_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".phasr").join("autopilot")
}

fn fired_map_path(repo_root: &Path, parent_id: &str) -> PathBuf {
    autopilot_dir(repo_root).join(format!("{parent_id}.fired.json"))
}

/// Read the durable `(key → state_hash)` fire map for a parent. Tolerant: a
/// missing / corrupt file reads as an empty map (nothing has fired yet).
fn read_fired_map(repo_root: &Path, parent_id: &str) -> HashMap<String, u64> {
    let raw = std::fs::read_to_string(fired_map_path(repo_root, parent_id)).unwrap_or_default();
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_fired_map(
    repo_root: &Path,
    parent_id: &str,
    map: &HashMap<String, u64>,
) -> std::io::Result<()> {
    let dir = autopilot_dir(repo_root);
    std::fs::create_dir_all(&dir)?;
    let bytes = serde_json::to_vec_pretty(map)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    // tmp-then-rename so a reader never sees a partial map.
    let path = fired_map_path(repo_root, parent_id);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    std::fs::rename(&tmp, &path)
}

/// The durable per-failure bounce marker in the ticket folder:
/// `.phasr/tickets/<id>/autopilot/bounced-<validate.at_ms>`. Its existence means
/// "already auto-bounced for THIS failing validate result" (restart-safe).
fn bounce_marker_path(repo_root: &Path, ticket_id: &str, at_ms: i64) -> Option<PathBuf> {
    ticket_dir(repo_root, ticket_id)
        .ok()
        .map(|dir| dir.join("autopilot").join(format!("bounced-{at_ms}")))
}

fn bounce_marker_exists(repo_root: &Path, ticket_id: &str, at_ms: i64) -> bool {
    bounce_marker_path(repo_root, ticket_id, at_ms)
        .map(|p| p.exists())
        .unwrap_or(false)
}

fn write_bounce_marker(repo_root: &Path, ticket_id: &str, at_ms: i64) {
    let Some(path) = bounce_marker_path(repo_root, ticket_id, at_ms) else {
        return;
    };
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            log::error!("autopilot: failed to create bounce-marker dir: {e}");
            return;
        }
    }
    if let Err(e) = std::fs::write(&path, b"") {
        log::error!("autopilot: failed to write bounce marker: {e}");
    }
}

/// Append one `"autopilot"`-authored record to `.phasr/autopilot/<parent_id>.log`
/// (S6). Best-effort but logged; never blocks the mutation it records.
fn append_audit(repo_root: &Path, parent_id: &str, message: &str) {
    let dir = autopilot_dir(repo_root);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("autopilot: failed to create audit dir: {e}");
        return;
    }
    let line = format!("{}\tautopilot\t{}\n", Utc::now().to_rfc3339(), message);
    let path = dir.join(format!("{parent_id}.log"));
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(line.as_bytes()) {
                log::warn!("autopilot: failed to append audit line: {e}");
            }
        }
        Err(e) => log::warn!("autopilot: failed to open audit log: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::review::{resolve_review_inner, ReviewDecision, ReviewRecord, ReviewState};
    use crate::domain::{Repository, RunCommand};
    use crate::orchestrator::{ValidateCheck, ValidateResult};
    use crate::store::{init_pool, Db};
    use crate::tickets::{list_comments, write_gate_file};
    use std::process::Command;

    // ── fixtures ─────────────────────────────────────────────────────────────

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

    /// Build a driver over an existing pool + a tempdir for the (test-injected)
    /// contract root, validate config, tiny thresholds, and PTY log dir. Rebuildable
    /// from the SAME pool so a test can prove restart-safety with a fresh instance
    /// (durable markers live on disk, not in the driver).
    fn build_driver(pool: &Db, contract_root: PathBuf, log_dir: PathBuf) -> AutopilotDriver {
        let scheduler_config = SchedulerConfig {
            contract_root,
            ..SchedulerConfig::default()
        };
        let validate_config = ValidateConfig {
            shell: "/bin/sh".into(),
            timeout: Duration::from_secs(5),
        };
        let thresholds = LivenessThresholds {
            idle: Duration::from_secs(60),
            wedged: Duration::from_secs(180),
        };
        AutopilotDriver::new(
            WorkspaceRepo::new(pool.clone()),
            BoardRepo::new(pool.clone()),
            RepositoryRepo::new(pool.clone()),
            RunCommandRepo::new(pool.clone()),
            Arc::new(RepoLockRegistry::new()),
            Arc::new(TicketWriteRegistry::default()),
            Arc::new(BoardEventBus::new()),
            AutopilotStateRepo::new(pool.clone()),
            Arc::new(TaskRuntime::new(log_dir)),
        )
        .with_test_config(
            scheduler_config,
            validate_config,
            thresholds,
            Duration::from_secs(5),
        )
    }

    /// A repo with a plain on-disk checkout (no git) — enough for the gate-file /
    /// audit / dedup paths that never touch git.
    async fn plain_repo(tmp: &Path, pool: &Db) -> (Repository, PathBuf) {
        let checkout = tmp.join("checkout");
        std::fs::create_dir_all(&checkout).unwrap();
        let repo = Repository::new(
            "repo".into(),
            Some(checkout.to_string_lossy().into_owned()),
            None,
        );
        RepositoryRepo::new(pool.clone())
            .insert_for_user(&repo, "user-a")
            .await
            .unwrap();
        (repo, checkout)
    }

    /// A real one-commit git repo on `main` (for the integrate paths). Mirrors the
    /// scaffolding in `commands/board.rs` tests.
    async fn git_repo(tmp: &Path, pool: &Db) -> (Repository, PathBuf) {
        let repo_dir = tmp.join("repo");
        std::fs::create_dir_all(&repo_dir).unwrap();
        for args in [
            vec!["init", "-q", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "tester"],
            vec!["config", "commit.gpgsign", "false"],
        ] {
            Command::new("git").args(&args).current_dir(&repo_dir).status().unwrap();
        }
        std::fs::write(repo_dir.join("README.md"), "hi\n").unwrap();
        Command::new("git").args(["add", "-A"]).current_dir(&repo_dir).status().unwrap();
        Command::new("git").args(["commit", "-qm", "init"]).current_dir(&repo_dir).status().unwrap();

        let mut repo = Repository::new(
            "epic-repo".into(),
            Some(repo_dir.to_string_lossy().into_owned()),
            None,
        );
        repo.default_branch = "main".into();
        RepositoryRepo::new(pool.clone())
            .insert_for_user(&repo, "user-a")
            .await
            .unwrap();
        (repo, repo_dir)
    }

    fn commit_on_branch(repo: &Path, branch: &str, file: &str, contents: &str, msg: &str) {
        Command::new("git").args(["checkout", "-q", "-b", branch, "main"]).current_dir(repo).status().unwrap();
        std::fs::write(repo.join(file), contents).unwrap();
        Command::new("git").args(["add", "-A"]).current_dir(repo).status().unwrap();
        Command::new("git").args(["commit", "-qm", msg]).current_dir(repo).status().unwrap();
        Command::new("git").args(["checkout", "-q", "main"]).current_dir(repo).status().unwrap();
    }

    async fn insert_epic(pool: &Db, repo_id: &str, autopilot: bool) -> Workspace {
        let mut parent = Workspace::new(repo_id.into(), "epic".into(), String::new());
        parent.workspace_kind = WorkspaceKind::Parent;
        parent.autopilot_enabled = autopilot;
        WorkspaceRepo::new(pool.clone())
            .insert_for_user(&parent, "user-a")
            .await
            .unwrap();
        parent
    }

    async fn insert_subtask(
        pool: &Db,
        repo_id: &str,
        parent_id: &str,
        role: &str,
        status: WorkspaceStatus,
        branch: Option<&str>,
    ) -> Workspace {
        let mut s = Workspace::new(repo_id.into(), role.into(), "cmd".into());
        s.workspace_kind = WorkspaceKind::Subtask;
        s.parent_id = Some(parent_id.into());
        s.role = Some(role.into());
        s.status = status;
        s.branch = branch.map(String::from);
        if status == WorkspaceStatus::Completed {
            s.exit_code = Some(0);
        }
        WorkspaceRepo::new(pool.clone())
            .insert_for_user(&s, "user-a")
            .await
            .unwrap();
        s
    }

    async fn add_edge(pool: &Db, parent_id: &str, from: &str, to: &str) {
        BoardRepo::new(pool.clone())
            .insert_dependency(&WorkspaceDependency::new(parent_id.into(), from.into(), to.into()))
            .await
            .unwrap();
    }

    async fn publish_contract(pool: &Db, parent_id: &str, subtask_id: &str, role: &str) {
        let mut c = WorkspaceContract::new(parent_id.into(), subtask_id.into(), role.into(), "x.md".into());
        c.published_at = Some(Utc::now());
        BoardRepo::new(pool.clone()).insert_contract(&c).await.unwrap();
    }

    fn write_review(repo_root: &Path, ticket_id: &str, state: ReviewState) {
        let record = ReviewRecord {
            subtask_id: ticket_id.into(),
            state,
            by: "you".into(),
            comment: None,
            at_ms: 1,
            validate_passed: true,
        };
        let bytes = serde_json::to_vec_pretty(&record).unwrap();
        write_gate_file(&TicketWriteRegistry::default(), repo_root, ticket_id, GateFile::Review, &bytes).unwrap();
    }

    fn write_validate(repo_root: &Path, ticket_id: &str, passed: bool, at_ms: i64) {
        let result = ValidateResult {
            subtask_id: ticket_id.into(),
            checks: vec![ValidateCheck {
                name: "test".into(),
                command: "exit 1".into(),
                passed,
                exit_code: Some(if passed { 0 } else { 1 }),
                tail_output: "boom".into(),
            }],
            passed,
            ran_at_ms: at_ms,
        };
        let bytes = serde_json::to_vec_pretty(&result).unwrap();
        write_gate_file(&TicketWriteRegistry::default(), repo_root, ticket_id, GateFile::Validate, &bytes).unwrap();
    }

    async fn add_validate_check(pool: &Db, repo_id: &str) {
        let mut rc = RunCommand::new(repo_id.into(), "test".into(), "exit 1".into());
        rc.run_in_validate = true;
        RunCommandRepo::new(pool.clone()).insert_for_user(&rc, "user-a").await.unwrap();
    }

    fn read_audit(repo_root: &Path, parent_id: &str) -> String {
        std::fs::read_to_string(
            repo_root.join(".phasr").join("autopilot").join(format!("{parent_id}.log")),
        )
        .unwrap_or_default()
    }

    fn audit_count(log: &str, needle: &str) -> usize {
        log.lines().filter(|l| l.contains(needle)).count()
    }

    fn review_author(repo_root: &Path, ticket_id: &str) -> Option<String> {
        let raw = read_gate_file(repo_root, ticket_id, GateFile::Review).ok().flatten()?;
        serde_json::from_str::<ReviewRecord>(&raw).ok().map(|r| r.by)
    }

    fn cleanup_integration(repo_path: &Path, parent_id: &str, parent_name: &str) {
        let worktree = git::default_worktree_base_path().join(parent_id);
        let _ = git::merge_abort(&worktree);
        let _ = git::remove_worktree(repo_path, &worktree);
        let short = git::short_id(parent_id);
        let branch = git::default_branch_name(
            &format!("integration/{}-{}", git::slugify(parent_name), short),
            short,
        );
        let _ = git::branch_delete(repo_path, &branch);
    }

    // ── S4: durable dedup + loop termination + attribution ───────────────────

    // A `needs-review` ticket (cleanly `done`, no checks) auto-advances ONCE to
    // request-review, then PARKS at the human Approve gate — and re-driving the
    // epic forever fires nothing more. This is the durable-dedup loop-termination
    // trace: the fire→notify→drive chain is a bounded walk that halts at the first
    // HumanStop, with each gate fired exactly once (recorded on disk).
    #[tokio::test]
    async fn durable_dedup_terminates_the_ladder_at_the_human_gate() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, checkout) = plain_repo(tmp.path(), &pool).await;
        let parent = insert_epic(&pool, &repo.id, true).await;
        // A lone, cleanly-exited ticket → derives to needs-review, no checks.
        let ticket = insert_subtask(&pool, &repo.id, &parent.id, "frontend", WorkspaceStatus::Completed, None).await;

        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));

        // Drive many times — far more than the ladder is long.
        for _ in 0..10 {
            driver.drive_epic(&parent.id).await;
        }

        // request-review fired EXACTLY once, attributed to autopilot (never "you").
        assert_eq!(review_author(&checkout, &ticket.id).as_deref(), Some("autopilot"));
        let log = read_audit(&checkout, &parent.id);
        assert_eq!(
            audit_count(&log, "requested review"),
            1,
            "request-review must fire exactly once across 10 drives (durable dedup)"
        );
        // …then it PARKS at the human Approve gate, audited exactly once (deduped).
        assert_eq!(
            audit_count(&log, "Needs you: review"),
            1,
            "the park must be audited once per state, not once per drive"
        );
        // The durable marker records the single request-review fire.
        let fired = read_fired_map(&checkout, &parent.id);
        assert!(fired.keys().any(|k| k.ends_with("|request-review")));
    }

    // The kill switch is a TRUE halt: while set, `drive_epic` returns at the top and
    // fires NOTHING; un-halting lets the same epic advance.
    #[tokio::test]
    async fn kill_switch_gates_the_driver() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, checkout) = plain_repo(tmp.path(), &pool).await;
        let parent = insert_epic(&pool, &repo.id, true).await;
        let ticket = insert_subtask(&pool, &repo.id, &parent.id, "frontend", WorkspaceStatus::Completed, None).await;

        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));

        // HALTED → nothing fires.
        AutopilotStateRepo::new(pool.clone()).set_kill_switch(true).await.unwrap();
        driver.drive_epic(&parent.id).await;
        assert!(review_author(&checkout, &ticket.id).is_none(), "a halted driver fires no gate");
        assert!(read_audit(&checkout, &parent.id).is_empty(), "a halted driver writes no audit");

        // Un-halted → the same epic advances.
        AutopilotStateRepo::new(pool.clone()).set_kill_switch(false).await.unwrap();
        driver.drive_epic(&parent.id).await;
        assert_eq!(review_author(&checkout, &ticket.id).as_deref(), Some("autopilot"));
    }

    // The per-epic flag also gates: an epic with `autopilot_enabled = false` never
    // advances even when nothing else stops it.
    #[tokio::test]
    async fn per_epic_flag_off_fires_nothing() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, checkout) = plain_repo(tmp.path(), &pool).await;
        let parent = insert_epic(&pool, &repo.id, false).await; // OFF
        let ticket = insert_subtask(&pool, &repo.id, &parent.id, "frontend", WorkspaceStatus::Completed, None).await;

        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));
        driver.drive_epic(&parent.id).await;
        assert!(review_author(&checkout, &ticket.id).is_none());
    }

    // ── S4: validate-failure durable one-bounce (restart-safe) ───────────────

    // A ticket with a published contract + a FAILED validate.json auto-bounces
    // EXACTLY once (an "autopilot"-authored comment + a durable marker keyed to
    // validate.at_ms); a fresh driver instance (a restart) does NOT re-fire the
    // bounce for the same failure.
    #[tokio::test]
    async fn validate_fail_bounces_once_and_is_restart_safe() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, checkout) = plain_repo(tmp.path(), &pool).await;
        add_validate_check(&pool, &repo.id).await; // checks_configured = true
        let parent = insert_epic(&pool, &repo.id, true).await;
        // A still-Running producer that published its contract → derives needs-review.
        let ticket = insert_subtask(&pool, &repo.id, &parent.id, "backend", WorkspaceStatus::Running, None).await;
        publish_contract(&pool, &parent.id, &ticket.id, "backend").await;
        write_validate(&checkout, &ticket.id, false, 4_000); // a failing result

        // First driver: one bounce.
        let driver1 = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs1"));
        driver1.drive_epic(&parent.id).await;
        // A second drive on the SAME driver must NOT re-bounce.
        driver1.drive_epic(&parent.id).await;

        // A fresh driver (simulated restart — new in-memory state, same disk).
        let driver2 = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs2"));
        driver2.drive_epic(&parent.id).await;

        let comments = list_comments(&checkout, &ticket.id).unwrap();
        let bounces = comments.iter().filter(|c| c.author == "autopilot").count();
        assert_eq!(bounces, 1, "exactly one autopilot bounce across drives + a restart");
        assert!(
            bounce_marker_exists(&checkout, &ticket.id, 4_000),
            "the durable bounce marker keyed to validate.at_ms must exist"
        );
        // A FRESH failure (newer validate.at_ms) is a new state → a new bounce.
        write_validate(&checkout, &ticket.id, false, 9_000);
        driver2.drive_epic(&parent.id).await;
        let comments = list_comments(&checkout, &ticket.id).unwrap();
        assert_eq!(
            comments.iter().filter(|c| c.author == "autopilot").count(),
            2,
            "a newer validate.at_ms is a fresh failure → a second (one) bounce"
        );
    }

    // ── S4: auto-integrate (boot sweep) + STOP durability ────────────────────

    // Boot sweep: an all-approved, clean epic auto-integrates within one sweep —
    // even with all agents idle and no event firing (the reboot-overnight case) —
    // and a SECOND sweep does NOT re-integrate (durable dedup + Ship park).
    #[tokio::test]
    async fn boot_sweep_auto_integrates_a_clean_approved_epic_once() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, repo_dir) = git_repo(tmp.path(), &pool).await;
        commit_on_branch(&repo_dir, "phasr/backend", "backend.txt", "b\n", "backend");
        commit_on_branch(&repo_dir, "phasr/frontend", "frontend.txt", "f\n", "frontend");

        let parent = insert_epic(&pool, &repo.id, true).await;
        let backend = insert_subtask(&pool, &repo.id, &parent.id, "backend", WorkspaceStatus::Running, Some("phasr/backend")).await;
        let frontend = insert_subtask(&pool, &repo.id, &parent.id, "frontend", WorkspaceStatus::Running, Some("phasr/frontend")).await;
        add_edge(&pool, &parent.id, &backend.id, &frontend.id).await;
        write_review(&repo_dir, &backend.id, ReviewState::Approved);
        write_review(&repo_dir, &frontend.id, ReviewState::Approved);

        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));

        // Boot sweep drives every autopilot epic once.
        driver.sweep_all().await;

        // The parent now carries an integration branch (integrated).
        let refreshed = WorkspaceRepo::new(pool.clone()).get(&parent.id).await.unwrap();
        assert!(
            refreshed.branch.as_deref().map(|b| b.starts_with("phasr/integration/")).unwrap_or(false),
            "the boot sweep must auto-integrate the approved epic"
        );
        // A second sweep must NOT re-integrate (durable dedup; now parks at Ship).
        driver.sweep_all().await;

        let log = read_audit(&repo_dir, &parent.id);
        assert_eq!(audit_count(&log, "integrated 2 tickets"), 1, "integrate fires exactly once");
        assert_eq!(audit_count(&log, "Ship — needs you"), 1, "then parks at Ship, audited once");

        cleanup_integration(&repo_dir, &parent.id, &parent.name);
    }

    // Integrate STOP durability: a conflicting-but-approved epic STOPS on the
    // conflict, records a durable STOP + audits it, leaves the parent mid-merge —
    // and a later drive does NOT re-fire integrate onto the human's resolution
    // (merge_in_progress is top-precedence).
    #[tokio::test]
    async fn integrate_conflict_stops_durably_and_does_not_refire() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, repo_dir) = git_repo(tmp.path(), &pool).await;
        // Both branches rewrite README.md's only line → a real conflict.
        commit_on_branch(&repo_dir, "phasr/backend", "README.md", "backend\n", "backend edit");
        commit_on_branch(&repo_dir, "phasr/frontend", "README.md", "frontend\n", "frontend edit");

        let parent = insert_epic(&pool, &repo.id, true).await;
        let backend = insert_subtask(&pool, &repo.id, &parent.id, "backend", WorkspaceStatus::Running, Some("phasr/backend")).await;
        let frontend = insert_subtask(&pool, &repo.id, &parent.id, "frontend", WorkspaceStatus::Running, Some("phasr/frontend")).await;
        add_edge(&pool, &parent.id, &backend.id, &frontend.id).await;
        write_review(&repo_dir, &backend.id, ReviewState::Approved);
        write_review(&repo_dir, &frontend.id, ReviewState::Approved);

        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));

        driver.drive_epic(&parent.id).await; // fires integrate → conflict STOP.
        // A second + third drive must NOT re-fire integrate onto the mid-merge.
        driver.drive_epic(&parent.id).await;
        driver.drive_epic(&parent.id).await;

        let log = read_audit(&repo_dir, &parent.id);
        // The conflict STOP is audited exactly ONCE across all three drives — a
        // re-fired integrate would append a second "stopped — integration conflict"
        // line (or tear the worktree down), so this alone proves no re-fire.
        assert_eq!(
            audit_count(&log, "stopped — integration conflict"),
            1,
            "the conflict STOP is recorded once and never re-fired"
        );

        // The parent is left mid-merge for the human's resolver (not torn down).
        let worktree = git::default_worktree_base_path().join(&parent.id);
        assert!(
            matches!(git::merge_in_progress(&worktree).unwrap(), git::InProgress::Merge { .. }),
            "the conflicted worktree must be left mid-merge"
        );
        // The durable STOP marker is on disk.
        assert!(read_fired_map(&repo_dir, &parent.id).keys().any(|k| k.ends_with("|integrate")));

        cleanup_integration(&repo_dir, &parent.id, &parent.name);
    }

    // A NON-conflict integrate Err (a subtask whose branch doesn't exist → git
    // merge fails) → durable HUMAN-STOP + audit "integration failed", with NO retry
    // every drive.
    #[tokio::test]
    async fn integrate_non_conflict_error_is_a_durable_human_stop_no_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, repo_dir) = git_repo(tmp.path(), &pool).await;

        let parent = insert_epic(&pool, &repo.id, true).await;
        // A ghost branch that was never committed → `git merge` fails (not a conflict).
        let backend = insert_subtask(&pool, &repo.id, &parent.id, "backend", WorkspaceStatus::Running, Some("phasr/ghost")).await;
        let frontend = insert_subtask(&pool, &repo.id, &parent.id, "frontend", WorkspaceStatus::Running, None).await;
        write_review(&repo_dir, &backend.id, ReviewState::Approved);
        write_review(&repo_dir, &frontend.id, ReviewState::Approved);

        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));

        driver.drive_epic(&parent.id).await;
        driver.drive_epic(&parent.id).await; // must not retry.

        let log = read_audit(&repo_dir, &parent.id);
        assert_eq!(
            audit_count(&log, "integration failed — needs you"),
            1,
            "a non-conflict Err parks durably and never retries every tick"
        );

        cleanup_integration(&repo_dir, &parent.id, &parent.name);
    }

    // ── I7: strict predicate — never integrate unreviewed / empty ────────────

    // An epic where the tickets are done but NOT all approved never auto-integrates
    // (strict I7 predicate — the driver never fires on the lenient board eligibility).
    #[tokio::test]
    async fn does_not_integrate_when_not_all_approved() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, repo_dir) = git_repo(tmp.path(), &pool).await;
        commit_on_branch(&repo_dir, "phasr/backend", "backend.txt", "b\n", "backend");
        commit_on_branch(&repo_dir, "phasr/frontend", "frontend.txt", "f\n", "frontend");

        let parent = insert_epic(&pool, &repo.id, true).await;
        let backend = insert_subtask(&pool, &repo.id, &parent.id, "backend", WorkspaceStatus::Running, Some("phasr/backend")).await;
        let frontend = insert_subtask(&pool, &repo.id, &parent.id, "frontend", WorkspaceStatus::Running, Some("phasr/frontend")).await;
        // Only backend approved; frontend requested (a human decision pending).
        write_review(&repo_dir, &backend.id, ReviewState::Approved);
        write_review(&repo_dir, &frontend.id, ReviewState::Requested);

        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));
        driver.drive_epic(&parent.id).await;

        let refreshed = WorkspaceRepo::new(pool.clone()).get(&parent.id).await.unwrap();
        assert!(refreshed.branch.is_none(), "never integrate an unreviewed epic (I7)");
        let log = read_audit(&repo_dir, &parent.id);
        assert_eq!(audit_count(&log, "integrated"), 0);
    }

    // ── full-ladder end-to-end: drive a real epic through EVERY Stage-A gate ──
    //
    // The slice tests above each prove ONE hop (dedup, kill switch, bounce,
    // integrate-conflict, …). These three drive a real epic through the WHOLE
    // walk against real infra — a temp git repo with worktrees/branches, a real
    // sqlite pool, the real `_inner` command paths, and real on-disk gate/marker/
    // audit files — the closest thing to running the board without the GUI. They
    // are the only tests that exercise the driver's `Auto(Validate)` FIRE path
    // (running + persisting a real `validate.json`), which every slice test skips.

    /// A subtask WITH a real on-disk worktree dir (so `Auto(Validate)` can `cwd`
    /// in and run a check) AND an integration branch. `insert_subtask` above never
    /// sets a worktree, so validate can't run against it.
    async fn insert_subtask_wt(
        pool: &Db,
        repo_id: &str,
        parent_id: &str,
        role: &str,
        status: WorkspaceStatus,
        branch: Option<&str>,
        worktree: &Path,
    ) -> Workspace {
        std::fs::create_dir_all(worktree).unwrap();
        let mut s = Workspace::new(repo_id.into(), role.into(), "cmd".into());
        s.workspace_kind = WorkspaceKind::Subtask;
        s.parent_id = Some(parent_id.into());
        s.role = Some(role.into());
        s.status = status;
        s.branch = branch.map(String::from);
        s.worktree_path = Some(worktree.to_string_lossy().into_owned());
        if status == WorkspaceStatus::Completed {
            s.exit_code = Some(0);
        }
        WorkspaceRepo::new(pool.clone())
            .insert_for_user(&s, "user-a")
            .await
            .unwrap();
        s
    }

    /// A PASSING repo check (`exit 0`) opted into Validate — so the forward ladder
    /// proceeds validate → request-review instead of parking on a red build (the
    /// existing `add_validate_check` uses `exit 1`, which parks).
    async fn add_passing_check(pool: &Db, repo_id: &str) {
        let mut rc = RunCommand::new(repo_id.into(), "unit".into(), "exit 0".into());
        rc.run_in_validate = true;
        RunCommandRepo::new(pool.clone()).insert_for_user(&rc, "user-a").await.unwrap();
    }

    fn git_rev(repo: &Path, rev: &str) -> String {
        let out = Command::new("git").args(["rev-parse", rev]).current_dir(repo).output().unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Every non-blank audit line's author column (`ts \t author \t message`) is
    /// `"autopilot"` — the audit thread never impersonates the human (S6/G1).
    fn audit_all_authored_autopilot(log: &str) -> bool {
        log.lines()
            .filter(|l| !l.trim().is_empty())
            .all(|l| l.split('\t').nth(1) == Some("autopilot"))
    }

    // THE happy path: an epic with a 2-ticket DAG (backend → frontend) drives
    // itself validate → request-review → PARK at in-review, then — after the
    // HUMAN approves — integrate → PARK at Ship. Every safe gate auto-fires once;
    // every human-judgment / outward edge PARKS; Ship never fires and base is
    // untouched; and the whole run is attributed "autopilot". Re-driving past each
    // boundary is a fixpoint (durable dedup), so the loops below never over-fire.
    #[tokio::test]
    async fn full_ladder_drives_epic_through_validate_review_to_ship_park() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, repo_dir) = git_repo(tmp.path(), &pool).await;
        // Two non-overlapping subtask branches → a clean topological integrate.
        commit_on_branch(&repo_dir, "phasr/backend", "backend.txt", "b\n", "backend");
        commit_on_branch(&repo_dir, "phasr/frontend", "frontend.txt", "f\n", "frontend");
        add_passing_check(&pool, &repo.id).await; // a real Validate check, passing.

        let parent = insert_epic(&pool, &repo.id, true).await;
        // backend = a still-Running producer that PUBLISHED its handoff contract
        // (so it derives to needs-review despite an idle-orphan PTY, the I3 layer).
        let backend = insert_subtask_wt(
            &pool, &repo.id, &parent.id, "backend", WorkspaceStatus::Running,
            Some("phasr/backend"), &tmp.path().join("wt-backend"),
        ).await;
        publish_contract(&pool, &parent.id, &backend.id, "backend").await;
        // frontend = a cleanly-exited consumer (clean `done`) downstream of backend.
        let frontend = insert_subtask_wt(
            &pool, &repo.id, &parent.id, "frontend", WorkspaceStatus::Completed,
            Some("phasr/frontend"), &tmp.path().join("wt-frontend"),
        ).await;
        add_edge(&pool, &parent.id, &backend.id, &frontend.id).await; // the DAG.

        let base_before = git_rev(&repo_dir, "main");
        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));

        // ── Phase 1: drive to the human Review gate. Far more drives than the
        //    ladder is long → the fire→re-derive walk must reach a FIXPOINT at the
        //    park (validate → request-review → park, each fired exactly once).
        for _ in 0..10 {
            driver.drive_epic(&parent.id).await;
        }

        for (label, s) in [("backend", &backend), ("frontend", &frontend)] {
            // Auto(Validate) actually RAN: a real validate.json, PASSED, on disk.
            let raw = read_gate_file(&repo_dir, &s.id, GateFile::Validate).ok().flatten()
                .unwrap_or_else(|| panic!("{label}: autopilot must run + persist validate.json"));
            let v: ValidateResult = serde_json::from_str(&raw).unwrap();
            assert!(v.passed, "{label}: the configured check passed");
            assert_eq!(v.checks.len(), 1, "{label}: the one opted-in check ran");
            assert_eq!(v.checks[0].name, "unit");
            // Auto(RequestReview) flipped review.json to requested, STAMPED autopilot.
            let review = read_review(&repo_dir, &s.id).expect("review.json written");
            assert_eq!(review.state, ReviewLadderState::Requested, "{label}: flipped to requested");
            assert_eq!(review_author(&repo_dir, &s.id).as_deref(), Some("autopilot"),
                "{label}: an autopilot gate is NEVER attributed to the human");
        }

        // Each safe gate fired EXACTLY once across 10 drives (durable dedup)…
        let log = read_audit(&repo_dir, &parent.id);
        assert_eq!(audit_count(&log, "ran Validate"), 2, "validate fires once per ticket, never again");
        assert_eq!(audit_count(&log, "passed (1 checks)"), 2, "both validates passed");
        assert_eq!(audit_count(&log, "requested review"), 2, "request-review fires once per ticket");
        // …then PARKS at in-review — NOT auto-approved (the Stage-A §0.5 boundary).
        assert_eq!(audit_count(&log, "Needs you: review"), 2,
            "each ticket parks at the human Approve gate, audited once (deduped)");
        // The epic is NOT integrated: the human hasn't approved, so no merge fired.
        let mid = WorkspaceRepo::new(pool.clone()).get(&parent.id).await.unwrap();
        assert!(mid.branch.is_none(), "no integrate before the human approves");
        assert_eq!(audit_count(&log, "integrated"), 0);
        assert_eq!(git_rev(&repo_dir, "main"), base_before, "base untouched at the Review park");

        // ── Phase 2: the HUMAN approves both tickets (by = "you", never autopilot).
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board_repo = BoardRepo::new(pool.clone());
        let repos = RepositoryRepo::new(pool.clone());
        let registry = TicketWriteRegistry::default();
        for s in [&backend, &frontend] {
            resolve_review_inner(
                s, "user-a", "you", ReviewDecision::Approve, None,
                &workspaces, &board_repo, &repos, &registry, None,
            ).await.unwrap();
        }
        // The attribution boundary holds: the human decision is stamped "you".
        assert_eq!(review_author(&repo_dir, &backend.id).as_deref(), Some("you"));

        // Drive again — autopilot now auto-integrates the clean, fully-approved
        // epic, reaches integrated, then PARKS at Ship. Loop to prove the fixpoint.
        for _ in 0..10 {
            driver.drive_epic(&parent.id).await;
        }

        // Reached INTEGRATED: the parent carries a real integration branch, and the
        // integration worktree holds BOTH subtasks' work (a genuine clean merge).
        let done = WorkspaceRepo::new(pool.clone()).get(&parent.id).await.unwrap();
        let branch = done.branch.clone().expect("the epic auto-integrated");
        assert!(branch.starts_with("phasr/integration/"), "carries the integration branch");
        let worktree = done.worktree_path.clone().expect("the integration worktree");
        let worktree = Path::new(&worktree);
        assert!(worktree.join("backend.txt").exists() && worktree.join("frontend.txt").exists(),
            "the integration worktree carries both subtasks' work");
        assert_eq!(git::merge_in_progress(worktree).unwrap(), git::InProgress::None,
            "a clean integrate leaves no merge in progress");

        let log = read_audit(&repo_dir, &parent.id);
        assert_eq!(audit_count(&log, "integrated 2 tickets"), 1, "integrate fires exactly once");
        // Ship is NEVER auto-fired: PARK at Ship (HumanStop), audited once, and the
        // base branch is byte-for-byte UNCHANGED — no merge-to-base from the driver.
        assert_eq!(audit_count(&log, "Ship — needs you"), 1, "then parks at Ship, once (deduped)");
        assert_eq!(git_rev(&repo_dir, "main"), base_before,
            "Stage A never ships: base `main` must be byte-for-byte unchanged");
        assert_eq!(audit_count(&log, "integrated but checks fail"), 0, "clean integrate → no fail park");

        // Audit honesty end-to-end: every fire + park is authored "autopilot".
        assert!(audit_all_authored_autopilot(&log),
            "every audited action must be attributed to autopilot, never the human");

        // The durable markers record the exact set of one-shot fires + parks.
        let fired = read_fired_map(&repo_dir, &parent.id);
        for suffix in ["|validate", "|request-review", "|park"] {
            assert!(fired.keys().any(|k| k.ends_with(suffix)),
                "a durable {suffix} marker must be recorded");
        }
        assert!(fired.contains_key(&fired_key(&parent.id, "integrate")),
            "the epic integrate is durably recorded");

        cleanup_integration(&repo_dir, &parent.id, &parent.name);
    }

    // Safety edge (d): a HUMAN-bounced ticket (review = changes-requested) PARKS
    // and autopilot never auto-re-fires a gate or auto-re-spawns the producer
    // (v1, §2). Re-driving is a fixpoint: only the deduped park is ever recorded.
    #[tokio::test]
    async fn changes_requested_ticket_parks_and_is_never_auto_respawned() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, checkout) = plain_repo(tmp.path(), &pool).await;
        let parent = insert_epic(&pool, &repo.id, true).await;
        let ticket = insert_subtask(&pool, &repo.id, &parent.id, "backend", WorkspaceStatus::Completed, None).await;

        // Human bounce: writes review.json{changes-requested} + a reason comment.
        let workspaces = WorkspaceRepo::new(pool.clone());
        let board_repo = BoardRepo::new(pool.clone());
        let repos = RepositoryRepo::new(pool.clone());
        let registry = TicketWriteRegistry::default();
        resolve_review_inner(
            &ticket, "user-a", "you", ReviewDecision::Bounce, Some("tighten the diff"),
            &workspaces, &board_repo, &repos, &registry, None,
        ).await.unwrap();

        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));
        for _ in 0..8 {
            driver.drive_epic(&parent.id).await;
        }

        let log = read_audit(&checkout, &parent.id);
        assert_eq!(audit_count(&log, "Changes requested — needs you"), 1,
            "a bounced ticket parks once (deduped), never once per drive");
        // No gate auto-fires on a bounced ticket, and the epic never integrates.
        assert_eq!(audit_count(&log, "requested review"), 0, "no auto re-request-review");
        assert_eq!(audit_count(&log, "ran Validate"), 0, "no auto re-validate");
        assert_eq!(audit_count(&log, "integrated"), 0, "a non-approved epic never integrates");
        // The review stays exactly as the human left it (changes-requested / "you").
        let review = read_review(&checkout, &ticket.id).unwrap();
        assert_eq!(review.state, ReviewLadderState::ChangesRequested);
        assert_eq!(review_author(&checkout, &ticket.id).as_deref(), Some("you"));
        // Only the park is durably recorded — no gate fired.
        let fired = read_fired_map(&checkout, &parent.id);
        assert!(!fired.is_empty() && fired.keys().all(|k| k.ends_with("|park")),
            "only a park is recorded, no fired gate");
        assert!(audit_all_authored_autopilot(&log));
    }

    // Safety edges (a) + (b), asserted MID-ladder (stronger than from-scratch): an
    // epic frozen part-way through the ladder advances NOTHING while the kill
    // switch is set (drive_epic AND sweep_all), NOR while its per-epic flag is off
    // — and re-arming BOTH resumes the exact next hop, proving the freeze (not a
    // terminal state) is what held it. There is no auto-resume.
    #[tokio::test]
    async fn kill_switch_and_disabled_flag_freeze_a_mid_ladder_epic() {
        let tmp = tempfile::tempdir().unwrap();
        let pool = init_pool(&tmp.path().join("t.sqlite")).await.unwrap();
        seed_user(&pool, "user-a").await;
        let (repo, checkout) = plain_repo(tmp.path(), &pool).await;
        add_passing_check(&pool, &repo.id).await;
        let parent = insert_epic(&pool, &repo.id, true).await;
        let ticket = insert_subtask_wt(
            &pool, &repo.id, &parent.id, "backend", WorkspaceStatus::Completed,
            None, &tmp.path().join("wt"),
        ).await;

        let driver = build_driver(&pool, tmp.path().join("contracts"), tmp.path().join("logs"));

        // One drive lands the ticket MID-ladder: Validate ran, but request-review
        // has NOT yet fired (the next hop).
        driver.drive_epic(&parent.id).await;
        assert!(read_validate(&checkout, &ticket.id).is_some(), "validate ran (mid-ladder)");
        assert!(read_review(&checkout, &ticket.id).is_none(), "not yet requested review");
        let audit_frozen = read_audit(&checkout, &parent.id);
        let fired_frozen = read_fired_map(&checkout, &parent.id);
        assert!(!audit_frozen.is_empty(), "the mid-ladder validate was audited");

        // (a) KILL SWITCH: while set, neither drive_epic NOR sweep_all advances the
        //     next gate — the epic is frozen exactly where it was.
        AutopilotStateRepo::new(pool.clone()).set_kill_switch(true).await.unwrap();
        for _ in 0..5 {
            driver.drive_epic(&parent.id).await;
        }
        driver.sweep_all().await;
        assert_eq!(read_audit(&checkout, &parent.id), audit_frozen, "a halted driver appends no audit");
        assert_eq!(read_fired_map(&checkout, &parent.id), fired_frozen, "a halted driver fires nothing");
        assert!(read_review(&checkout, &ticket.id).is_none(), "request-review never fires while halted");

        // (b) PER-EPIC FLAG OFF: un-halt but disable the epic → still frozen (the
        //     other independent gate). No auto-resume from either gate alone.
        AutopilotStateRepo::new(pool.clone()).set_kill_switch(false).await.unwrap();
        WorkspaceRepo::new(pool.clone())
            .update(&parent.id, crate::store::WorkspaceUpdate {
                autopilot_enabled: Some(false),
                ..Default::default()
            })
            .await
            .unwrap();
        for _ in 0..5 {
            driver.drive_epic(&parent.id).await;
        }
        driver.sweep_all().await;
        assert_eq!(read_audit(&checkout, &parent.id), audit_frozen, "a disabled epic appends no audit");
        assert!(read_review(&checkout, &ticket.id).is_none(), "request-review never fires while disabled");

        // Re-arm BOTH → the epic resumes the EXACT next hop (request-review),
        // proving the freeze — not a terminal state — is what held it.
        WorkspaceRepo::new(pool.clone())
            .update(&parent.id, crate::store::WorkspaceUpdate {
                autopilot_enabled: Some(true),
                ..Default::default()
            })
            .await
            .unwrap();
        driver.drive_epic(&parent.id).await;
        let review = read_review(&checkout, &ticket.id).expect("re-arming resumes the ladder");
        assert_eq!(review.state, ReviewLadderState::Requested);
        assert_eq!(review_author(&checkout, &ticket.id).as_deref(), Some("autopilot"));
    }
}
