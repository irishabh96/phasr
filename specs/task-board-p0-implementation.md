# Task Board P0 — Thin Vertical Slice: Implementation Breakdown

**Parent spec:** [`multi-agent-task-board-spec.md`](./multi-agent-task-board-spec.md) — §1 (Epic), §0.1
(process-exit ≠ task-done), §3 (E1 data model), §4 (F1/F2/F4), §5 (E2/E3), §7 (Phase 1 = "the thin vertical
slice"). **Predecessor (shipped):** [`step0-honest-status-implementation.md`](./step0-honest-status-implementation.md)
(E0/S0.1/S0.2 — honest status). **Mode:** story elaboration → implementation-ready. **Date:** 2026-07-18.

This is **not** the full DAG engine. It is the smallest end-to-end proof of the mechanism the architect and BSA
both insisted on proving before building the engine: **one parent → 2 hardcoded subtasks with one edge →
approved fan-out → contract handoff → integration worktree → one combined diff.** Every load-bearing claim
below is checked against the code **as it stands after Step 0 shipped**, with `file:line`. What we DEFER is
called out explicitly in §G.

---

## A. Validation log (claims re-checked against current code, post-Step-0)

Legend: **CONFIRMED** = matches; **CORRECTED** = the brief/parent-spec was stale or wrong; **NEW** = a landmine
neither the brief nor the parent-spec validation log flagged.

| # | Claim | Verdict | Evidence (`file:line`) |
|---|---|---|---|
| 1 | **Next migration is `0013`**, not `0012` | **CORRECTED** | `migrations/` tops out at `0012_workspace_interrupted_at.sql` (Step 0). Parent spec §3 still names the board migration `0012_multi_agent_task_board.sql` — **stale**; it must be **`0013`**. |
| 2 | **Dedup landmine** — `find_active_by_name[_for_user]` hard-filters `workspace_kind='agent'` | **CONFIRMED** | `store/workspaces.rs:224` (`… AND workspace_kind = 'agent' …`) and `:250` (owner-scoped). Called from `start_task` at `service.rs:198` / `:203`. `kind='subtask'` is auto-excluded exactly as `'local'` is (`get_local_by_repository` uses the same `= 'local'` idiom, `:195`; regression test `find_active_by_name_matches_only_active_agent_rows`, `:564`). **Subtasks dedup on `(parent_id, role)` via a new query — never by name.** |
| 3 | **NEW — the dedup landmine's twin: the liveness poller SKIPS non-`Agent` kinds** | **NEW / critical** | `run_liveness_tick` at `service.rs:658`: `if workspace.workspace_kind != WorkspaceKind::Agent { continue; }`. Subtasks are real PTY agents that need honest status, but they are `kind='subtask'` → **they would get NO derived state** (never Working/Idle/Wedged). Neither the brief nor the parent spec's validation log caught this. **Fix (E1-T1): add `WorkspaceKind::runs_agent()` (Agent OR Subtask) and use it at `:658`.** |
| 4 | **Completion signal is contract-publication, NOT `WorkspaceStatus::Completed`** | **CONFIRMED** | `spawn_exit_watcher` comment `service.rs:558-560`: "interactive agents (Claude, Codex, etc.) **almost never exit on their own** — they sit at a prompt waiting for input." The exit-watcher only fires on real process death (`:562-609`). Edge-satisfaction must key off a **file write**, per §0.1. |
| 5 | **`merge.rs` outcomes + reuse** | **CONFIRMED (one sub-claim corrected)** | `MergeOutcome::{Clean{message}, Conflicts{files}}` (`merge.rs:18-23`). `merge_into(worktree, source_ref, strategy)` merges *source* INTO the checked-out worktree (`:85-98`, requires clean index). `merge_to(main_repo, target, source, strategy)` checks out target in the main `.git` (`:104-`) — **wrong tool here** (it mutates the user's checkout; we want a dedicated worktree). **Use `merge_into` into an integration worktree.** **CORRECTED:** the brief's "the just-added `finish_if_running` pattern in `merge.rs`" is inaccurate — `finish_if_running` is a `WorkspaceRepo` store method (used by the exit-watcher, `service.rs:585`), **not** in `merge.rs`; not relevant to integration merge. |
| 6 | **Conflict flow reuses unchanged** | **CONFIRMED** | `git_merge_in_progress` / `git_abort_merge` / `git_continue_merge` / `git_set_resolution` all resolve their cwd via `workspace_cwd(repo, workspace_id)` (`commands/git.rs:61`). If the **parent row's `worktree_path` = the integration worktree**, every one of them works against the parent `workspace_id` with **zero new code**. Same for `git_status`/`git_diff` → the "one combined diff." |
| 7 | **`fswatch` availability — but it does NOT fit the contract signal** | **CONFIRMED exists / CORRECTED fit** | `fswatch.rs:52` `WorktreeWatchRegistry` (built on `notify` + `notify_debouncer_mini`). But it (a) needs an `AppHandle` and **emits a Tauri event to the frontend** (`:99`), not a Rust-side signal; (b) is worktree-scoped and ignores `.git` (`:25`); the contract dir is **outside** worktrees. It does **not** cleanly give the scheduler a server-side unblock signal. **CORRECTED: the scheduler POLLS the contract dir on its own tick** (mirrors the liveness poller), not fs-watch. `notify` remains available if we later want a watch. |
| 8 | **Scheduler = additive background poller, hot path untouched** | **CONFIRMED (template exists)** | `spawn_liveness_poller` (`service.rs:611`) + `run_liveness_tick` (`:630`) is the exact shape to copy: a `tokio::interval` task started once from `initialize_database_state` (`lib.rs:236`), reading DB rows, broadcasting via `broadcast_status` (`:551`). start_task internals + per-repo lock (`repo_locks.for_repository`, `service.rs:186`; `repo_locks.rs`) reused verbatim. |
| 9 | **Recovery rebuilds from DB, never blind-restarts** | **CONFIRMED + nuance** | `recover_startup_state` (`lib.rs:250-296`) lists `Running` → `Stopped` + `interrupted_at` **regardless of kind**, then `prune_worktrees`. So subtasks correctly land Stopped+interrupted (→ Wedged) on relaunch; parents are never `Running` so they're untouched. **The DAG is re-derived for free** because the scheduler reads ready/blocked from the DB tables on its first post-boot tick. No new recovery code needed beyond a boot-time re-eval; see E2-T3. |
| 10 | **Board state stays OUT of `WorkspaceStatus`** | **CONFIRMED** | `domain/workspace.rs:11-59` — 6-variant enum with a `from_str`/`as_str` round-trip test (`:159`) and a `can_transition_to` matrix. Adding `Blocked` breaks the round-trip + sync string. **"Blocked" is DAG-derived** (join `workspace_dependencies` × `workspace_contracts`), computed frontend-side, never stored. Same rule as Step 0's `DerivedState`. |
| 11 | **Sync stays machine-local with ZERO changes** | **CONFIRMED — cleaner than the brief implied** | `dirty_workspace_rows` (push) already hard-filters `workspace_kind = 'agent'` (`sync/mod.rs`, the `WHERE … workspace_kind = 'agent'` clause). So `parent`/`subtask` rows are **auto-excluded from push** exactly like `local`. The new columns (`parent_id`, `role`, dependency/contract tables) appear in **no** sync SELECT/INSERT list (`sync/mod.rs:688-742`, `:765-782`). **No `sync/mod.rs` edit is required for P0.** DAG sync is deferred (§G). |
| 12 | **Adding `WorkspaceKind::{Parent, Subtask}` is additive** | **CONFIRMED** | `domain/workspace.rs:64-88` — `{Agent, Local}`, `Copy`, `#[serde(rename_all="lowercase")]`, `as_str`/`from_str`, round-trip test `:178-185`. Two new variants touch only those fns + the test + the `is_local()` audit (§A note). Low blast radius. |

**`#EXPORT_CRITICAL` — the two must-fix cross-cutting edits** that a naïve reader will miss:
1. **Widen the liveness filter** (`service.rs:658`) from `!= Agent` to `!runs_agent()` — else subtask cards silently never show honest status (claim #3).
2. **New `find_active_subtask(parent_id, role)`** for subtask idempotency — never route subtasks through `find_active_by_name` (claim #2). `start_task` must branch on "is this a subtask?" before its dedup call (`service.rs:195-210`).

**`is_local()` audit** (parent spec §8 risk): with two new `Copy` variants, every `match` on `WorkspaceKind`
and every `is_local()` call site must stay correct. Sites: `store/workspaces.rs:52` (dirty flag), `:315`/`:365`/`:392`
(`CASE WHEN workspace_kind = 'local'`), the liveness filter `service.rs:658`, and the sync push filter. Parent
and Subtask are both **non-local**, so the `dirty`/`CASE` logic treats them as syncable-in-principle — but the
`= 'agent'` push filter (claim #11) still excludes them, so they stay local. Verify no `match` goes non-exhaustive.

---

## B. Architecture decisions (`#PATH_DECISION`)

**B1 — The parent row IS the integration container (reuse, don't add columns).** A `Parent` workspace has **no
PTY** and, until integration, no branch/worktree. At integration we set the **parent row's existing `branch` =
integration branch and `worktree_path` = integration worktree**. This makes the entire conflict-resolution +
diff surface (`git_merge_in_progress`, `git_abort_merge`, `git_continue_merge`, `git_set_resolution`,
`git_status`, `git_diff`) work against the **parent `workspace_id`** with zero new commands (claim #6).
**Consequence:** we do **not** add the brief's separate `integration_branch` column — it would duplicate
`workspaces.branch`. (Offered as reversible open decision §F-4.)

**B2 — The "Start N agents" gate is enforced by write-timing, not a flag.** Nothing is persisted until approval
(parent spec F1 AC: "nothing is written to the DB until approval"). The decomposition **draft lives entirely in
the frontend form**; a single command `start_decomposition` atomically writes `Parent + 2 Subtask + 1 edge`.
There is therefore **no `approved_at` column and no auto-fan-out** — a persisted parent is, by construction,
already approved. The scheduler processes every parent it finds.

**B3 — Edge-satisfaction = contract publication, detected by poll (§0.1 + claim #4/#7).** The scheduler polls
`~/.phasr/tasks/<parent_id>/contracts/`. When `backend.md` appears (non-empty), it writes a
`workspace_contracts` row (`published_at = now`) — the **file→DB bridge**. A dependent unblocks when **every
incoming edge's predecessor has a contract row**. This never keys off `WorkspaceStatus::Completed`. Poll, not
fs-watch, because `WorktreeWatchRegistry` doesn't fit (claim #7).

**B4 — Subtasks are `kind='subtask'` and spawn through `start_task` internals under the per-repo lock.** Reuse
`service.rs:149-291` verbatim: mint branch/worktree (`:224-233`), insert under the lock (`:186-243`), spawn PTY
(`:265-272`), attach the exit-watcher (`:286`). The **only** deltas: set `workspace_kind = Subtask`, stamp
`parent_id`/`role`, and dedup on `(parent_id, role)` instead of `(repo, name)` (claim #2).

**B5 — Contract handoff is prompt-seeding, no new template var.** The backend subtask's initial prompt is
appended with an instruction: *"When your work is done, write your API/interface contract to
`~/.phasr/tasks/<parent>/contracts/backend.md`."* When the scheduler unblocks `frontend`, it **reads
`backend.md` and concatenates it into `frontend`'s `prompt`** before spawn. `start_task` already interpolates
`{{prompt}}` (`interpolate_for_task`, `service.rs:~470`), so no new variable is required.

**B6 — Board is a NEW route; the sidebar filters out parent/subtask kinds (progressive disclosure).** Board
chrome appears only when a decomposition exists (parent spec §7). Subtask/parent rows must **not** clutter the
existing sidebar list (`AppSidebar.tsx:276-279` sorts kinds); add a filter so only `agent`/`local` show there.

**Data flow (P0):**

```
 Decomposition form (FE)  ──"Start 2 agents"──►  start_decomposition (IPC)
    { parent_prompt, [backend, frontend], edge backend→frontend }
                                                       │  atomic write under per-repo lock
                                                       ▼
                         workspaces:  Parent(pending) + backend(pending) + frontend(pending)
                         workspace_dependencies:  (backend → frontend)
                                                       │
                    scheduler tick (new poller, ~5s, service.rs mirror of :611)
                                                       │
   backend has no incoming edge  ──ready──►  start_task internals (kind=subtask, parent_id, role)
                                                       │  backend agent works, then writes:
                    ~/.phasr/tasks/<parent>/contracts/backend.md   ◄── (agent, or "mark done" override)
                                                       │
   scheduler poll detects file  ──►  INSERT workspace_contracts(published_at=now)
                                                       │
   frontend's only incoming edge now satisfied  ──►  read backend.md, seed into frontend.prompt,
                                                       start_task internals (kind=subtask)
                                                       │
   both subtasks done (backend=contract, frontend=mark-done/exit0)  ──user triggers──►
                                                       │
                    integrate_parent (IPC): create integration worktree on parent row,
                    topological merge_into(integration_wt, backend_branch), then (..., frontend_branch)
                                                       │
                    MergeOutcome::Conflicts?  ──►  EXISTING interactive resolve flow (parent workspace_id)
                    MergeOutcome::Clean       ──►  git_status/git_diff (parent workspace_id) = ONE combined diff
                                                       │
                    Board route (FE): parent card + 2 subtask cards, reusing
                    AgentStatusIndicator / AgentStatusBadge / deriveAgentState for honest per-card status,
                    plus a DAG-derived "blocked" tier computed frontend-side from edges × contracts.
```

---

## C. IPC contract delta (the 3-place Rust ↔ `tauri.ts` ↔ `types.ts` sync)

All additive. New commands live in a new `commands/board.rs`, registered in the `invoke_handler` list
(`lib.rs:157-163`). Existing `phasr://task-status` events (Step 0) already carry subtask liveness once the
`:658` filter is widened — **no event payload change** for honest status. One new event optional for board
refresh (below).

**1. Rust — new commands (`commands/board.rs`) + request/response structs:**

```rust
// Request: the approved plan. Roles/edges are hardcoded-topology for the PoC (backend → frontend).
pub struct DecompositionInput {
    pub repository_id: String,
    pub parent_prompt: String,
    pub subtasks: Vec<SubtaskInput>,          // PoC: exactly 2 — [backend, frontend]
    pub edges: Vec<EdgeInput>,                // PoC: exactly 1 — { from: "backend", to: "frontend" }
}
pub struct SubtaskInput { pub role: String, pub agent: Agent, pub prompt: String }
pub struct EdgeInput { pub from_role: String, pub to_role: String }

pub struct BoardState {                        // what the board route renders
    pub parent: Workspace,                     // kind=parent; branch/worktree set once integrated
    pub subtasks: Vec<Workspace>,              // kind=subtask, parent_id set, role set
    pub dependencies: Vec<WorkspaceDependency>,
    pub contracts: Vec<WorkspaceContract>,     // published_at drives "blocked" derivation FE-side
}

#[tauri::command] pub async fn start_decomposition(input: DecompositionInput, …) -> Result<BoardState, _>;   // B2 gate
#[tauri::command] pub async fn get_board(parent_id: String, …)               -> Result<BoardState, _>;
#[tauri::command] pub async fn publish_contract(subtask_id: String, …)       -> Result<WorkspaceContract, _>; // "mark done" override + test hook (F-9)
#[tauri::command] pub async fn integrate_parent(parent_id: String, strategy: MergeStrategy, …) -> Result<MergeOutcome, _>;
```

**2. `tauri.ts`** — add wrappers on the `tauri` object (`tauri.ts:85`): `startDecomposition`, `getBoard`,
`publishContract`, `integrateParent`. Each a thin `invoke(...)`. (Existing merge/diff/status wrappers reused
unchanged for the combined-diff + conflict flow against the parent id.)

**3. `types.ts`** — extend the `workspaceKind` union and add DAG types:

```ts
// types.ts:28 — extend the union (mirrors the Rust enum gaining Parent/Subtask)
workspaceKind: "agent" | "local" | "parent" | "subtask";
// Workspace also gains (additive, null for standalone agents):
parentId: string | null;
role: string | null;

export interface WorkspaceDependency { id: string; parentId: string; fromSubtaskId: string; toSubtaskId: string; }
export interface WorkspaceContract   { id: string; parentId: string; subtaskId: string; role: string; contractPath: string; publishedAt: string | null; }
export interface BoardState { parent: Workspace; subtasks: Workspace[]; dependencies: WorkspaceDependency[]; contracts: WorkspaceContract[]; }
export interface DecompositionInput { repositoryId: string; parentPrompt: string; subtasks: {role:string; agent:Agent; prompt:string}[]; edges: {fromRole:string; toRole:string}[]; }

// Board-only derived card state — NOT on the wire, NOT a WorkspaceStatus (claim #10):
export type BoardCardState = DerivedAgentState | "blocked" | "needs-review";
```

> `WorkspaceStatus` (`types.ts:4-10`) is **NOT** extended — no stored `blocked`. `"blocked"`/`"needs-review"`
> are frontend-derived board buckets, exactly as `resolving`/`stopped` are for Step 0.

**Optional board-refresh event.** The scheduler mutates DB rows (spawns a subtask, writes a contract) that the
board should reflect live. Options: (a) reuse the existing `phasr://task-status` bus — the board subscribes via
the same `useTaskEvents` and refetches `get_board` on any event for its parent's subtasks (**recommended, zero
new event**); (b) a new `phasr://board-changed` event. **Default: (a)** — one new event is not worth it for the
PoC.

---

## D. Config / constants (single source, referenced by tasks)

| Name | Where | Default | Notes |
|---|---|---|---|
| `SCHEDULER_POLL_INTERVAL` | Rust const (`orchestrator/scheduler.rs`) | **3 s** | Contract-detection + ready-eval latency. Mirrors `LIVENESS_POLL_INTERVAL` (5 s) shape. |
| `MAX_CONCURRENT_SUBTASKS` | Rust const | **4** | `tokio::Semaphore` cap. Barely exercised at N=2/single-edge; present so the shape is right. |
| `CONTRACT_ROOT` | Rust fn | `~/.phasr/tasks/<parent_id>/contracts/` | Sibling of `~/.phasr/worktrees` (`naming.rs:6`). **Outside** every worktree so `prune_worktrees` can't delete it (parent spec F2 rationale). |
| `CONTRACT_STABLE_MIN_BYTES` | Rust const | **1** | A contract counts as published when the file exists **and** is non-empty. Atomic-rename hardening = §F-2. |
| Board topology | hardcoded (PoC) | `backend → frontend` | The one edge. §F-1. |

Thresholds/interval must be **injectable in tests** (const with a `cfg(test)` override) so the scheduler tick
can be driven deterministically, exactly like `run_liveness_tick` is (`service.rs:630`).

---

## E. Task breakdown

Legend — Owner: **TE** = tauri-engineer, **FE** = fe-developer. Effort: S/M/L. **ALL Rust is ONE sequential TE
stream** (§E build order) — parallel Rust edits to `service.rs`/`workspaces.rs`/`lib.rs` = file-conflict hell.

### Enabler E1 — Data model + the two must-fix landmines (Rust) · owner TE · overall M

#### E1-T1 · Migration `0013` + `WorkspaceKind::{Parent,Subtask}` + `runs_agent()` + widen liveness filter · TE · **M** · dep: none
- **Files/fns:**
  - New `migrations/0013_multi_agent_task_board.sql` (additive, mirrors `0012_workspace_interrupted_at.sql`):
    `ALTER TABLE workspaces ADD COLUMN parent_id TEXT;` · `ADD COLUMN role TEXT;` (both NULL — existing rows
    untouched). `CREATE TABLE workspace_dependencies (id TEXT PK, parent_id TEXT, from_subtask_id TEXT,
    to_subtask_id TEXT, created_at TEXT);` · `CREATE TABLE workspace_contracts (id TEXT PK, parent_id TEXT,
    subtask_id TEXT, role TEXT, contract_path TEXT, published_at TEXT, created_at TEXT);`. Logical FKs only
    (match existing style). **No `integration_branch` column** (B1).
  - `domain/workspace.rs:64-88` — add `Parent`, `Subtask` to `WorkspaceKind` + `as_str`/`from_str` arms + the
    `round_trip` test (`:178`). Add `pub fn runs_agent(self) -> bool { matches!(self, Agent | Subtask) }`.
  - `domain/workspace.rs:90-116` — add `parent_id: Option<String>`, `role: Option<String>` to `Workspace`;
    default `None` in `new` (`:119`).
  - `store/workspaces.rs` — add both columns to `WorkspaceUpdate` (`:9-23`), the SELECT/INSERT/UPDATE column
    lists (`:59-68` insert; the shared SELECT list repeated across list/get methods; `row_to_workspace` at
    `:~410`).
  - **`service.rs:658`** — change `if workspace.workspace_kind != WorkspaceKind::Agent` to
    `if !workspace.workspace_kind.runs_agent()` (**claim #3 fix — subtask honest status**).
- **AC — Given** migration `0013` runs on a v0.2.4 DB, **when** the app boots, **then** all existing rows are
  untouched and `parent_id`/`role` default NULL; **Given** `WorkspaceKind::{Parent,Subtask}`, **then** the
  round-trip test passes for all four variants; **Given** a running `kind='subtask'` agent silent past the idle
  threshold, **when** the liveness poller ticks, **then** it emits a derived state for that subtask (regression
  guard against `:658`).
- **IPC delta:** §C place 3 (`workspaceKind` union + `parentId`/`role`). **Effort:** M. **Owner:** TE.

#### E1-T2 · Subtask idempotency + DAG store methods · TE · **M** · dep: E1-T1
- **Files/fns:** `store/workspaces.rs` — new `find_active_subtask(parent_id, role) -> Option<Workspace>`
  (`WHERE parent_id = ? AND role = ? AND workspace_kind = 'subtask' AND status IN ('pending','running') AND
  deleted_at IS NULL`, mirroring `find_active_by_name` `:214`); `list_by_parent(parent_id) -> Vec<Workspace>`.
  New `store/dependencies.rs` + `store/contracts.rs` (or fold into `workspaces.rs`): `insert_dependency`,
  `list_dependencies(parent_id)`, `insert_contract`, `list_contracts(parent_id)`, `find_contract(subtask_id)`.
  Register in `store/mod.rs`.
- **AC — Given** two parents each owning a `backend`-role subtask, **when** each is created, **then**
  `find_active_subtask` keys on `(parent_id, role)` so neither hijacks the other (the parent-spec #3 landmine
  regression); **Given** a subtask that has stopped/completed, **then** it is **not** active, so a re-run starts
  fresh; **Given** `list_dependencies`/`list_contracts`, **then** they return only the given parent's rows.
- **IPC delta:** none (internal). **Effort:** M. **Owner:** TE.

### Enabler E2 — Scheduler + fan-out + contract handoff (Rust) · owner TE · overall L

#### E2-T1 · `start_decomposition` — atomic Parent+Subtask+edge write (the gate) · TE · **M** · dep: E1-T2
- **Files/fns:** new `commands/board.rs::start_decomposition`. Under the per-repo lock
  (`repo_locks.for_repository`, `service.rs:186`): insert `Parent` (`kind=Parent`, `status=Pending`, prompt =
  `parent_prompt`, no branch/worktree yet); insert each `Subtask` (`kind=Subtask`, `status=Pending`,
  `parent_id`, `role`, `agent`, `prompt`); insert the `workspace_dependencies` edge(s). Owner-stamp via the
  session (mirror `start_task` command `commands/orchestrator.rs:50-72`). Return `BoardState`. **Does NOT spawn**
  — the scheduler does (decouples the gate from fan-out).
- **AC — Given** an approved 2-subtask plan, **when** `start_decomposition` runs, **then** exactly 1 parent + 2
  subtasks + 1 edge are persisted atomically, **and nothing spawns yet** (no worktree/PTY created by this call);
  **Given** the write fails partway, **then** no orphan rows remain (single transaction / lock-guarded).
- **IPC delta:** §C places 1+2+3. **Effort:** M. **Owner:** TE.

#### E2-T2 · The scheduler (dependency-aware background poller) · TE · **L** · dep: E2-T1, E1-T2
- **Files/fns:** new `orchestrator/scheduler.rs` + `spawn_scheduler(&self)` / `run_scheduler_tick(&self)` on
  `TaskOrchestrator`, **structurally cloned from** `spawn_liveness_poller`/`run_liveness_tick`
  (`service.rs:611-706`): a `tokio::interval(SCHEDULER_POLL_INTERVAL)` task started **once** from
  `initialize_database_state` (`lib.rs:236`, next to `spawn_liveness_poller`). Each tick, for every parent with
  non-terminal subtasks:
  1. **Detect publication:** scan `CONTRACT_ROOT/<parent>/contracts/*.md`; for each non-empty file with no
     `workspace_contracts` row, `insert_contract(published_at=now)` (the file→DB bridge, B3).
  2. **Compute ready:** a `pending` subtask is **ready** iff every incoming edge's predecessor has a contract
     row. Cap in-flight via `MAX_CONCURRENT_SUBTASKS` (`tokio::Semaphore`).
  3. **Spawn ready:** for the root (`backend`, no incoming edge) → `start_task` internals with the
     contract-path instruction appended to its prompt (B5). For an unblocked dependent (`frontend`) → **read
     the predecessor's contract file and concatenate into its prompt**, then spawn. Dedup via
     `find_active_subtask` (E1-T2) so a double-tick can't double-spawn.
  All git ops under the per-repo lock (reused from `start_task`). Zero writes to the PTY hot path (additive
  consumer, claim #8).
- **AC — Given** a fresh decomposition, **when** the scheduler ticks, **then** `backend` spawns (own
  worktree+branch, `kind=subtask`) and `frontend` does **not** (its edge is unsatisfied); **Given** `backend`
  writes `contracts/backend.md`, **when** the next tick runs, **then** a `workspace_contracts` row is recorded
  **and** `frontend` spawns with `backend.md`'s contents seeded into its initial prompt; **Given** `backend` is
  Wedged/never publishes, **then** `frontend` stays unspawned (no false unblock, §0.1); **Given** a duplicate
  tick, **then** `find_active_subtask` prevents a second `frontend` worktree.
- **IPC delta:** none (consumes DB + emits via existing status bus). **Effort:** L. **Owner:** TE.
- **#PLAN_UNCERTAINTY** poll vs fs-watch resolved to poll (claim #7); atomic-write robustness → §F-2.

#### E2-T3 · Recovery: re-derive the DAG on boot (no blind restart) · TE · **S** · dep: E2-T2
- **Files/fns:** mostly **free** — `recover_startup_state` (`lib.rs:250-296`) already stops orphaned `Running`
  subtasks (→ `interrupted_at` → Wedged) and leaves parents alone (they're never `Running`). The scheduler's
  first post-boot tick re-derives ready/blocked from the DB tables (contracts persist; `interrupted_at` marks
  the Wedged predecessor). The only required guard: the scheduler must **not** re-spawn a subtask that was
  interrupted mid-flight (it's `Stopped`+`interrupted_at`, not `Pending`) — the "ready = only `pending`" rule
  in E2-T2 already ensures this. Add a unit test asserting it.
- **AC — Given** a relaunch mid-fan-out (backend Running, frontend Pending-blocked), **when** recovery runs,
  **then** backend → Stopped+interrupted (Wedged), frontend stays Pending, **and** the scheduler does **not**
  auto-restart backend; **Given** backend had already published its contract before the crash, **then** the
  contract row survives and frontend is spawnable once the user restarts backend or marks it done.
- **IPC delta:** none. **Effort:** S. **Owner:** TE.

#### E2-T4 · `publish_contract` — manual "mark done" override + test hook · TE · **S** · dep: E1-T2
- **Files/fns:** `commands/board.rs::publish_contract(subtask_id)` — writes `CONTRACT_ROOT/<parent>/contracts/
  <role>.md` (if the agent hasn't) **and** inserts the `workspace_contracts` row directly, so a forgetful agent
  or a leaf subtask (`frontend`, no consumer) isn't a dead end (parent spec §8 risk). Doubles as the
  deterministic test hook for E2-T2 (skip waiting on a real agent to write a file).
- **AC — Given** a running subtask whose agent won't write a contract, **when** the user clicks "Mark done",
  **then** a contract row + file appear and any dependent unblocks on the next tick; **Given** the leaf
  `frontend`, **then** "Mark done" marks it ready-for-integration without requiring a consumer.
- **IPC delta:** §C places 1+2. **Effort:** S. **Owner:** TE.

### Enabler E3 — Integration merge + combined diff (Rust) · owner TE · overall M

#### E3-T1 · `integrate_parent` — dedicated integration worktree + topological merge · TE · **M** · dep: E2-T2, E1-T1
- **Files/fns:** `commands/board.rs::integrate_parent(parent_id, strategy)`. Under the per-repo lock: mint an
  integration branch `phasr/integration/<parent-slug>-<short_id>` (via `default_branch_name`/`unique_branch_name`,
  `naming.rs:42/49`) and worktree at `default_worktree_base_path().join(parent_id)` (`git::create_worktree`,
  `worktree.rs:19`), from the repo default branch. **Set the parent row's `branch` + `worktree_path` to these**
  (B1). Topologically sort subtasks by `workspace_dependencies`; for each in order,
  `git::merge_into(&integration_worktree, &subtask_branch, MergeStrategy::Merge)` (`merge.rs:85`). On the first
  `MergeOutcome::Conflicts`, **return it** — the user resolves via the existing flow keyed on the parent
  `workspace_id` (claim #6); `git_continue_merge` resumes; the scheduler/command need no new conflict UI.
- **AC — Given** both subtasks done and non-overlapping, **when** `integrate_parent` runs, **then** an
  integration worktree is created (**never** the user's checkout), both branches merge in topological order
  (`backend` before `frontend`), and the parent row now points at the integration branch/worktree; **Given**
  overlapping edits, **then** `MergeOutcome::Conflicts{files}` surfaces to the existing `git_merge_in_progress`/
  `git_abort_merge`/`git_continue_merge`/`git_set_resolution` flow against the parent id; **Given** integration
  completes, **then** the parent's `git_status`/`git_diff` is the **one combined diff**.
- **IPC delta:** §C places 1+2 (`integrateParent` → `MergeOutcome`). **Effort:** M. **Owner:** TE.

### Story S1 — Decomposition form (the "Start 2 agents" gate) · owner FE · overall M

#### S1-T1 · IPC types + wrappers + board-derived state · FE · **M** · dep: §C frozen
- **Files/fns:** `types.ts:28` extend `workspaceKind`; add `parentId`/`role`/`WorkspaceDependency`/
  `WorkspaceContract`/`BoardState`/`DecompositionInput`/`BoardCardState` (§C place 3). `tauri.ts:85` add the
  four wrappers. New `src/lib/deriveBoardState.ts` — wraps `deriveAgentState` (Step 0,
  `deriveAgentState.ts`) and adds the **`blocked`** tier: a `pending` subtask with an unsatisfied incoming edge
  (join `dependencies` × `contracts` client-side) → `blocked`; a done subtask awaiting integration →
  `needs-review`. **Never a stored status** (claim #10).
- **AC — Given** the frozen contract, **then** FE compiles against it before the Rust is done (unblocks the
  parallel stream); **Given** a subtask whose predecessor has no contract row, **then** `deriveBoardState`
  returns `blocked` (neutral/muted, never coral — "it is not on you", parent spec §2 Blocked row); **Given** a
  running subtask, **then** it reuses Step 0's honest `working/idle/wedged`.
- **IPC delta:** consumes §C. **Effort:** M. **Owner:** FE.

#### S1-T2 · Decomposition form + "Start 2 agents" · FE · **M** · dep: S1-T1
- **Files/fns:** new component (e.g. `src/components/DecomposeForm.tsx`) reachable from the repository view: two
  role rows (`backend`, `frontend`) each with an editable prompt textarea (reuse `GlassInput`/glass tokens),
  the **fixed** `backend → frontend` edge shown read-only, and a primary **"Start 2 agents"** button calling
  `startDecomposition`. Draft state is **frontend-only** until the button (B2). On success, navigate to the
  board route (S2-T1).
- **AC — Given** two prompts, **when** the user clicks "Start 2 agents", **then** exactly one
  `startDecomposition` fires and the app routes to the board; **Given** the form before submit, **then**
  **nothing** is persisted (no parent/subtask rows) — the gate holds; **Given** a spawn/create failure, **then**
  an honest error toast (reuse `humanizeError.ts`), not a silent no-op.
- **IPC delta:** consumes §C. **Effort:** M. **Owner:** FE.

### Story S2 — Minimal read-only board + combined-diff review · owner FE · overall M

#### S2-T1 · Board route + parent/subtask cards (reuse Step 0 status) · FE · **M** · dep: S1-T1
- **Files/fns:** new route `src/routes/_app/repositories/$repositoryId/board.$parentId.tsx` (add to
  `routeTree.gen.ts` via the generator). Fetch `getBoard`; subscribe to `phasr://task-status` via `useTaskEvents`
  and refetch on any event for this parent's subtasks (§C optional-event default (a)). Render the parent + 2
  subtask **cards** (not terminals) in simple columns (Blocked → In Progress → Review → Done, derived by
  `deriveBoardState`, **auto-advancing, not draggable**). Each card reuses **`AgentStatusIndicator`**
  (`components/ui/AgentStatusIndicator.tsx`) / **`AgentStatusBadge`** (`components/AgentStatusBadge.tsx`) for
  honest per-card status. A card's "Mark done" action calls `publishContract`. Opening a card focuses that one
  agent's terminal (at most one live terminal on screen, as today).
- **AC — Given** a decomposed parent, **then** the board shows 1 parent + 2 subtask cards that **auto-move**
  across columns as derived state changes (backend: Working→…→Review after contract; frontend: Blocked→Working
  after handoff); **Given** a blocked subtask, **then** its card is neutral/muted with a lock affordance, never
  coral; **Given** a wedged subtask, **then** the Step 0 Wedged treatment renders (no pulse, AA both themes);
  **Given** no decomposition, **then** this route isn't reachable and the sidebar is unchanged (S2-T3).
- **IPC delta:** consumes §C. **Effort:** M. **Owner:** FE.

#### S2-T2 · Combined-diff review + integrate action · FE · **S** · dep: S2-T1, E3-T1
- **Files/fns:** on the board's Done/Review area, an **"Integrate & review"** button calling `integrateParent`,
  then rendering the parent's combined diff by **reusing the existing diff UI** (`DiffList`/`DiffView`,
  `git_status`/`git_diff` against the **parent `workspace_id`** — B1). On `MergeOutcome::Conflicts`, route to
  the **existing** conflict resolution surface (`MergeToMainDialog` idiom / `git_merge_in_progress` etc.) keyed
  on the parent id — no new conflict UI.
- **AC — Given** both subtasks done, **when** the user clicks "Integrate & review", **then** one combined diff
  for the whole parent renders (reused diff UI); **Given** a conflict, **then** the existing resolve flow opens
  against the parent worktree and `git_continue_merge` completes it; **no** Failed/Conflict surface is a dead
  end (DDR-002).
- **IPC delta:** consumes §C + reuses existing merge/diff wrappers. **Effort:** S. **Owner:** FE.

#### S2-T3 · Sidebar filter (progressive disclosure) · FE · **S** · dep: S1-T1
- **Files/fns:** `AppSidebar.tsx:276` — extend the `.filter(...)` to exclude `parent`/`subtask` kinds so they
  live only on the board and don't pollute the flat workspace list (B6). Leave the existing `local`/`agent`
  ordering (`:278-279`) intact.
- **AC — Given** a decomposition exists, **then** the main sidebar list looks **identical to today** (no parent/
  subtask rows leak in); **Given** no decomposition, **then** nothing changes at all.
- **IPC delta:** none. **Effort:** S. **Owner:** FE.

---

## F. Build order & critical path

**Golden rule (learned the hard way):** **ALL backend is ONE sequential tauri-engineer stream.** Every Rust
task touches the shared hot files (`service.rs`, `store/workspaces.rs`, `lib.rs`, `domain/workspace.rs`);
parallel Rust edits = merge-conflict hell. The board UI is a **separate fe-developer stream** that parallelizes
off a **frozen IPC contract** (§C).

**Backend stream (TE, sequential — the critical-path spine):**
```
E1-T1 (migration + kinds + runs_agent + liveness fix)   ← foundational, everything depends on it
   └─► E1-T2 (find_active_subtask + DAG store methods)
          └─► E2-T1 (start_decomposition gate)
                 └─► E2-T2 (scheduler)                    ← the long pole
                        ├─► E2-T3 (recovery re-derive)    ← mostly free, lands with the scheduler
                        └─► E2-T4 (publish_contract override)
                               └─► E3-T1 (integrate_parent)
```
Critical path (one line): **`E1-T1 → E1-T2 → E2-T1 → E2-T2 → E3-T1`.** E2-T3/E2-T4 hang off E2-T2 without
extending the path.

**Frontend stream (FE, parallel after the §C contract is frozen — i.e. right after E2-T1 fixes the shapes):**
```
S1-T1 (types + wrappers + deriveBoardState)   ← the only FE task gated on the contract; do it first
   ├─► S1-T2 (decompose form / "Start 2 agents")
   ├─► S2-T1 (board route + cards, reusing Step 0 status)
   │      └─► S2-T2 (combined-diff review + integrate)   ← runtime-needs E3-T1, but buildable against the stub
   └─► S2-T3 (sidebar filter)                            ← fully independent, do anytime after S1-T1
```

**Genuinely parallelizable:** the entire FE stream (S1-T1 → S1-T2/S2-T1/S2-T3) runs alongside the TE stream once
§C is frozen. FE can build and unit-test against a mocked IPC (the repo's mocked-IPC e2e harness) — but heed the
**testing blind-spot**: the mocked harness verifies flows *fire the right command*, it can't catch backend/data
bugs, so the end-to-end contract-handoff proof **must** be exercised against the real Rust (a manual demo +
`publish_contract` as the deterministic hook). **Integration points (must be real, not mocked):** contract
file→DB detection (E2-T2), the prompt-seeding handoff (B5), and the topological merge (E3-T1).

**Suggested sequencing:** land **E1-T1 → E1-T2 → E2-T1** first; freeze §C; then run TE (`E2-T2 → E3-T1`) and FE
(`S1-T1 → …`) as two streams; converge on a manual end-to-end demo (backend spawns → writes contract → frontend
seeded → integrate → one diff).

---

## G. Explicitly DEFERRED (kept out of P0 to stay thin)

| Deferred | Why it's safe to defer | Where it lands |
|---|---|---|
| **Arbitrary DAGs** (N subtasks, multi-edge, fan-in/out) | PoC proves the mechanism with a fixed 2-node/1-edge topology; the store + scheduler are written generically but only exercised on the fixed shape | Phase 1 full / Phase 2 |
| **LLM auto-decomposition** | Manual editable form (S1-T2) proves the gate; LLM is a pluggable *input* to the same command | P1 (parent spec §8 decision 2) |
| **tmux/dtach durable sessions** | §0.1 shows exit≠done, so durable sessions buy survivability, not completion-detection; recovery (E2-T3) via DB-reconstruction is enough for P0 | Phase 3 (parent spec §7) |
| **DAG sync to Supabase** | Auto-excluded by the existing `workspace_kind='agent'` push filter (claim #11); board is machine-local by construction | Phase 3 |
| **Auto-conflict-resolution** | Reuse the existing interactive resolve flow (claim #6) — no new conflict UI, no auto-merge cleverness | never (rejected) |
| **Full read-only pipeline board (S3.2) + Needs-you worklist (S3.1)** | P0 board = minimal per-parent cards (S2-T1); the cross-everything worklist and full-state matrix are P1 | P1 (parent spec F3) |
| **Orphaned-worktree GC (E4)** | Still pending from the P0 perf program; the board multiplies the debt (N worktrees/parent) but GC is orthogonal to proving the slice | P1 (MEMORY: "orphaned-worktree GC still pending") |
| **CPU-activity liveness (E-P1)** | Step 0's output-recency honest status is enough for P0 subtask cards | P1 (`step0` §E-P1) |
| **Concurrency-cap tuning** | `MAX_CONCURRENT_SUBTASKS=4` const is barely exercised at N=2 | P1 |
| **Separate `integration_branch` column** | Reuse the parent row's `branch`/`worktree_path` (B1) | reversible, §F-4 |

---

## H. Open decisions (with recommended defaults, so nobody is blocked)

**F-1 · The 2-subtask topology + roles.** **Default: `backend → frontend`, single edge, both on the same agent
(Claude).** `backend` has no incoming edge (spawns immediately); `frontend` depends on `backend`'s contract.
This is the canonical decompose-and-handoff shape and exercises exactly one blocking edge. *(Alternative:
`schema → api`; same shape, arbitrary naming — no reason to prefer it.)*

**F-2 · Contract file format + publication convention.** **Default: freeform Markdown at
`~/.phasr/tasks/<parent_id>/contracts/<role>.md`; "published" = file exists AND non-empty; a
`workspace_contracts` row mirrors it (`published_at`).** Outside all worktrees so `prune_worktrees` can't eat it
(parent spec F2). **Hardening (recommend for E2-T2, cheap):** the agent (and `publish_contract`) writes
`<role>.md.tmp` then `rename`s to `<role>.md` so the poller never reads a half-written file. Format stays
freeform for the PoC (the "contract" is a handoff note — "here's the API I built"); a structured schema is P1.

**F-3 · How decomposition is supplied.** **Default: a minimal frontend form (S1-T2) — two editable prompt
fields + a fixed read-only `backend → frontend` edge — behind "Start 2 agents".** It's barely more work than
hardcoding, exercises the real F1 gate, and keeps the draft frontend-only (B2). *(Pure-hardcoded is fine as a
day-1 smoke test, but the form is the honest proof of the gate.)*

**F-4 · Integration-branch naming + the `integration_branch` column.** **Default: branch
`phasr/integration/<parent-slug>-<short_id>` (via `naming.rs`), worktree at `worktrees/<parent_id>`, stored in
the parent row's existing `branch`/`worktree_path` — no separate `integration_branch` column** (B1). This buys
the whole conflict/diff surface for free (claim #6). *Reversible:* if a future phase needs the parent to hold
both its own branch and a distinct integration branch, add the column then.

**F-5 · Board = new route vs. sidebar fold-in.** **Default: a NEW route
`/repositories/$repositoryId/board/$parentId`, with the sidebar filtering out parent/subtask kinds (S2-T3).**
Progressive disclosure: board chrome only exists once a decomposition does; the single-agent experience is
untouched. *(Folding into the sidebar would leak epic chrome into the calm default — rejected.)*

**F-6 · Contract detection — poll vs fs-watch.** **Default: poll on the scheduler tick** (claim #7).
`WorktreeWatchRegistry` needs an `AppHandle`, emits to the frontend, and is worktree-scoped; the contract dir is
outside worktrees. A 3 s poll matches the coarse latency budget and mirrors the proven liveness-poller shape.
*(fs-watch via `notify` is available if a later phase wants sub-second handoff.)*

**F-7 · "Mark subtask done" affordance.** **Default: always-available on a running/idle subtask card, via
`publish_contract` (E2-T4)** — it's both the manual override for a forgetful agent (so a stuck edge is never a
silent dead end, parent spec §8 risk) and the deterministic test hook. *(Restricting it to "idle-with-contract"
is a P1 refinement.)*

---

## I. Validation commands (P0 exit gate)

```bash
# Rust — enums, both landmine regressions, scheduler, recovery, integration merge
cargo test -p phasr domain::workspace           # WorkspaceKind round-trip incl. Parent/Subtask (E1-T1)
cargo test -p phasr store::workspaces           # find_active_subtask keys on (parent_id, role), not name (E1-T2)
cargo test -p phasr orchestrator::liveness      # subtask (kind='subtask') still gets derived state (claim #3 fix)
cargo test -p phasr orchestrator::scheduler     # ready/blocked derivation, contract→spawn handoff, no false unblock
cargo test -p phasr git::merge                  # merge_into into a dedicated worktree, Conflicts surfaces

# Frontend — types compile against the frozen contract, board derivation
pnpm typecheck && pnpm lint

# Manual end-to-end demo (the actual proof — mocked IPC cannot catch this, per the testing blind-spot note):
#  1. "Start 2 agents" → backend spawns in its own worktree, frontend stays Blocked on the board
#  2. backend writes ~/.phasr/tasks/<parent>/contracts/backend.md  (or click "Mark done")
#  3. scheduler seeds backend.md into frontend's prompt, frontend spawns
#  4. both done → "Integrate & review" → ONE combined diff on the parent worktree
echo "P0 SUCCESS" || echo "P0 FAILED"
```

**Exit gate:** the manual demo completes end-to-end (fan-out → contract handoff → integration → one combined
diff) on the real Rust; both landmine regressions (claim #2 subtask dedup, claim #3 subtask liveness) have
passing tests; no card ever lies (Step 0 invariant holds for subtask cards); the single-agent sidebar is
unchanged (S2-T3).
