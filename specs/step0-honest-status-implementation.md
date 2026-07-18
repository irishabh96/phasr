# Step 0 — Honest Status: Implementation Breakdown

**Parent spec:** [`multi-agent-task-board-spec.md`](./multi-agent-task-board-spec.md) §0.1 (process-exit ≠ task-done)
+ §2 (E0 / S0.1 / S0.2). **Mode:** story elaboration → implementation-ready. **Date:** 2026-07-18.
**Mockup:** `scratchpad/step0-honest-status-mockup.html` (tokens transcribed from `src/index.css`).

This is not new strategy. It turns the settled §2 acceptance criteria into files-to-touch, Given/When/Then,
the IPC contract delta, thresholds, effort, deps, and owners. Every load-bearing claim cites `file:line`.

---

## A. Architecture decision (`#PATH_DECISION`)

**Decision (1 line):** **Backend-authoritative derivation with the activity stamp in-memory and one persisted
"interrupted" bit** — the PTY pump stamps an in-memory `last_activity` atomic (zero DB, zero lock on the hot
path), a single orchestrator liveness-poller computes the derived state server-side and pushes transitions +
the raw `last_activity_at` timestamp over the existing `phasr://task-status`; the frontend renders the state
and runs a purely-cosmetic 1 Hz ticker to count "Ns ago" upward between events.

This is a **hybrid leaning A**, chosen against the two options in the brief:

| Constraint (from §0.1 / brief) | Pure B (frontend-only derive) | **Chosen: backend-authoritative** |
|---|---|---|
| Wedged must fire with **no output arriving** (a timer, not an event) | ✅ local ticker can | ✅ 5 s poller crosses the threshold |
| Wedged must survive the **app being quit** (recovery) | ❌ in-memory JS state dies with the window; a relaunched-orphan can't be told from a user-stop client-side | ✅ recovery runs in `lib.rs::recover_startup_state` (`lib.rs:246`) and persists the `interrupted_at` bit |
| The **scheduler (E2) needs the same signal server-side** — §0.1: "honest status *is* the completion-detection substrate the scheduler is built on" | ❌ derived state trapped in the renderer; the Rust scheduler can't consume it | ✅ derived state is produced in Rust, so E2 subscribes to the same broadcast |
| Don't thrash SQLite with a per-output-byte write | ✅ | ✅ `last_activity` is an in-memory `AtomicI64`; the only DB write is once-per-boot in recovery over ≤N rows |

Pure A (emit every derived transition **and** a 1 Hz "still working" tick over the bus) is rejected as an
event storm; pure B fails recovery and the server-side scheduler. The hybrid keeps the **authority** in Rust
(one source of truth for both the UI and E2) while keeping the **1 Hz "Ns ago" cosmetics** local so the bus
only ever carries **transitions** (a handful per task lifecycle — matching today's `STATUS_BROADCAST_CAPACITY`
= 256, `service.rs:47`).

### Data flow

```
 pty/handle.rs::pump_pty_output (:316-374)              orchestrator liveness-poller (new, ~service.rs)
   every non-empty chunk (:339, :367):                   tokio::interval(5s):
     handle.last_activity.store(now_ms, Relaxed) ──►       for each Running agent row (list_by_status):
       (one relaxed atomic, no lock, no DB)                  elapsed = now - handle.last_activity_ms()
                                                             derived = classify(elapsed, thresholds)
 recover_startup_state (:246-296):                          if derived != last_emitted[task]:
   orphaned Running → Stopped + interrupted_at=now ──►         status_tx.send(TaskStatusEvent{
       (persisted, survives the relaunch)                        status: Running,           // unchanged
                                                                 derived_state: Some(derived),
 spawn_exit_watcher (:527-577):                                  last_activity_at: Some(ts),
   PtyEvent::Exit → Completed/Failed (unchanged) ──►          })
                                                        │
                                     status_tx (broadcast, service.rs:128)
                                                        │
                        spawn_status_bridge (commands/orchestrator.rs:174-187)
                                                        │
                                     app.emit("phasr://task-status", payload)   // + derivedState, lastActivityAt
                                                        │
                    ┌───────────────────────────────────┴───────────────────────────────┐
        useTaskEvents (:28)                                        useCompletionNotifications (:322)
        → agentLiveness store {derivedState, lastActivityAt}       → +Wedged trigger (S0.2)
                    │
     deriveAgentState(row, live, now)  ← 1 Hz useNow() ticker (cosmetic "Ns ago")
                    │
     AgentStatusIndicator (sidebar row)  +  AgentStatusBadge (header)
```

**Why `last_activity` is in-memory but `interrupted_at` is persisted:** live activity is high-frequency and
ephemeral, so it stays an atomic to avoid SQLite thrash; the interrupted marker must, *by definition*, survive
the process restart it describes — a relaunched orphan (`lib.rs:253-274`) is indistinguishable from a
user-`stop_task` (`service.rs:300-317`, both land `Stopped` + `finished_at`, both leave `exit_code = None`)
unless we persist the discriminator. One nullable column is the minimum honest cost. (Zero-migration fallback
in §F if we choose not to ship a column in Step 0.)

---

## B. IPC contract delta (the 3-place Rust↔`tauri.ts`↔`types.ts` sync)

`phasr://task-status` is an **event**, not a command, so `tauri.ts` carries no `invoke` change — the "3rd place"
is the **event payload type** in `types.ts`. The delta is **additive** (all new fields optional) so
`useCompletionNotifications` (`useCompletionNotifications.ts:290`) keeps working unchanged.

**1. Rust — `TaskStatusEvent` (`orchestrator/service.rs:52-59`) + wire payload (`commands/orchestrator.rs:189-205`):**
```rust
// service.rs — add two fields (both Option so exit-watcher path leaves them None)
pub struct TaskStatusEvent {
    pub task_id: String,
    pub repository_id: String,
    pub status: WorkspaceStatus,                 // UNCHANGED — stored enum, no Wedged variant
    pub exit_code: Option<i64>,
    pub derived_state: Option<DerivedState>,     // NEW — the honest state
    pub last_activity_at: Option<DateTime<Utc>>, // NEW — raw ts; frontend counts "Ns ago" from it
}

// new enum, NOT in domain::workspace (derived state stays out of WorkspaceStatus, validation #1)
// orchestrator/liveness.rs
pub enum DerivedState { Working, NeedsAttention, Wedged, Done, Failed }  // #[serde(rename_all="kebab-case")] → "needs-attention"

// commands/orchestrator.rs::event_payload (:198) — add the two fields to TaskStatusPayload (:189)
```

**2. `tauri.ts`** — no `invoke` wrapper changes (event-driven; the `tauri` object at `tauri.ts:85` is untouched).
Optional: none.

**3. `types.ts`** — extend `TaskStatusPayload` (`types.ts:96-101`) and `Workspace` (`types.ts:25-42`):
```ts
export type DerivedAgentState =
  | "resolving" | "working" | "needs-attention" | "wedged" | "done" | "failed" | "stopped";

export interface TaskStatusPayload {
  taskId: string; repositoryId: string; status: WorkspaceStatus; exitCode: number | null;
  derivedState: DerivedAgentState | null;   // NEW  (backend emits working|needs-attention|wedged)
  lastActivityAt: string | null;            // NEW  ISO ts
}

export interface Workspace { /* … */ interruptedAt: string | null; }  // NEW mirrors interrupted_at column
```
> `WorkspaceStatus` (`types.ts:4-10`) is **NOT** extended — no `wedged` stored value (mirrors the Rust
> invariant, spec validation #1). `resolving`/`stopped` in `DerivedAgentState` are **frontend-only** buckets.

---

## C. Config / thresholds (single source, referenced by tasks)

| Name | Where | Default | Notes |
|---|---|---|---|
| `IDLE_THRESHOLD` | Rust const (liveness.rs), test-overridable | **60 s** | Working → NeedsAttention. §F-1 debates 60 vs 90 s. |
| `WEDGED_THRESHOLD` | Rust const | **180 s** | NeedsAttention → Wedged ("≫ idle", spec). |
| `LIVENESS_POLL_INTERVAL` | Rust const | **5 s** | Transition latency ≤5 s on a 60/180 s scale. |
| `RESOLVING_GRACE` | frontend const | **2 s** | `running` + `<2 s` since `startedAt` + no live event → "Starting…", never Wedged/idle. |
| `NOW_TICK_MS` | frontend const | **1000 ms** | Cosmetic "Ns ago"; runs only while ≥1 agent is live. |
| `WEDGED_NOTIFY_COOLDOWN` | frontend const | **10 min/agent** | Anti-flap for the S0.2 notification. |
| `CPU_BUSY_THRESHOLD` *(P1)* | Rust const (E-P1-T3) | **5 % of one core** over the interval | Silent + CPU above this = busy-but-quiet → stay Working, not Wedged. §F-7. |

Thresholds must be **injectable in tests** (const with an env/`cfg(test)` override) so `cargo test` can use
1 s/2 s instead of 60 s/180 s.

---

## D. Task breakdown

Legend — Owner: **TE** = tauri-engineer, **FE** = fe-developer. Effort: S/M/L.

### Enabler E0 — Activity & liveness model (Rust) · owner TE · overall M

#### E0-T1 · Stamp `last_activity` on the PTY pump · TE · **S** · dep: none
- **Files/fns:** `pty/handle.rs` — add `last_activity: Arc<AtomicI64>` to `PtyHandle` (:79-93); init to
  spawn-time in `spawn` (:184); stamp inside `pump_pty_output` on every non-empty chunk (right before the two
  `tx.send(event)` at **:339** and **:367**); expose `pub fn last_activity_ms(&self) -> i64`. Pass the `Arc`
  clone into `pump_pty_output` (:240-246) like `replay_for_thread`.
- **AC — Given** a spawned PTY, **when** it emits output, **then** `last_activity_ms()` advances to ~now;
  **and** the write is a single `store(_, Relaxed)` — **no** lock and **no** DB touch on the pump path
  (hot-path invariant, spec E0 AC5).
- **IPC delta:** none. **Effort:** S. **Owner:** TE.

#### E0-T2 · `DerivedState` + classifier · TE · **S** · dep: none
- **Files/fns:** new `orchestrator/liveness.rs` — `enum DerivedState` (§B), `fn classify(elapsed_ms, now_running: bool, has_handle: bool) -> DerivedState` using the §C thresholds; `mod liveness` in `orchestrator/mod.rs`.
- **AC — Given** elapsed `< IDLE_THRESHOLD` → `Working`; **Given** `IDLE..WEDGED` → `NeedsAttention`;
  **Given** `> WEDGED_THRESHOLD` **or** a `Running` row with **no live handle** → `Wedged`. Pure fn, unit-tested.
- **IPC delta:** enum feeds §B place 1. **Effort:** S. **Owner:** TE.

#### E0-T3 · Liveness poller (server-side derivation + emit) · TE · **M** · dep: E0-T1, E0-T2
- **Files/fns:** `orchestrator/service.rs` — add `fn spawn_liveness_poller(&self)` mirroring the
  subscribe-never-block shape of `spawn_exit_watcher` (:527); a `tokio::time::interval(LIVENESS_POLL_INTERVAL)`
  that each tick: `workspaces.list_by_status(Running)` (`store/workspaces.rs:127`), filters
  `workspace_kind == Agent` (`domain/workspace.rs:64`), reads `runtime.get(task_id)` (`pty/runtime.rs:55`) →
  `last_activity_ms()`, `classify(...)`, and on a **change** vs an in-task-local `HashMap<task_id, DerivedState>`
  broadcasts a `TaskStatusEvent{ status: Running, derived_state: Some(_), last_activity_at: Some(_), .. }` via
  `broadcast_status` (:516). Needs a `TaskRuntime::running_task_ids()` accessor (the map is private,
  `runtime.rs:13`). Start it once from `initialize_database_state` (`lib.rs:226-232`), next to
  `spawn_status_bridge`.
- **AC — Given** an agent silent `> IDLE_THRESHOLD`, **when** the poller ticks, **then** exactly one
  `derivedState:"needs-attention"` event is emitted (not one per tick); **Given** silence crosses
  `WEDGED_THRESHOLD`, **then** one `"wedged"` event; **Given** the row leaves `Running` (exit-watcher fired),
  **then** the poller drops it and emits nothing further. **And** zero writes to the DB from the poll loop.
- **IPC delta:** §B place 1 (emit). **Effort:** M. **Owner:** TE.

#### E0-T4 · Recovery: orphaned-Running → interrupted (persisted) · TE · **M** · dep: E1-column
- **Files/fns:** migration `migrations/0012_workspace_interrupted_at.sql` (additive nullable col, mirrors
  `0011_soft_delete_workspaces.sql`); `domain/workspace.rs` add `interrupted_at: Option<DateTime<Utc>>` to
  `Workspace` (:90-109) + `WorkspaceUpdate` (`store/workspaces.rs:10`); wire the column into the SELECT/INSERT/
  UPDATE column lists in `store/workspaces.rs`; in `recover_startup_state` (`lib.rs:253-274`) set
  `interrupted_at: Some(Some(now))` alongside the existing `Running→Stopped` sweep. `stop_task`
  (`service.rs:300-317`) leaves it `None` (unchanged) so a user-stop stays calm.
- **AC — Given** a `Running` row at boot, **when** `recover_startup_state` runs, **then** it becomes `Stopped`
  **with** `interrupted_at` set; **Given** a user `stop_task`, **then** `interrupted_at` stays `null`.
  **Given** the migration on a v0.3.x DB, **then** existing rows are untouched and `interrupted_at` defaults NULL.
- **IPC delta:** §B place 3 (`Workspace.interruptedAt`). **Effort:** M. **Owner:** TE.
- **#PLAN_UNCERTAINTY** persisted column vs zero-migration fallback → §F-2.

### Story S0.1 — Derived-state model + honest single-agent UI · owner FE · overall M

#### S0.1-T1 · `deriveAgentState()` pure fn + liveness store · FE · **M** · dep: contract (§B)
- **Files/fns:** new `src/lib/deriveAgentState.ts` — `(row: Workspace, live?: {derivedState,lastActivityAt}, now: number) → { state: DerivedAgentState, since?: number }`. Precedence:
  `status==="completed"&&exitCode===0 → done`; `status==="failed" || (completed&&exitCode) → failed`;
  `status==="running"`: prefer `live.derivedState`, else if `now-startedAt < RESOLVING_GRACE → resolving`,
  else `working`; `status==="stopped" && interruptedAt → wedged`; `status==="stopped" → stopped`.
  New store `src/lib/agentLiveness.ts` (module store via `useSyncExternalStore`, mirrors `toast.ts:39-62`);
  `useTaskEvents.ts:28-33` writes `{derivedState,lastActivityAt}` into it on each event. New `src/lib/useNow.ts`
  (1 Hz `useSyncExternalStore` ticker, active only when the store has ≥1 live agent).
- **AC — Given** a running agent with `live.derivedState==="wedged"`, **then** `deriveAgentState` returns
  `wedged`; **Given** `status==="stopped"` with `interruptedAt`, **then** `wedged`; **Given** a just-spawned
  running row (<2 s) with no live event, **then** `resolving` (never Wedged/idle); **Given** an idle agent,
  **then** `since` counts up on each `useNow` tick with no new backend event.
- **IPC delta:** consumes §B. **Effort:** M. **Owner:** FE.

#### S0.1-T2 · `AgentStatusIndicator` + `AgentStatusBadge` (the three tiers) · FE · **M** · dep: S0.1-T1
- **Files/fns:** new `src/components/ui/AgentStatusIndicator.tsx` (18 px sidebar slot) and
  `src/components/AgentStatusBadge.tsx` (24 px header). Reuse `TerminalStatus`' icon/color idiom
  (`TerminalStatus.tsx:42-133`, `iconColor` text-token + lucide). Tier mapping (mockup `.badge` / `.pill`):
  - **Tier A bare** (`working`, `resolving`, `done`): colored lucide icon (`Loader2` spin / `CircleCheck`) +
    **neutral-AA label** `--color-text-primary`. Working sidebar = pulsing dot (`StatusDot` pulse idiom,
    `StatusDot.tsx:30-37`); `resolving` = `Loader2` spin, label "Starting…".
  - **Tier B soft 14 % chip** (`wedged`, `failed`): `bg = color-mix(in oklab, <state> 14%, --color-bg-surface)`,
    colored icon (`Hourglass` for wedged — **not** a broken-link; `CircleAlert` for failed, reused from
    `TerminalStatus.tsx:82`), neutral-AA label. **`wedged` has NO pulse** (a frozen agent must not look alive)
    + `@media (prefers-reduced-motion)` guard (mockup pattern).
  - **Tier C solid coral pill** (`needs-attention` **only**): `bg: --color-accent-500`, ink
    `--color-accent-onfill` (#010409) = 8.1:1 both themes. Copy = **"Needs attention"** at P0 (§F-1).
  - **StatusDot upgrade:** `AppSidebar.tsx:328` swaps `<StatusDot status={ws.status}/>` for
    `<AgentStatusIndicator …/>`; `StatusDot.tsx` stays for non-agent lifecycle dots (or is thinned to delegate).
- **AC — Given** any state, **then** it renders **icon + color + neutral-AA text label** (no color-only), on
  glass, AA in **both** themes; **and** meaning is carried by the label (`--color-text-primary` ≥18:1) or
  onfill ink (8.1:1) — **no** state relies on a bare colored glyph below 3:1 (kills the coral **2.47:1** and
  warning **2.92:1** light-sidebar failures). `#EXPORT_CRITICAL` a11y gate.
- **IPC delta:** none. **Effort:** M. **Owner:** FE.

#### S0.1-T3 · Sidebar meta + header badge placement (progressive disclosure) · FE · **S** · dep: S0.1-T2
- **Files/fns:** `AppSidebar.tsx` `WorkspaceRow` (:300-352) — **replace** the branch `<code>` meta (:343-346)
  with the honest-status line "Working · active 2s ago" (from `deriveAgentState`), and the indicator (:328)
  with `AgentStatusIndicator`. Workspace header `workspaces/$workspaceId.tsx` — mount `<AgentStatusBadge
  workspaceId={workspaceId}/>` in the left cluster next to `BranchChip` (:167-171). Branch stays in the header
  `BranchChip` (already there, :170) — spec's "branch relocates to header" is already satisfied; the sidebar
  simply stops duplicating it.
- **AC — Given** a lone single agent, **then** the chrome is **identical to today** except the sidebar meta now
  reads honest status instead of the branch, and the header shows the live badge — **no** board/epic chrome
  (progressive disclosure, spec S0.1 AC4). **Given** an idle agent, **then** the row/badge shows
  "last activity Ns ago" and **never** claims "Working".
- **IPC delta:** none. **Effort:** S. **Owner:** FE.

### Story S0.2 — Extend the event + Wedged notification · owner FE · overall S

#### S0.2-T1 · Wedged trigger on the DDR-003 path · FE · **S** · dep: E0-T3, S0.1-T1
- **Files/fns:** `useCompletionNotifications.ts` — in `onTaskStatus` (:290-320) add a branch for
  `payload.derivedState === "wedged"` (a transition; the poller already de-dups per episode). Reuse the
  existing `appFocusedRef`/`viewingThis` gates (:302-306), the OS-vs-in-app decision (`fireOs`, :170), and
  `activateWorkspace` (:132-153) for the action. Emit `showToast({ intent: "warning", … , action:{label:"Open
  workspace", onClick} })` — `toast.ts` `intent:"warning"` exists (`toast.ts:3`) and any toast with an action
  is **persistent** (`toast.ts:43-45`). Add a `WEDGED_NOTIFY_COOLDOWN` per-task guard (anti-flap).
- **AC — Given** an agent transitions to Wedged **and** the user is **not** viewing it, **then** one calm,
  persistent, action-first in-app toast fires (OS notification **only** when unfocused, reusing the DDR-003
  gate); **Given** the user is viewing that workspace, **then** suppressed; **Given** re-wedge flapping within
  the cooldown, **then** no duplicate. Live region is **polite** — the toast/OS path uses `role="status"` /
  `aria-live="polite"` (Wedged is a warning, not the assertive `role="alert"` DDR-003 reserves for Failed;
  fixes the mockup's `role="alert"` nit).
- **IPC delta:** consumes §B `derivedState`. **Effort:** S. **Owner:** FE.

#### S0.2-T2 · Recovery affordance (Restart / Open) for Wedged & Failed · FE · **S** · dep: S0.1-T2
- **Files/fns:** new `src/lib/hooks/useRestartAgent.ts` — `(workspaceId) => stop_task (best-effort) then
  open_task_terminal` (both already exist: `tauri.ts` wrappers → `commands/orchestrator.rs:74,84`;
  `open_terminal` already **resumes** a non-terminal row in its worktree, `service.rs:324-406`, incl. the
  self-heal at :458-465). Surface it: (a) `AgentStatusBadge` renders a compact **Restart** button when
  `wedged`/`failed` (do **not** overlay a live-frozen terminal); (b) the S0.2 toast action routes via
  `activateWorkspace`; (c) Failed already has `TerminalStatus`' Retry/Restart (`TerminalStatus.tsx:88-99`) —
  reuse, don't duplicate.
- **AC — Given** a Wedged agent, **then** a **Restart** affordance is one click away from the header **and**
  the notification; **Given** a relaunch-interrupted agent (`stopped`+`interruptedAt`), **then** Restart
  resumes it in the same worktree/branch; **no** Wedged/Failed surface is a dead end (DDR-002).
- **IPC delta:** none (reuses existing commands). **Effort:** S. **Owner:** FE.

### Enabler E-P1 — CPU-activity liveness sensor (P1, additive — after P0 ships) · owner TE · overall M

> **Explicitly P1.** P0 (E0/S0.1/S0.2) ships and is validated **first**. This is a *second liveness sensor*
> bolted onto the same poller — it does not change P0's data flow or the P0 exit gate. Cross-links the main
> spec's P1 detection note: [`multi-agent-task-board-spec.md`](./multi-agent-task-board-spec.md) §2 S0.1,
> Needs-you row ("P0: honest 'needs attention…'; **P1 refines via prompt-pattern heuristic**").

**The problem it solves.** P0 classifies purely on **output recency**, which is ambiguous for a silent agent:
a long `cargo build`, a local-inference model "thinking" with no stdout, or a large file op all look identical
to a genuinely idle/wedged agent. That ambiguity is exactly what makes decision **§F-1** (coral at 60 s idle)
risk crying wolf. A second sensor — **process CPU activity** — disambiguates *busy-but-quiet* from
*idle/stuck*.

#### E-P1-T1 · Capture the agent PID · TE · **S** · dep: E0-T1
- **Files/fns:** `pty/handle.rs` — at the child-obtain site (**:157-166**), before the child moves into the
  wait thread (**:252-259**), capture `let pid = child.lock().process_id();` (portable-pty exposes
  `Child::process_id(&self) -> Option<u32>`, `portable-pty-0.9.0/src/lib.rs:141`) and store `pid: Option<u32>`
  on `PtyHandle` (:79-93); expose `pub fn pid(&self) -> Option<u32>`.
- **AC — Given** a spawned PTY, **then** `handle.pid()` returns the login-shell PID; **Given** spawn fell back
  through the shell candidates, **then** `pid()` reflects the shell that actually launched.
- **IPC delta:** none. **Effort:** S. **Owner:** TE.

#### E-P1-T2 · CPU sampler (macOS `libproc`), subtree-summed · TE · **M** · dep: E-P1-T1
- **Mechanism (macOS, grounded).** The tracked PID is the **login shell**; the agent (`claude`, `node`, …) runs
  as a **descendant** typed into that shell (`handle.rs:199-221`), so sampling the shell PID alone **undercounts**.
  Sum cumulative CPU over the agent's process subtree:
  1. `proc_listchildpids(pid, …)` (or the PTY foreground process group: `tcgetpgrp(master_fd)` +
     `proc_listpgrppids(pgid, …)`) to enumerate the descendant/foreground PIDs.
  2. `proc_pidinfo(child_pid, PROC_PIDTASKINFO, 0, &mut ti, size)` per PID → `ti.pti_total_user +
     ti.pti_total_system` (cumulative CPU **nanoseconds**); sum them → `cpu_ns_total`.
  - Wrap it as `fn sample_cpu_ns(pid: u32) -> Option<u64>` in a new `orchestrator/cpu_macos.rs`, using the
    `libproc` crate (safe wrapper) under `[target.'cfg(target_os = "macos")'.dependencies]`. **Non-macOS /
    PID-missing → `None`** (a `cfg`-gated no-op stub), so the classifier degrades cleanly to P0 output-only.
- **AC — Given** a busy child (spinning process), **then** two samples one interval apart differ by a positive
  delta; **Given** an idle child parked at a prompt, **then** the delta is ≈0; **Given** a non-macOS build or
  an absent PID, **then** `sample_cpu_ns` returns `None` and callers behave exactly as P0.
- **IPC delta:** none. **Effort:** M. **Owner:** TE.
- **Risk/portability:** macOS-only APIs (acceptable — darwin-only Tauri app); own-user children need no elevated
  perms; per-tick cost is a `proc_pidinfo` call over a handful of PIDs every 5 s (negligible). Subtree walk is
  the correctness-critical part — the shell-wrapper caveat above.

#### E-P1-T3 · Fold CPU delta into the classifier + poller · TE · **M** · dep: E-P1-T2, E0-T3, E0-T2
- **Files/fns:** extend `classify()` (`orchestrator/liveness.rs`, E0-T2) to take a `cpu_busy: bool`; extend the
  E0-T3 poller loop (**no new loop** — same `tokio::interval`, `service.rs`) to keep a per-task
  `last_cpu_ns` alongside `last_derived`, compute `cpu_delta = sample_cpu_ns(pid) - last_cpu_ns`, and set
  `cpu_busy = cpu_delta / interval > CPU_BUSY_THRESHOLD` (see §C).
- **Refined classification rule** (output recency wins first; CPU only disambiguates the *silent* branch):
  | Signal | P0 result | **P1 refined result** |
  |---|---|---|
  | output within `IDLE_THRESHOLD` | Working | Working (unchanged — CPU not consulted) |
  | **no output** past threshold **AND** `cpu_busy` | Idle→(Wedged) | **Working (busy)** — do **NOT** flag idle/Wedged |
  | **no output** past threshold **AND** `cpu_delta ≈ 0` | Idle→NeedsAttention→Wedged | **unchanged** honest Idle→Wedged path |
- **AC — Given** a silent agent burning CPU (long compile / local model thinking, no stdout), **when** the
  poller ticks **past** `WEDGED_THRESHOLD`, **then** it **MUST NOT** transition to Wedged — it stays
  **Working (busy)**; **Given** a silent agent with `cpu_delta ≈ 0` past `IDLE_THRESHOLD`, **then**
  NeedsAttention, and past `WEDGED_THRESHOLD` → Wedged (P0 path intact); **Given** output resumes, **then**
  Working via output recency (CPU sensor not consulted); **Given** the sampler returns `None`, **then**
  identical to P0 (no regression).
- **IPC delta (one small, additive, P1-only touch):** to keep copy honest ("Working · busy, no output for Nm"
  instead of a contradictory "active 3m ago"), add a `busy: bool` field (or a `working-busy` value) to
  `TaskStatusEvent`/`TaskStatusPayload`/`types.ts` — the **same 3-place sync** as §B, additive, defaulting
  `false`/absent so P0 consumers are unaffected. (Optional: if we skip it, busy simply emits as `working`.)
- **Effort:** M. **Owner:** TE.

**Complementary signal for a *later* sub-step (not this enabler).** CPU separates **busy vs. idle**, NOT
**waiting-for-you vs. hung** — a silent, zero-CPU agent could be blocked on stdin at a known prompt (act on it)
**or** deadlocked (restart it). Distinguishing them needs either a **stdin-block / thread run-state** check
(e.g. `PROC_PIDTASKALLINFO` / thread state, or a blocked-on-read `T`/`U` state) **or** **terminal
prompt-pattern matching** on the replay buffer (`pty/handle.rs:376-414`). That is the robust cross-agent path
to eventually lighting the scarce coral **"Waiting for you"** with confidence — a P1.x follow-on, tracked but
out of scope here.

---

## E. Build order / critical path

```
        ┌─ E0-T1 (stamp) ─┐
  §B ───┤                 ├─ E0-T3 (poller) ──┐
 lock   ├─ E0-T2 (classify)┘                  ├─ integration ─ S0.2-T1 (notify)
 first  ├─ E0-T4 (recovery+col) ──────────────┘                  S0.2-T2 (restart)
        │
        └─ S0.1-T1 (derive+store) ─ S0.1-T2 (components) ─ S0.1-T3 (placement)
                 (builds against §B contract + /design-test — no wait on E0)
```

1. **Gate 0 (do first, ~30 min, joint):** freeze the §B contract (`TaskStatusPayload` + `Workspace.interruptedAt`
   + `DerivedState`). This is the real critical path — both sides build against it.
2. **Parallel track TE:** E0-T1 → E0-T2 → E0-T3; E0-T4 independent (needs only the column).
3. **Parallel track FE:** S0.1-T1 → S0.1-T2 → S0.1-T3, entirely against the frozen contract + the `/design-test`
   harness (mocked states) — **no dependency on E0 landing**.
4. **Converge:** wire real events (E0-T3) to the real store (S0.1-T1); then S0.2-T1, S0.2-T2.
5. **Release gate:** the Step-0 exit gate (spec §2) — "no card asserts Working past threshold" — must pass.

**Fully parallel:** all of E0 (TE) and all of S0.1 (FE). **Serial joins:** Gate 0 (before either), then
S0.2 (after both tracks meet).

**P1 (after the P0 exit gate passes):** E-P1-T1 → E-P1-T2 → E-P1-T3, TE-only, bolted onto the E0-T3 poller.
No P0 rework; the one additive `busy` contract touch reuses the §B 3-place sync. E-P1 directly de-risks §F-1.

---

## F. Open decisions (each with a recommended default — not blocking)

1. **`IDLE_THRESHOLD` + coral copy.** At P0 there is no prompt-pattern heuristic, so idle>60 s → coral
   "Needs-you" risks crying wolf on long compiles. **Default:** keep coral for idle-beyond-idle **but** set
   `IDLE_THRESHOLD = 60 s` with softer copy **"Needs attention"** (spec S0.1 already prescribes this P0 copy);
   promote to "Needs you" once the P1 prompt-heuristic can confirm a real prompt. (Alt: raise to 90 s.)
2. **`interrupted_at` persisted column vs zero-migration.** **Default: ship the column** (E0-T4) — additive,
   matches the `0011` precedent, gives the amber Wedged the design wants. **Fallback if we want no migration in
   Step 0:** recover orphaned `Running → Failed` with `exit_code = None`; the frontend already distinguishes
   `failed + exitCode null` (interrupted/signal) from `failed + exitCode > 0` (crash) — but it renders **red
   Failed**, not amber Wedged. Recommend the column.
3. **`WEDGED_THRESHOLD`.** Spec says "≫ idle". **Default: 180 s** total silence.
4. **Poll cadence.** **Default: 5 s** (transition latency ≤5 s at a 60/180 s scale; negligible cost over ≤N
   rows). No per-second bus traffic — the 1 Hz "Ns ago" is frontend-local.
5. **Relaunch-storm notifications.** Should N interrupted agents each toast at boot? **Default: no** — they're
   already visible as Wedged on the worklist; a startup toast storm is noise. Live-transition Wedged (S0.2-T1)
   still notifies.
6. **StatusDot fate.** **Default:** add `AgentStatusIndicator`, leave `StatusDot` for non-agent lifecycle dots;
   optionally thin `StatusDot` to delegate later. Avoids churn on other callers.
7. **`CPU_BUSY_THRESHOLD` (P1).** **Default: 5 % of one core** averaged over the poll interval — high enough to
   ignore idle-shell jitter, low enough to catch a single-threaded compile/thinking process. Tune against real
   `cargo build` / model-inference traces once E-P1 lands. Also decide whether "busy" gets its own honest copy
   ("Working · busy, no output Nm") via the additive `busy` field, or silently reuses `working` (**Default:
   ship the `busy` field** — the whole point is honesty).

---

## G. Verification plan

**`cargo test` (TE):**
- `pty::handle` — `last_activity_advances_on_output`: spawn `echo hi; exit` (pattern from `runtime.rs:78-114`),
  assert `last_activity_ms()` increases after the Output event. (E0-T1)
- `orchestrator::liveness` — `classify_thresholds`: pure-fn table test for Working/NeedsAttention/Wedged +
  the no-handle→Wedged case. (E0-T2)
- `orchestrator::service` — `poller_emits_wedged_transition_once`: with test thresholds (1 s/2 s), spawn an idle
  shell, subscribe to `subscribe_status` (:128), tick the poller, assert exactly one `needs-attention` then one
  `wedged` derived event, and none after exit. (E0-T3)
- `recover_startup_state` — `orphaned_running_becomes_stopped_with_interrupted`: insert a `Running` row, run
  recovery, assert `Stopped` + `interrupted_at IS NOT NULL`; and `user_stop_leaves_interrupted_null`. (E0-T4)
- `store::workspaces` — extend the existing `round_trip`/insert-get tests to cover the new column.
- **(P1) `orchestrator::liveness` — `busy_cpu_suppresses_wedged`:** with test thresholds (1 s/2 s), spawn a
  CPU-spinning child that emits **no** output; tick the poller past `WEDGED_THRESHOLD`; assert the derived
  state is **Working (busy)**, **never** Wedged. Companion `idle_zero_cpu_still_wedges` (a `sleep`-parked
  child) asserts the honest Idle→Wedged path is intact, and `cpu_sampler_none_degrades_to_p0` (stub returns
  `None`) asserts no regression. `sample_cpu_ns` gets a direct unit test on a known-busy vs. known-idle PID.

**`pnpm typecheck` (FE):** enforces the §B 3-place sync (`types.ts` ↔ payload). Add a unit test for
`deriveAgentState` (all precedence branches incl. `resolving` grace + `stopped+interrupted → wedged`).

**Contrast gate (`#EXPORT_CRITICAL`):** run
`node .claude/skills/design-system/scripts/check-contrast.mjs <fg> <bg>` for each state on **both** sidebars
(dark `#0b0f14`, light `#f4f5f7`) and the coral pill (`#010409` on `#f78166`). Assert: every state's **label**
(`--color-text-primary`) ≥ 4.5, the coral **onfill ink** ≥ 4.5 (expect 8.1), and that **no** rendered signal
depends on a bare glyph < 3:1. Gate = the script's non-zero exit.

**Playwright via `/design-test` (headless, no IPC — `design-test.tsx:20`, `playwright.config.ts`):**
- Add an `AgentStatus` section to `design-test.tsx` rendering all seven derived states (both themes, via the
  existing `theme-toggle`, `design-test.tsx:34`) with `data-testid`s, driven by mocked `{derivedState,
  lastActivityAt}` — no Tauri (`design.spec.ts:24-31` stubs `__TAURI_INTERNALS__`).
- New `e2e/agent-status.spec.ts` (pattern from `design.spec.ts`): assert (a) `needs-attention` pill text color
  is `rgb(1, 4, 9)` (accent-onfill) in **both** themes — the exact idiom of `design.spec.ts:56-64`; (b)
  `wedged`/`failed` labels compute to `--color-text-primary` over a soft-tint chip; (c) `wedged` has
  `animation-name: none` (no pulse) and respects `prefers-reduced-motion`; (d) an idle card renders
  "last activity Ns ago" and never the string "Working"; (e) no console errors (`design.spec.ts:39-41`).

---

**Cross-link:** the parent spec §2 "Step 0 exit gate" now points here for the implementation breakdown.
