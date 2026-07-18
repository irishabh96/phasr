# Epic Spec: Multi-Agent Task Board (AI-native Jira)

**Epic ID:** MATB · **Status:** Ready for System Architect review · **Date:** 2026-07-18
**Author:** BSA · **Mode:** SAFe spec (Epic → Features → Stories + Enablers)
**Baseline:** phasr v0.3.1 (server-side `start_task` idempotency shipped, task #12)
**Reconciles with:** `/Users/rishabh/.claude/plans/velvety-sniffing-thompson.md` (P0 perf/retention
program), `docs/PERFORMANCE-RETENTION-REPORT.md`, `docs/design/RETENTION-EXPERIENCE-REPORT.md`,
`docs/design/DDR-002-feedback-and-states.md`, `docs/design/DDR-003-completion-notifications.md`,
`docs/adr/ADR-001-design-system-foundations.md`.

---

## 0. Validation Log (claims checked against code, before planning)

Every load-bearing claim from the two prior expert reads was spot-checked. Verdicts:

| # | Claim | Verdict | Evidence (file:line) |
|---|-------|---------|----------------------|
| 1 | `WorkspaceStatus` is a fixed enum with `from_str`/`as_str` round-trip; adding `Blocked` breaks it | **CONFIRMED** | `domain/workspace.rs:11-59` — 6 variants, `from_str` returns `None` on unknown, `can_transition_to` matrix, `round_trip_str` test asserts every variant. A new stored status would also break the sync string round-trip. **Keep DAG state out of `WorkspaceStatus`.** |
| 2 | Add `WorkspaceKind::{Parent, Subtask}` additively | **CONFIRMED (additive)** | `domain/workspace.rs:62-88` — enum is `{Agent, Local}`, `Copy`, `#[serde(rename_all="lowercase")]`, with `as_str`/`from_str`. Adding two variants touches only those two fns + the `round_trip` test. Low blast radius. |
| 3 | The just-shipped #12 `(repo, name)` idempotency guard becomes a liability for subtasks | **CONFIRMED — real landmine** | `orchestrator/service.rs:178-200` dedups active tasks via `find_active_by_name[_for_user]`; `store/workspaces.rs:212-252` filters `WHERE ... workspace_kind = 'agent'`. Two parents each with a "backend" subtask both named `backend` → dedup collides → second parent hijacks the first's task. **Fix is clean:** subtasks get `kind='subtask'`, which the existing query already excludes (it hard-filters `='agent'`, same mechanism that excludes `'local'` — see the `find_active_by_name_matches_only_active_agent_rows` test, `workspaces.rs:519-604`). Dedup subtasks instead on `(parent_id, role)`. |
| 4 | `merge.rs` exposes `merge_into`/`merge_to` + a `MergeOutcome::Conflicts` interactive flow to reuse | **CONFIRMED** | `git/merge.rs:18-20` (`MergeOutcome::{Clean, Conflicts{files}}`), `merge_into` (`:85`), `merge_to` (`:104`); `git/mod.rs:28-32` re-exports `merge_into, merge_to, merge_abort, merge_continue, merge_set_resolution, in_progress, ConflictSide, InProgress, MergeStrategy`. A dedicated integration worktree can drive the same resolve UI. |
| 5 | `recover_startup_state` must rebuild from DB, not memory / not blindly restart | **CONFIRMED + nuance** | `lib.rs:246-296` — on boot it marks every `Running` row → `Stopped` (the child is dead post-relaunch), then calls `git::prune_worktrees` per repo. It never auto-restarts. So the DAG scheduler must **re-derive** ready/blocked from the `workspace_dependencies`/`workspace_contracts` tables at boot (DB is the source of truth — good existing precedent). |
| 6 | Sync must keep the board machine-local, following the `worktree_path` machine-scoping precedent | **CONFIRMED** | `sync/mod.rs:666-671` derives `worktree_path` locally on pull; `:765-768` pushes it as `Value::Null`; config carries a `machine_id` (`sync/mod.rs:95,127,515`). Precedent is exactly "machine-local state never round-trips through Supabase." DAG tables follow the same rule. |
| 7 | Honest status is the foundational enabler; the scheduler rides on `Completed`, which rides on in-process `child.wait()` | **CONFIRMED — and materially sharpened (see §0.1)** | `PtyEvent::Exit` is emitted by a thread parked on `child.wait()` (`pty/handle.rs:257-263`); the exit-watcher flips `Running→Completed/Failed` on that event (`orchestrator/service.rs:527-568`). Broadcast via `subscribe_status` (`service.rs:128-129`), re-emitted as `phasr://task-status` (`commands/orchestrator.rs:24,180`). |

### 0.1 CORRECTION — `WorkspaceStatus::Completed` is the WRONG subtask-completion signal `#PATH_DECISION`

This is the single most important finding, and it reshapes the plan.

The architecture read is factually right that the only completion signal today is `Completed`, riding on
`child.wait()`. But the code itself documents why that signal **cannot** drive the DAG scheduler:

> *"interactive agents (Claude, Codex, etc.) almost never exit on their own — they sit at a prompt waiting
> for input. This handler only fires on real process death: a crash, the user typing `exit`, or an explicit
> kill."* — `orchestrator/service.rs:522-526`

So a subtask agent that has **finished its assigned work** does not emit `PtyEvent::Exit` — it goes idle at
its prompt while its row stays `Running`. A scheduler that unblocks a dependent when its predecessor reaches
`Completed` would therefore **hang in the normal case**. `Completed` means *"the process died,"* not *"the
task is done."*

**Consequence for the whole epic:** the edge-satisfaction signal is **contract publication** (the predecessor
writes its contract file) and/or an **explicit "mark subtask done,"** NOT `WorkspaceStatus::Completed`. And
"is this agent working, done-and-idle, or wedged?" is answered by the *same* activity/idle model the design
side wants for the Wedged state. **Honest status is not just a trust nicety — it is the completion-detection
substrate the scheduler is built on.** That is why it is Step 0, ahead of any board chrome.

### 0.2 Other findings folded in

- **No activity/idle/heartbeat model exists today.** No `last_activity`, `last_output`, `idle`, or `wedged`
  anything in `orchestrator/service.rs` or `pty/handle.rs`. The PTY *does* broadcast `PtyEvent::Output`
  (`pty/handle.rs`), so a heartbeat is tappable — but nothing consumes it for liveness. Honest status is net-new.
- **Orphaned-worktree GC gap is multiplied by this epic.** `recover_startup_state` calls `git::prune_worktrees`
  (`lib.rs:280`), which only prunes git's *worktree admin metadata* for already-deleted dirs — it does not
  delete orphaned worktree **directories on disk**. An epic spawns **N worktrees per parent**; a cancelled or
  half-merged epic multiplies the pending orphaned-worktree-GC debt N-fold. Called out as Enabler E4.
- **Derived-state precedent already exists.** `TerminalStatus.tsx` (shipped via DDR-002) already renders
  icon+color+label for `starting|retrying|restarting|failed|exited`. The board's card states are the same
  pattern, one level up. Reuse, don't reinvent.
- **Completion-notification substrate already exists.** `phasr://task-status` (`commands/orchestrator.rs:24`) +
  `useTaskEvents.ts:28`, plus DDR-003's notification UX. Honest status **extends** this event, it does not
  re-spec it.

---

## 1. Epic

**Title:** Multi-Agent Task Board — decompose one parent task into a DAG of subtask-agents, each in its own
worktree/branch, coordinated by the orchestrator, merged into one reviewable combined diff.

**Business outcome:** Move phasr from "N independent agents you babysit one terminal at a time" to
"one goal you delegate, the tool fans it out, and you review one result." Directly attacks phasr's two biggest
retention gaps: **R3 "needs-you home"** (a cross-everything worklist so nothing rots unseen) and **R7
buried-merge-reward** (the combined-diff review is the loud payoff).

**KPI / success signals:**
- Time-to-first-value for a multi-part task drops (one prompt → N agents, no per-agent setup).
- Zero "card said Working, agent was dead" trust breaks (honest-status is a release gate, §2).
- Combined-diff review completion rate for decomposed epics (the R7 reward actually gets seen).

**Non-goals (this epic):** peer-to-peer agent messaging; auto-fan-out without user approval; draggable Kanban;
syncing the DAG across machines; durable/detachable sessions as a prerequisite (deferred to Phase 3).

**Guiding constraints (from the design read, treated as invariants):**
- **Progressive disclosure is non-negotiable.** A single agent on a single task must look **exactly** like
  today. Epic/board chrome appears **only after** a decomposition exists.
- **The board is status cards, never a wall of live terminals.** Never >1 terminal on screen (as today).
  Calm-by-default; agents raise a hand.
- **Decomposition is a reviewable, editable plan the user approves** ("Start N agents") — never an auto-fan-out
  onto worktrees.
- **Lanes auto-advance on derived state.** The board is a **read-only pipeline**, not a draggable Kanban,
  because states are *derived*, not user-set.

---

## 2. Step 0 — Honest Status (Foundational Enabler, ships BEFORE any board)

> Both experts converged here independently ("trust-at-a-glance" / "exit-detection accuracy"). Per §0.1 it is
> also the scheduler's completion substrate. **Nothing else in this epic ships until this is solid.** It is
> valuable and shippable entirely on its own — it improves the single-agent experience that exists today.

### Enabler E0 — Activity & liveness model (Rust)  · Effort: **M**

Add an activity/liveness layer over the existing PTY broadcast. No new `WorkspaceStatus` variant.

**Acceptance criteria**
- **Given** a running agent producing PTY output, **when** output arrives, **then** a per-task
  `last_activity_at` is updated (tap the existing `PtyEvent::Output` stream in `pty/handle.rs` /
  `orchestrator/service.rs`; do **not** touch the hot byte-pump path — piggyback, don't gate).
- **Given** a running agent with no output for `> IDLE_THRESHOLD` (config, default 60s), **when** liveness is
  polled, **then** the task is reported as **idle/needs-attention with an honest "last activity Ns ago"** — never
  still asserted as "Working."
- **Given** the app relaunches, **when** `recover_startup_state` runs (`lib.rs:246`), **then** orphaned
  `Running` rows are surfaced as **Wedged/interrupted**, not silently `Stopped`-and-forgotten (extend the
  existing `Running→Stopped` sweep with a user-visible "was interrupted" derivation).
- **Given** the process dies with a nonzero code, **then** it derives **Failed** (existing exit-watcher path,
  `service.rs:546-556`, unchanged).
- Zero regression on the in-process PTY hot path (`cargo test` on `pty` + `orchestrator` green; new consumer is
  additive, mirrors the E3 scheduler pattern of subscribing, never blocking).

### Story S0.1 — Derived card-state model + honest single-agent status UI  · Effort: **M**

The 6 (+Done) derived states, each with **color + icon + label** (never color alone — colorblind-safe, per
DDR-002). Derivation rules are grounded in signals that actually exist:

| Derived state | Derivation rule (grounded) | Color / icon token | WCAG note |
|---|---|---|---|
| **Working** | `status=Running` AND `last_activity_at` within `IDLE_THRESHOLD` | info + pulsing dot / `Loader2` spinner | **Tier A (bare).** Neutral-AA label carries meaning; colored icon is reinforcement. Info glyph 4.74:1 light / 7.61:1 dark (verified). |
| **Needs-you** ⚠️ | `status=Running` AND idle `> IDLE_THRESHOLD` AND no contract yet (P0: honest "needs attention — last activity Ns ago"; P1 refines via a **CPU-activity sensor** to suppress false-positives on busy-but-quiet agents, then a prompt-pattern/stdin-block heuristic — see Enabler E-P1 in [`step0-honest-status-implementation.md`](./step0-honest-status-implementation.md)) | **coral filled pill** | **Tier C (solid).** Coral fill + `--color-accent-onfill` (#010409) ink = **8.1:1** both themes (verified). A bare coral glyph fails AA (**2.32:1** light sidebar / **2.47:1** light glass). Do **not** use a coral-colored text label as the fallback — accent-700 `#d4583a` is only 3.66:1 light (UI-tier, not body). Verify with `.claude/skills/design-system/scripts/check-contrast.mjs`. |
| **Blocked** | predecessor edge unsatisfied in `workspace_dependencies` + `workspace_contracts` (pure table read, no heuristic) | neutral/muted + lock icon | **Tier A (bare).** Neutral token, AA both themes. Never coral (it is not on you). Phase 1+, not rendered in Step 0. |
| **Wedged** ⏳ | `status=Running` AND idle `> WEDGED_THRESHOLD` (≫ idle), OR orphaned-on-relaunch | warning + **hourglass** icon, soft 14%-tint chip | **Tier B (soft chip).** Icon is an **hourglass**, not a broken-link (broken-link reads as a dependency/Blocked metaphor; hourglass = "time passing, no output"). Bare warning glyph **FAILS light** (**2.92:1** < 3:1); the tint chip + neutral-AA label (17:1) carry it. No pulse — a frozen agent must not look alive. |
| **Needs-review** | subtask reached done (contract published / marked done / clean exit) awaiting integration merge | success + review icon | **Tier A/B.** Bare success glyph is marginal light (**3.02:1**); neutral-AA label carries meaning. *Not a Step-0 single-agent surface — collapses into Done, see note below.* |
| **Failed** | `status=Failed` or spawn error | danger + alert icon (reuse `TerminalStatus` `failed`), soft 14%-tint chip | **Tier B (soft chip).** Bare danger glyph **4.43:1** light (passes 3:1 UI, fails 4.5 body); neutral-AA label carries it. |
| **Done** | merged into the parent's integration branch (**Step-0 single-agent:** clean `exit 0` with N changes — see note) | success check | **Tier A (bare).** Bare success glyph marginal light (**3.02:1** sidebar / **3.30:1** white); neutral-AA label carries meaning. |

**S0.1 contrast standard (COMPUTED, not estimated — the prior "AA both themes" note was only true for the DARK sidebar).** On the **light** sidebar `#f4f5f7` the bare colored glyphs verifiably fail or graze the bar: warning **2.92:1 (FAIL 3:1)**, success **3.02:1**, danger **4.43:1**, info **4.74:1**, coral **2.32:1 (FAIL)** — versus ≈**7.6:1** for all on the dark sidebar `#0b0f14`. So meaning is **never carried by a bare colored glyph**: it is carried by a **neutral-AA text label** (`--color-text-primary` = **18.14:1** light / **16.27:1** dark) or by onfill ink, and the state color is **reinforcement**. Three treatment tiers (phasr's proven idiom):

- **Tier A — bare colored icon + neutral-AA label** (Working, Done, Blocked, Needs-review): calm states. The label passes AA regardless; the icon is a graphic accent.
- **Tier B — soft 14%-tint chip + colored icon + neutral-AA label** (Wedged, Failed): attention states. The tint gives the color presence without asking a 2.9–4.4:1 glyph to be the signal (label over a 14% tint is still ≈17:1).
- **Tier C — solid coral filled pill + `--color-accent-onfill` ink** (Needs-you **only**): the single scarce coral moment; onfill ink = **8.1:1** both themes.

**Done vs Needs-review in Step 0 (single-agent).** The board's Backlog→Review→Done separation does not exist yet in Step 0; there is no "contract published" or "merged" concept for a lone agent. Step 0 therefore renders **one positive terminal state** — **"Done · needs review"** = process `exit 0` with N changes, pairing with DDR-003's completion toast. The Needs-review / Done split re-materializes in F3/F4 once a board and integration branch exist (progressive disclosure).

**Acceptance criteria**
- **Given** any agent, **when** its state is rendered, **then** it shows icon **and** color **and** text label
  (no color-only signal), AA-legible in **both** themes, on the glass material — reusing `TerminalStatus.tsx`
  tokens/pattern where they apply.
- **Given** an idle-beyond-threshold agent, **then** the UI shows **"last activity Ns ago"** and never claims
  "Working."
- **Every** state's rendered treatment passes the **light-sidebar** contrast gate — not just coral. Meaning is
  carried by a neutral-AA label (`--color-text-primary`, ≥18:1) or onfill ink (8.1:1); **no** state relies on a
  bare colored glyph below 3:1. The coral **2.47:1** *and* warning **2.92:1** bare-glyph failure modes are both
  gone. `#EXPORT_CRITICAL` accessibility gate.
- **Progressive disclosure preserved:** a single agent on a single task renders with the same chrome as today —
  no board chrome, no epic chrome. The one deliberate change: the sidebar row's single meta line now carries the
  **honest status** ("Working · active 2s ago") instead of the branch string; the **branch relocates to the
  header `BranchChip` + tooltip** (higher-value signal wins the space-constrained 44px row; the branch is still
  one glance away and is derivable from the workspace name).

### Story S0.2 — Extend `phasr://task-status` + notification for Wedged  · Effort: **S**

**Acceptance criteria**
- **Given** an agent transitions to Wedged, **then** `phasr://task-status` (`commands/orchestrator.rs:24`,
  consumed at `useTaskEvents.ts:28`) carries the derived state, and DDR-003's notification path fires a calm,
  focus-aware, deduped notification. Wedged is a **warning, not an error**: use a **polite** live region
  (`role="status"` / `aria-live="polite"`), persistent and action-first — **not** the assertive `role="alert"`
  DDR-003 reserves for Failed. *(Mockup nit: the in-app toast markup uses `role="alert"`; ship it as
  `role="status"`.)* **Reconcile, do not re-spec:** reuse the DDR-003 completion-notification plumbing;
  add Wedged as a new trigger, not a parallel system.

**Step 0 exit gate (release-blocking):** No card ever asserts "Working" for an agent that has been silent past
threshold. This gate must pass before Phase 1 starts.

> **Implementation breakdown:** [`step0-honest-status-implementation.md`](./step0-honest-status-implementation.md)
> — the `#PATH_DECISION` (backend-authoritative derivation, in-memory activity stamp + one persisted
> `interrupted_at` bit), the E0/S0.1/S0.2 task list with `file:line`, Given/When/Then, owners
> (tauri-engineer / fe-developer), the IPC contract delta, thresholds, build order, and the verification plan.

---

## 3. Data Model & Migration (Enabler E1)

### Enabler E1 — Migration `0012_multi_agent_task_board.sql` (additive)  · Effort: **M**

Follows `migrations/0011_soft_delete_workspaces.sql`. Additive only; no destructive changes.

**Schema**
- `workspaces.parent_id TEXT NULL` — FK to `workspaces.id`; NULL for standalone agents (today's rows unchanged).
- `WorkspaceKind::{Agent, Local, Parent, Subtask}` — extend `domain/workspace.rs:64` enum + `as_str`/`from_str`
  + the `round_trip` test. `Parent` = the epic orchestrating row (no worktree of its own, or an integration
  worktree — see §5); `Subtask` = a fan-out agent. **`Blocked` is NOT a status** (validation #1).
- `workspace_dependencies (parent_id, from_subtask_id, to_subtask_id, ...)` — the DAG edges. Blocked-ness is
  derived by joining this against `workspace_contracts`; it never becomes a stored `WorkspaceStatus`.
- `workspace_contracts (id, parent_id, subtask_id, role, contract_path, published_at, ...)` — one row per
  produced contract; `published_at` is the edge-satisfaction signal (§0.1), **not** `Completed`.

**Acceptance criteria**
- **Given** the migration runs on a v0.3.1 DB, **then** all existing rows are untouched, `parent_id` defaults
  NULL, `workspace_kind` values round-trip (`agent`/`local` unchanged).
- **Given** the dedup guard (`store/workspaces.rs:212-252`), **when** a subtask is inserted, **then** it is
  `kind='subtask'` and **excluded** from `find_active_by_name[_for_user]` (already filters `='agent'`), and a
  **new** `find_active_subtask(parent_id, role)` dedups subtasks — so two parents can each own a "backend"
  subtask without collision (fixes landmine #3). A regression test asserts this exact two-parent scenario.
- **Given** the DAG tables, **then** they are **not** published to Supabase (machine-local, following the
  `worktree_path` precedent, `sync/mod.rs:666-768`). Sync deferred to a later epic.

---

## 4. Features & Stories

### Feature F1 — Reviewable Decomposition (the "Start N agents" gate)

*Depends on: E1. The user turns one prompt into an editable plan, then approves the fan-out. Never auto-spawns.*

- **S1.1 — Decomposition plan surface** · **M** · *dep E1*
  - **Given** a parent prompt ("implement notifications"), **when** the user requests decomposition, **then**
    they get an **editable list of proposed subtasks** (role, prompt, dependencies) — nothing is written to
    disk or spawned yet.
  - **Given** the plan, **when** the user edits/adds/removes subtasks and edges, **then** the plan updates and
    stays fully editable until approval.
  - `#PLAN_UNCERTAINTY` LLM-generated vs manual-first decomposition is an **open founder decision** (§8). This
    story ships the **plan surface + manual editing** regardless; LLM auto-draft is a pluggable input behind it.
- **S1.2 — Approve → fan-out under the repo lock** · **M** · *dep S1.1, E1, E3*
  - **Given** an approved plan of N subtasks, **when** the user clicks **"Start N agents,"** **then** a `Parent`
    row + N `Subtask` rows are created, each dedup-keyed on `(parent_id, role)`, and ready (unblocked) subtasks
    spawn via existing `start_task` internals under the per-repo lock (`service.rs:172` lock precedent).
  - **Given** an edge `frontend → backend`, **then** `frontend` starts **Blocked** (derived), not spawned, until
    `backend` publishes its contract.
  - **Given** any spawn fails, **then** it derives Failed with a recovery action (reuse `TerminalStatus` failed)
    — the fan-out does not half-die silently.

### Feature F2 — Orchestrator-Mediated Handoff (contracts, no P2P)

*Depends on: E1, E3. A dependency's output is seeded into a blocked agent's initial prompt via a shared contract
file. Coordination is orchestrator-mediated, never agent-to-agent.*

- **S2.1 — Contract file substrate** · **M** · *dep E1*
  - **Given** a subtask, **when** it publishes a contract, **then** it is written **outside** any worktree at
    `~/.phasr/tasks/<parent>/contracts/<role>.md` and a `workspace_contracts` row records `published_at`.
  - **Rationale:** contracts live outside worktrees so a `prune_worktrees`/GC sweep (E4) can't delete them and
    they aren't captured in any subtask's diff.
- **S2.2 — Seed-prompt injection on unblock** · **M** · *dep S2.1, E3*
  - **Given** `backend` publishes its contract, **when** `frontend`'s last blocking edge clears, **then** the
    scheduler spawns `frontend` with the contract **seeded into its initial prompt** (`initial_prompt` in
    `pty/handle.rs:106` `PtyHandle::spawn` already supports prompt injection).
  - **`#PATH_DECISION` prefer seed-prompt over send-keys.** Seeding into a fresh agent's initial prompt is
    deterministic; typing into a running agent's TUI (send-keys) races the agent's UI state. Confirmed
    supported by the existing spawn path — no new PTY surface needed for the POC.
  - **Given** the contract-publication signal (§0.1), **then** edge-satisfaction fires on
    `workspace_contracts.published_at`, **not** on `WorkspaceStatus::Completed`.

### Feature F3 — The Board (read-only pipeline + needs-you worklist)

*Depends on: S0.1 (states), E1. Ships phasr's two retention headliners. Board chrome appears only after a
decomposition exists (progressive disclosure).*

- **S3.1 — "Needs-you home" cross-everything worklist (R3)** · **M** · *dep S0.1*
  - **Given** agents across all repos/epics, **when** any derives **Needs-you / Wedged / Needs-review /
    Failed**, **then** it appears in a **sidebar worklist** ranked by "raises a hand" urgency — calm by default,
    nothing rots unseen.
  - **Given** a single lone agent (no epics), **then** the worklist is present but the per-epic board is **not**
    shown (progressive disclosure).
- **S3.2 — Per-epic read-only pipeline board (Backlog → In Progress → Review → Done)** · **L** · *dep S3.1, E1*
  - **Given** a decomposed parent, **then** a per-epic board shows subtask **status cards** (not terminals)
    that **auto-advance** across lanes on derived state — **not draggable** (states are derived).
  - **Given** the board, **then** at most **one** live terminal is ever on screen (as today); opening a card
    focuses that one agent.
- **S3.3 — Full-state-coverage** · **M** · *dep S3.2* — see §6 matrix. Every card and the board itself must
  render every state (empty/loading/partial/failed/conflict/wedged/needs-input/done). Release-gated by the
  matrix.

### Feature F4 — Integration Merge & Combined-Diff Review (the R7 reward)

*Depends on: E1, E2. Completed subtask branches merge into ONE integration branch; the user reviews ONE combined
diff — the loud payoff.*

- **S4.1 — Dedicated integration worktree + topological merge** · **L** · *dep E2, E1*
  - **Given** subtasks whose contracts are published / marked done, **when** the user triggers integration,
    **then** their branches merge in **topological (dependency) order** into a **dedicated integration worktree**
    — **never** the user's checkout — reusing `merge_into`/`merge_to` (`git/merge.rs:85,104`).
  - **Given** a conflict, **then** `MergeOutcome::Conflicts` surfaces to the **existing interactive resolve
    flow** (`merge_abort`/`merge_continue`/`merge_set_resolution`, `git/mod.rs:28-32`) — no new conflict UI.
- **S4.2 — One combined diff review** · **M** · *dep S4.1*
  - **Given** a clean/resolved integration, **then** the user reviews **one combined diff** for the whole parent
    (reuse `git/diff.rs` + the existing diff UI). This is the R7 reward surfaced loudly on the board's Done lane.

---

## 5. Enablers (cross-cutting)

- **E2 — Scheduler (new `subscribe_status`/contract consumer)** · **L** · *dep E0, E1*
  - Dependency-aware; concurrency-capped via a `tokio::Semaphore`; spawns ready subtasks through existing
    `start_task` internals under the per-repo lock. **Additive consumer** of `subscribe_status`
    (`service.rs:128`) + `workspace_contracts` — touches the hot path **zero** (mirrors the exit-watcher's
    subscribe-never-block shape, `service.rs:527`).
  - **AC:** rebuilds ready/blocked from the **DB tables** on boot (validation #5 — not from memory); edge
    satisfaction is contract-publication, not `Completed` (§0.1); a wedged predecessor does **not** falsely
    unblock its dependents.
- **E3 — Parent/Subtask recovery in `recover_startup_state`** · **M** · *dep E1, E2*
  - **AC:** on relaunch, `lib.rs:246` reconstructs each parent's DAG from `workspace_dependencies`/
    `workspace_contracts`, re-derives blocked/ready, and surfaces interrupted subtasks as **Wedged** — it does
    **not** blindly restart agents.
- **E4 — Orphaned-worktree GC (pull P0 debt forward)** · **M** · *dep E1*
  - `recover_startup_state`'s `prune_worktrees` (`lib.rs:280`) only prunes git metadata, not on-disk worktree
    dirs. An epic creates **N worktrees per parent**, multiplying the pending orphaned-worktree-GC debt.
  - **AC:** a bounded GC removes worktree **directories** for archived/merged/abandoned subtasks (respecting the
    repo lock and the contract dir being *outside* worktrees). **`#PLAN_UNCERTAINTY`** — scope: does GC run on
    epic archive, on relaunch, or both? Recommend epic-archive + a relaunch sweep with a safety age threshold.

---

## 6. Full-State-Coverage Matrix (release gate for F3)

Every surface must render every state. Rows = surface; columns = state.

| Surface \ State | Empty | Loading | Partial | Working | Needs-you | Blocked | Wedged | Needs-review | Failed | Conflict | Done |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Subtask card | — | ✓ | — | ✓ | ✓ (coral pill, AA) | ✓ | ✓ | ✓ | ✓ | ✓ (S4.1) | ✓ |
| Per-epic board | ✓ (no subtasks) | ✓ | ✓ (some spawned) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (all merged) |
| Needs-you worklist | ✓ (calm/all clear) | ✓ | — | — | ✓ | — | ✓ | ✓ | ✓ | ✓ | — |
| Decomposition plan | ✓ (no plan) | ✓ (drafting) | ✓ (editing) | — | — | — | — | — | ✓ (spawn fail) | — | — |
| Combined-diff review | ✓ (nothing to review) | ✓ | ✓ (partial merge) | — | — | — | — | ✓ | ✓ | ✓ | ✓ |

Gate: no dead ends (every Failed/Conflict/Wedged offers recovery, per DDR-002); no infinite spinner; single-agent
path shows **none** of the epic columns (progressive disclosure).

---

## 7. Phasing, Sequencing & Critical Path

### Step 0 (release-gated, ships alone first) — **Honest Status**
`E0` → `S0.1` → `S0.2`. **Highest-leverage first deliverable.** Ships standalone value to the *current*
single-agent product (no card ever lies), and is the completion/liveness substrate everything else needs.
**Do not start Phase 1 until the Step 0 exit gate passes.**

### Phase 1 (P0) — **Decompose → fan-out → one combined diff (the thin vertical slice)**
Critical path: `E1 (migration + kind + dedup fix)` → `E2 (scheduler)` → `F1 (S1.1, S1.2)` → `F2 (S2.1, S2.2)`
→ `F4 (S4.1, S4.2)`, with `E3 (recovery)` landing alongside E2. Board is minimal here — cards + worklist
(`S3.1`), enough to see the fan-out honestly. **This is the smallest end-to-end proof:** one parent → 2–3
subtasks → contract handoff → integration worktree → one combined diff.

### Phase 2 (P1) — **Board polish + retention headliners + honest-status refinement**
`S3.2` (full read-only pipeline board), `S3.3` (full-state coverage), `E4` (orphaned-worktree GC), and the
**Needs-you vs Wedged heuristic split** (idle-prompt-pattern detection — the P0 plan already defers heuristic
needs-input to P1; I keep that call). Coral-pill AA hardening lands with S0.1 but is re-audited here across the
full board.

### Phase 3 (Deferred) — **Durable sessions + DAG sync**
`SessionBackend` trait behind `TaskRuntime::spawn` (tmux/dtach), opt-in per task, in-process PTY hot path intact
— **exit-detection is the riskiest coupling, and §0.1 shows exit≠done, so this is genuinely later.** The POC
needs **zero** durable sessions. DAG sync to Supabase also deferred (needs coordinated schema; keep machine-local
per validation #6).

### Critical path (one line)
`E0 → S0.1 → [gate] → E1 → E2 → S1.2 → S2.2 → S4.1 → S4.2`. Everything else parallelizes off this spine.

### The step-0 call, explicitly
**Ship Honest Status (E0 + S0.1 + S0.2) first, as its own release, gated on "no card ever asserts Working for a
silent agent."** It is the one deliverable that (a) pays off immediately for today's users, (b) both experts
independently demanded, and (c) is a hard prerequisite for a trustworthy scheduler.

### What I explicitly DEFER
Durable/detachable sessions (Phase 3); DAG sync across machines (Phase 3); LLM auto-decomposition as a *blocker*
(ship manual-editable plan first, LLM as pluggable input); draggable Kanban (rejected — states are derived);
peer-to-peer agent messaging (rejected — orchestrator-mediated only).

### What I RESEQUENCED vs the inputs (and why)
1. **Edge-satisfaction signal moved off `Completed` onto contract-publication (§0.1).** The architecture read
   framed the scheduler as riding the `Completed` event; the code proves interactive agents don't emit it on
   task-done. Left unchanged, the scheduler would hang. This is the biggest correction.
2. **"Needs-you" split into a P0 honest baseline + a P1 heuristic.** P0 ships one honest "needs attention — last
   activity Ns ago" state (no false precision); P1 splits Needs-you vs Wedged with prompt-pattern heuristics.
   This aligns the design read's 6-state model with the P0 plan's "defer heuristic needs-input to P1" and keeps
   Step 0 honest rather than guessing.
3. **Orphaned-worktree GC (E4) pulled from "pending backlog" into this epic's P1** because the board multiplies
   it N× per parent — it stops being optional once fan-out exists.
4. **Recovery (E3) promoted to Phase 1** (alongside E2, not Phase 2) — a DAG that can't survive a relaunch is
   not shippable; `recover_startup_state` already stops orphans, so rebuilding the DAG there is cheap and must
   land with the scheduler.

---

## 8. Risks, Unknowns & Open Decisions

### `#PLAN_UNCERTAINTY` Risks
- **Liveness ≠ done ≠ waiting-for-you.** PTY silence alone can't perfectly distinguish "thinking," "waiting for
  input," and "hung." Mitigation: honest "last activity Ns ago" in P0 (don't over-claim); heuristics in P1.
- **Contract-publication as the done-signal depends on agents actually writing contracts.** If an agent forgets,
  the dependent stays Blocked forever. Mitigation: explicit user "mark subtask done" as a manual override path,
  and Wedged surfacing so a stuck edge is visible, not silent.
- **Integration-merge conflict volume.** N subtasks touching overlapping files can produce heavy conflicts.
  Mitigation: topological order + the existing interactive resolve flow; decomposition guidance to partition by
  file area.
- **Semaphore concurrency cap vs machine resources.** N parallel agents = N PTYs + N worktrees; the P0 perf
  program's diff/watcher-storm work (`velvety-sniffing-thompson.md` Task 2/3) is a prerequisite for this not to
  melt the machine. Sequence this epic **after** those land.
- **`WorkspaceKind` is `Copy` and small** — adding 2 variants is safe, but every `match` on it must stay
  exhaustive; audit `is_local()` call sites and the sync `dirty`/exclusion logic (`store/workspaces.rs:193,315,348`).

### Open decisions for the founder
1. **Positioning: solo-power-tool vs teams/collab.** Machine-local DAG (this spec) is a solo tool. Is
   multi-machine/team collaboration a near-term bet (which would pull DAG-sync out of Phase 3)?
2. **Decomposition engine: LLM auto-draft vs manual-first.** Spec ships the manual editable plan regardless; do
   we invest in LLM auto-decomposition for P0, or let it be a P1 pluggable input?
3. **Durable session substrate: tmux vs dtach vs stay in-process.** Given §0.1 (exit≠done) the value of durable
   sessions is *survivability across relaunch*, not completion-detection. Is that worth the Phase-3 exit-detection
   coupling risk, or is DB-reconstruction (E3) enough?
4. **"Mark subtask done" affordance** — how manual should the completion override be? Always-available, or only
   when an agent is idle-with-contract?
5. **GC aggressiveness (E4)** — delete worktree dirs on epic-archive, on relaunch sweep, or both, and with what
   safety age threshold?

---

## 9. Validation Commands (per repo process)

```bash
# Rust: enums, dedup landmine regression, scheduler, recovery
cargo test -p phasr domain::workspace   # WorkspaceKind round-trip incl. new variants
cargo test -p phasr store::workspaces   # two-parent same-role dedup regression (landmine #3)
cargo test -p phasr orchestrator        # scheduler: contract-publication unblock, wedged-no-false-unblock

# Accessibility gate (Step 0 / S0.1) — no bare colored glyph below AA on the light sidebar #f4f5f7.
# Meaning must ride a neutral-AA label or onfill ink; verify the load-bearing pairs:
node .claude/skills/design-system/scripts/check-contrast.mjs "#010409" "#f78166"   # Needs-you onfill ink → 8.1:1
node .claude/skills/design-system/scripts/check-contrast.mjs "#0a0a0b" "#f4f5f7"   # neutral label (light) → 18:1
node .claude/skills/design-system/scripts/check-contrast.mjs "#d97706" "#f4f5f7"   # bare warning glyph → 2.92 (why Tier B)

# Frontend
pnpm test        # unit
pnpm test:e2e    # board flows (mocked-IPC harness — note: verifies commands FIRE, not backend truth)
```

> **Testing blind spot (from memory):** the mocked-IPC e2e harness confirms flows fire the right command but
> can't catch backend/data-validity bugs. The contract-publication signal, the dedup landmine fix, and the
> scheduler's blocked/ready derivation **must** have Rust-level tests — an e2e green is not sufficient evidence.
