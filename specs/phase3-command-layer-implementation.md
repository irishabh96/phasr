# Phase 3 — The command layer + QAS gates: Implementation Breakdown

> **Plan:** `~/.claude/plans/velvety-sniffing-thompson.md` → *Phase 3 — The command layer + QAS
> gates* + the *UX / Design → "Command layer (unify, don't build a framework)"* paragraph + the loop
> (`Start → Validate → Review/QAS → Integrate → Ship`).
> **Mockup:** `phasr-factory-pages.html` — Page 03 (Epic board, the `NextGate` treatment: one derived
> primary "next gate" button, disabled-with-reason, never hidden) + Page 04 (ticket header: single
> primary "Request review").
> **Continuity:** builds directly on `specs/phase2-rich-tickets-implementation.md` (tickets file-service,
> comments, worklist), `specs/phase1-planner-implementation.md` (planner, `ProposedPlan`), and
> `specs/task-board-p0-implementation.md` (board, integrate, publish-contract, honest status).
> **Vocabulary:** user-facing **Epic → Ticket** (plan open decision #8); internally still
> `workspaceKind: "parent" | "subtask"`. This spec says "ticket" for a subtask and "epic" for a parent.

**Scope of Phase 3:** unify every existing command surface behind ONE derived *next gate* per
ticket/epic, add the two missing gates (**Validate**, **Review/QAS**), and open the no-MCP door for
agents to advance the board themselves (the **`phasr` CLI**). We do **not** rebuild any surface that
already works — we generalize `BoardParentHeader` + `BoardCard`, extend the ⌘K palette and the ⋯ menu,
and reuse `integrate_parent` / `publish_contract` / `git_merge_to_main` / the run-commands config / the
`ChangesPanel` conflict flow verbatim.

---

## 0. Validation Log (claims checked against code, before planning)

| # | Claim (from the brief) | Verdict | Evidence (`file:line`) |
|---|-------|---------|----------------------|
| 1 | `BoardParentHeader` hosts Integrate + an "integrate when ready" disabled-with-reason | **CONFIRMED** | `src/components/board/BoardView.tsx:169-317` — `BoardParentHeader` renders either a `<GlassButton variant="primary" data-testid="board-integrate">` "Integrate & review" (`:276-292`) **or**, when `!integrable`, a muted, non-hidden `<span data-testid="board-integrate-pending" title="Integration unlocks once every subtask is ready for review.">Integrate when ready</span>` (`:294-305`). `integrable = cards.length>0 && cards.every(isReviewReady)` (`:126`). **This IS the disabled-with-reason pattern to generalize.** |
| 2 | `BoardCard` "Mark done" → `publish_contract` | **CONFIRMED** | `BoardView.tsx:80-120` computes `canPublish = isProducer && !hasPublished`, wiring `onMarkDone: () => publish.mutate(subtask.id)`; `BoardCard.tsx:120-145` renders the `data-testid="board-mark-done"` ghost button ("Mark done" / "Publishing…"). `usePublishContract` → `publish_contract` (`src/lib/hooks/useBoard.ts:36`). |
| 3 | `ChangesPanel` = commit/push (the human's local git surface) + the conflict surface | **CONFIRMED** | `src/components/ChangesPanel.tsx:8-19` imports `useGitCommit`/`useGitPush`/`useGitStage`/…/`useGitContinueMerge`/`useGitAbortMerge`/`useGitResolveConflict`/`useGitMergeInProgress`. `BoardParentHeader` routes an integration conflict into `<ChangesPanel workspaceId={board.parent.id} />` (`BoardView.tsx:305-312`). |
| 4 | `WorkspaceActionsMenu` = merge/PR/archive/delete dropdown | **CONFIRMED** | `src/components/WorkspaceActionsMenu.tsx` — a ⋯▾ `GlassButton` opening a dropdown of `Merge to <main>` (→ `MergeToMainDialog`), `Open pull request` (→ `useOpenPullRequest`), `Archive`, `Delete workspace` (→ `ConfirmDialog`, `destructive`). This is the **context-menu pattern to reuse**, and where **Ship (merge-to-main) lives today** (buried in the ⋯ menu — R7 wants it promoted). |
| 5 | `CommandPalette` (⌘K) is navigation-only today | **CONFIRMED** | `src/components/CommandPalette.tsx` — groups are `Workspaces`, `Repositories`, `Actions` (only "New workspace"), `Settings`, `Theme`, `Session` (sign out). Every item **navigates or toggles UI**; NONE mutates the board. Built on `cmdk` (`Command.Dialog`, `shouldFilter`). A new **Commands** group slots in here. |
| 6 | Backend `integrate_parent` / `publish_contract` exist | **CONFIRMED** | `src-tauri/src/commands/board.rs:248` `publish_contract(subtaskId) -> BoardState` (writes the contract file if missing, stamps `published_at`); `board.rs:286` `integrate_parent(parentId) -> BoardState` (mints integration worktree, topological merge, `IntegrationConflict{files}` on first conflict). Both registered in `lib.rs` invoke_handler; wrapped `tauri.ts:267,278`. |
| 7 | Start = the scheduler's auto-spawn | **CONFIRMED** | `orchestrator/service.rs:889` `spawn_ready_subtask` REUSES `start_task`'s spawn internals; the scheduler poller (`lib.rs:280` `spawn_scheduler`) fans out each ready subtask within one interval of `start_decomposition`. **Start is automatic**, not a button today — the ladder surfaces it only as a *manual override* (spawn-now / restart-wedged). |
| 8 | `git_merge_to_main` = Ship | **CONFIRMED** | `src-tauri/src/commands/git.rs:326` `git_merge_to_main(workspaceId, strategy) -> MergeOutcome` merges the workspace's branch into `repository.default_branch` in the shared main repo under the per-repo lock. Reached today via `MergeToMainDialog` from the ⋯ menu. After `integrate_parent` the **parent row carries the integration branch/worktree** (`board.rs:286` doc), so `git_merge_to_main(parentId)` is the epic-level Ship. |
| 9 | A run-commands config exists to reuse for Validate | **CONFIRMED — but it runs in the MAIN checkout via an interactive PTY, not the ticket worktree, and does not capture pass/fail** | `RunCommand { name, command, shortcut, pinned }` (`domain/run_command.rs:9-19`), CRUD in `commands/run_commands.rs:86-171`. `start_run_command` (`:178-217`) spawns the command in an **interactive PTY** with `cwd = repository.local_path` (the MAIN checkout, `:203-206`) and never reads an exit code. **Validate must reuse the config (the command strings) but add a NEW captured, non-interactive, per-worktree execution path** (see A4 / Story V1). |
| 10 | "CLI-writes-board needs a local server or a DB watch" (agents can't just write the DB) | **CONFIRMED** | The running app **owns** the SQLite pool (`lib.rs:288` `handle.manage(pool)`), the `TaskRuntime` PTY map, the liveness stamps, the scheduler's in-flight guards, and the `AppHandle` that emits `phasr://…` events. `Cargo.toml` has **no** server/socket dep (no `axum`/`hyper`/`interprocess`/`tokio-tungstenite`) and **no `[[bin]]` beyond the app** (`Cargo.toml:1-9`). Existing precedent for "external write reflected onto the live board": the scheduler already bridges contract **files** → DB + events (`service.rs` `spawn_scheduler`), and the ticket fs-watcher emits `phasr://ticket-changed` (`fswatch.rs:22-23,199`). `PtySpawnOptions` has **no env field** (`pty/handle.rs:60-77`) → injecting per-ticket CLI creds is new plumbing. **→ Section J1.** |
| 11 | Lanes/review state stay DERIVED, never a stored `WorkspaceStatus` | **CONFIRMED (plan invariant #10)** | `src/lib/deriveBoardState.ts` derives `blocked`/`needs-review` purely from `edges × contracts × liveness`; `boardColumn()` maps state→lane; the backend never stores or emits them. Phase 3 keeps this: `in-review` / `qas-changes-requested` are **new derived buckets**, and the review *decision* is a file, not a status (A5). |
| 12 | `ConfirmDialog` + `humanizeError` exist for destructive/outward confirms + error copy | **CONFIRMED** | `src/components/ui/Dialog.tsx:166` `ConfirmDialog({destructive, confirmLabel, onConfirm})`; `src/lib/humanizeError.ts` (used already in `BoardView.tsx:247,258`). |
| 13 | Comments already carry an agent author + role (the hook for `phasr comment` + QAS decisions) | **CONFIRMED** | `TicketComment { author, authorKind:"you"\|"agent", role: string\|null, body, createdAtMs }` (`types.ts:492-502`); `add_ticket_comment(repositoryId, ticketId, body) -> TicketComment` (`commands/tickets.rs:258-270`) appends to `comments.jsonl`. The `authorKind:"agent"` + `role` fields are unused in Phase 2 (human-only) and become the CLI/QAS write path in Phase 3. |

**Net:** every load-bearing claim holds. Two are sharpened: **(9)** the run-commands config is reusable
but its executor is the wrong shape for Validate (interactive PTY in the main checkout, no exit code) — Validate
needs a new captured per-worktree runner; **(7)** Start is already automatic, so the "Start" gate is a
manual *override*, not a new primary path. The one genuinely new architecture surface is **(10)** the
`phasr` CLI → board mechanism — spec'd in A6 + Story CLI1 and flagged in full for system-architect (J1–J5).

---

## A. Architecture decisions (`#PATH_DECISION`)

### A1 — One derived *next gate* per entity; a single pure `deriveNextGate` is the source of truth.

At any moment a ticket (subtask) or an epic (parent) has exactly ONE next gate. A new pure function
`deriveNextGate(entity, board, liveness, review, validate) -> NextGate` returns
`{ verb, label, enabled, reason, intent, confirm }` — the SAME shape the `NextGateButton` renders and the
⌘K Commands group + the ⋯ menu read. It lives beside `deriveBoardState.ts` (`src/lib/deriveNextGate.ts`),
is unit-tested across every branch, and is the ONLY place the ladder logic exists. The button, palette,
and menu are all thin readers — no surface re-derives.

**The ladder (left → right; the FIRST unmet gate wins):**

| Ladder step | Entity | Enabled when | Disabled-with-reason when | Underlying command |
|---|---|---|---|---|
| **Start** (override) | ticket | `wedged`/`failed`/`interrupted`/`stopped` (recover) | live/`working` ("agent is running") | `restart_task` (existing recovery) / scheduler auto-spawn otherwise |
| **Validate** | ticket | worktree exists + ≥1 check configured | no checks configured ("Add a check to validate"), or blocked/not-started | `validate_ticket` (**new**, V1) |
| **Request review** | ticket | validated-pass (or override) + not already in review | validation failing ("Fix N failing checks"), still working ("agent still working"), or already requested | `request_review` (**new**, R1) — reuses `publish_contract` for producers |
| **Approve / Bounce-back** | ticket (reviewer) | `in-review` (review requested) | not yet requested | `resolve_review` (**new**, R1) |
| **Integrate** | epic | every ticket integrate-eligible (approved, or `needs-review` when QAS gate off) | "unlocks once every ticket is ready for review" (EXISTING copy) | `integrate_parent` (existing) |
| **Ship** | epic | epic integrated (parent carries a clean integration branch, ahead of base) | "integrate first" / "nothing to ship" | `git_merge_to_main(parentId)` (existing) |

The button is **never hidden** — an unmet gate renders calm/disabled with its `reason` as `title` +
`aria-describedby` (generalizing the existing `board-integrate-pending` span, `BoardView.tsx:294-305`).

### A2 — Generalize, don't fork: `NextGateButton` subsumes both existing primaries.

`BoardParentHeader`'s Integrate primary (`BoardView.tsx:276-305`) and `BoardCard`'s Mark-done ghost
(`BoardCard.tsx:120-145`) become two call-sites of ONE `<NextGateButton entity={…} board={…} />`.
`BoardParentHeader` passes the epic; the ticket-detail header (route `$workspaceId.tsx:252-290`) and each
board card pass the ticket. "Mark done" is re-labelled **Request review** in the ladder but keeps its
`publish_contract` action for producer subtasks (A5). The button owns its own confirm + error handling so
no call-site repeats it.

### A3 — Command placement: primary = button, mirror = ⌘K, everything = ⋯ menu.

- **`NextGateButton`** (primary, coral, ONE per header/card): the derived next gate only. Coral stays
  scarce (plan: "the single primary gate action + selection tint only") — the gate is the one place a
  ticket/epic earns coral.
- **⌘K Commands group** (the human mirror of the CLI): a new `Commands` group in `CommandPalette.tsx`
  listing every verb applicable to the *focused* entity, **using the exact CLI verb names**
  (`validate`, `request-review`, `approve`, `bounce-back`, `integrate`, `ship`, `comment`, `new-ticket`).
  Same verbs the agent shells out to → the palette teaches the vocabulary. Navigation groups stay.
- **⋯ context menu** (reuse `WorkspaceActionsMenu`'s dropdown): the non-primary + destructive verbs
  (Validate while also being able to Request-review, Bounce-back, plus the existing Merge/PR/Archive/Delete).
  **Ship is promoted OUT of the ⋯ menu** into a `NextGateButton` primary once the epic is integrated (R7).

### A4 — Validate is a captured, per-worktree, non-interactive check runner over the run-commands config.

Validate must NOT reuse `start_run_command`'s interactive-PTY-in-main-checkout path (`run_commands.rs:200-217`)
— it needs the **ticket's branch state** and a **pass/fail exit code**. New `commands/validate.rs` +
`orchestrator/validate.rs` run each opted-in `RunCommand` as a captured subprocess (`sh -c "<command>"`)
with `cwd = subtask.worktree_path`, sequentially, each under a `tokio::time::timeout`, aggregating
`ValidateResult { checks: [{name, command, passed, exitCode, tailOutput}], passed, ranAtMs }`. Mirrors the
planner's captured-subprocess shape (`orchestrator/planner.rs`) incl. the **env-overridable binary/shell for
tests**. `#PATH_DECISION`: **which** run-commands are checks is an opt-in flag on `RunCommand`
(`run_in_validate: bool`, default false) — running *all* pinned commands is wrong (a dev server never
exits). No checks configured → Validate is a legible no-op with an "Add a check" affordance (never a dead
end). **The result is written to the ticket folder as `validate.json`** (docs-as-files: agent-readable,
survives restart, ships in the PR) AND returned to the caller. **→ open decision J2.**

### A5 — Review is a file, not a status: `review.json` in the ticket folder keeps `WorkspaceStatus` frozen.

The Review lane + QAS gate must NOT introduce a stored `WorkspaceStatus` (plan invariant #10). The review
*decision* is a versioned file `<repo>/.phasr/tickets/<id>/review.json`:

```jsonc
{ "state": "requested" | "approved" | "changes-requested",
  "by": "you" | "qas-agent" | "<name>",
  "comment": "…",            // required for changes-requested
  "atMs": 1737000000000,
  "validatePassed": true }   // snapshot of the last validate at request time
```

Written by the tickets file-service (the single writer, A1 of Phase 2), so it's on-thesis (agent-readable,
versioned, in the PR) and reachable by the `phasr` CLI via the same file-service. The lane derivation
(`deriveBoardState`) layers `review.json` on top of the honest state:

- `state:"requested"` → **`in-review`** (Review lane) — supersedes `needs-review`.
- `state:"changes-requested"` → **`qas-changes-requested`** (re-opens: back to In-progress with a
  "changes requested" chip; the agent, if alive, reads the bounce comment at its next step; if exited, the
  human restarts it). Neutral tone, never coral (a bounce is not the user's fault — mirror `BlockedChip`).
- `state:"approved"` → stays in Review, marked **integrate-eligible** (a soft `success` check).

`Request review` writes `requested`; `Approve`/`Bounce-back` write `approved`/`changes-requested`.
**Bounce-back also appends a comment** via the existing `add_ticket_comment` (`tickets.rs:258`) so the
reason is in the thread (SAFe iteration authority). For a **producer** subtask, `Request review` ALSO calls
`publish_contract` (so dependents still unblock) — the two are composed server-side in `request_review`.

### A6 — The `phasr` CLI writes the board through a **local IPC socket the app exposes** (recommended), NOT a direct DB write.

`#PATH_DECISION` (flagged for system-architect, J1). A spawned agent advances the board by shelling out to
`phasr <verb> …`. The CLI is a **thin client**: it does NOT open the SQLite DB. Instead the app runs a tiny
**local IPC listener** (new `src-tauri/src/ipc_server.rs`) on a **Unix domain socket** at
`~/.phasr/phasr.sock` (0600, owner-only, local-only — no network). The CLI connects, sends one
line-delimited JSON request `{ verb, ticket, token, args }`, the app **authenticates the token↔ticket**,
dispatches through the **SAME `_inner` handler** the Tauri command uses (`publish_contract_inner`,
`add_comment`, the review/validate writers, `create_decomposition_inner`), **emits the same `phasr://…`
events**, and returns a JSON result. The app is the single writer.

**Why (b) socket, not (a) direct-DB-write:** (1) *single-writer integrity* — two processes writing the same
WAL races the app's pool; (2) *live board* — a mutation must emit `phasr://task-status`/`ticket-changed`, and
only the app process holds the `AppHandle` (`fswatch.rs:199`, `orchestrator.rs:180`); (3) *in-memory
coherence* — the scheduler's in-flight guards, the liveness map, and `TaskRuntime` live in the app's memory
and would desync from a DB-only write; (4) *DRY* — `phasr comment` and the UI "Add comment" both funnel
through `add_comment`, so behavior/validation/events are identical by construction. The file+watch path (a')
already works for *pure file* verbs (a `comment` could append to `comments.jsonl` and the ticket watcher
would pick it up, `fswatch.rs`) and is the **fallback**, but status/review/sub-ticket verbs touch DB rows +
need events, so the socket is canonical. **Whole surface marked for architect (J1).**

**Discovery + auth (mirror the brief pointer, but via env):** extend the agent spawn to inject
`PHASR_SOCK`, `PHASR_TICKET`, `PHASR_TOKEN`, and `PHASR_BIN` into the ticket agent's environment (a
per-subtask random `token` minted at spawn, held in an in-memory `CliTokenRegistry` keyed `token→(subtaskId,
userId)`). This requires adding an **`env` field to `PtySpawnOptions` → `TaskRuntime::spawn` →
`CommandBuilder::env`** (`pty/handle.rs:143-149` already loops `cmd.env(k,v)` for terminal env — extend it).
The seed prompt gains a **"commands you can run"** segment (like `brief_prompt_pointer`,
`scheduler.rs:189`) telling the agent: *"to advance your ticket, run `phasr request-review`, `phasr comment
"…"`, `phasr new-ticket …` — they update the board live."* The token scopes an agent to **its own ticket
only** (`#EXPORT_CRITICAL`: reject any request whose token doesn't map to the named ticket, or whose subtask
is not active). **→ open decisions J3 (env plumbing), J4 (binary-on-PATH), J5 (token lifecycle).**

---

## B. The gate ladder — derivation detail

`deriveNextGate` composes the honest board state (`deriveBoardState`, unchanged) with two new inputs
(`review.json`, `validate.json`), both optional and both derived-only. Precedence per entity:

**Ticket (subtask):**
1. live/`working`/`idle` → next gate = **Validate** (enabled if checks configured) — you can validate a
   running agent's branch at any point; the primary invites it.
2. `wedged`/`failed`/`interrupted` → **Start (Restart)** (recovery; mockup Page 03 shows the inline
   Restart on the wedged `web-ui` card).
3. `blocked` → **no gate** (disabled: "waiting for <role>") — reuse `blockingRoles` (`deriveBoardState.ts`).
4. validate-passed (or overridden) & not in review → **Request review**.
5. `review.state:"requested"` → **Approve / Bounce-back** (the reviewer's gate; for the ticket owner it
   shows as "In review — awaiting QAS").
6. `review.state:"approved"` → **no ticket gate** (contributes to the epic's Integrate).

**Epic (parent):**
1. not every ticket integrate-eligible → **Integrate** *disabled* ("unlocks once every ticket is ready for
   review" — EXISTING copy, `BoardView.tsx:301`).
2. every ticket integrate-eligible → **Integrate & review** (existing `integrate_parent`; confirm via
   `ConfirmDialog` since it's an outward mutation).
3. epic integrated (parent has an integration branch, clean, ahead of base — read via existing
   `git_branch_status(parentId)`) → **Ship** (`git_merge_to_main(parentId)`; confirm via `ConfirmDialog`).
4. shipped (branch merged, `aheadOfTarget===0`) → **no gate** (terminal; the epic is done). *(How "shipped"
   persists is J6 — recommended: derive from `git_branch_status`, no new column.)*

`integrate-eligible(ticket)` = `review.state==="approved"` **OR** (`needs-review` **AND**
`review.state !== "changes-requested"` **AND** the QAS gate is not required). Whether QAS approval is
*mandatory* for Integrate is **open decision J7** (recommended default: approval is required only for tickets
where a review was *requested*; a ticket that reached `needs-review` without a review request stays
integrate-eligible → backward-compatible with today's board).

---

## C. Frozen IPC contract (3-place: Rust command · `tauri.ts` wrapper · `types.ts` DTO)

> Every command registered in `src-tauri/src/lib.rs` `invoke_handler`, wrapped in `src/lib/tauri.ts`, DTOs
> mirrored in `src/lib/types.ts`. `camelCase` on the wire (serde `rename_all`). **Frozen for the milestone.**

### C.1 — Validate (owner: **tauri-engineer**) — `commands/validate.rs`

```rust
// Run every opted-in RunCommand as a captured subprocess in the ticket's worktree; aggregate pass/fail.
// Writes validate.json into the ticket folder AND returns the result. Rejects: NoWorktree | NotASubtask
// | Auth | NoChecksConfigured (a legible empty result, not an error — see FE).
#[tauri::command]
pub async fn validate_ticket(subtask_id: String, /* State: workspaces, run_commands,
    repositories, tickets_service, session */) -> Result<ValidateResult, ValidateCmdError>;

// Read the last cached validate.json (fast, for the card chip on load; no execution).
#[tauri::command]
pub async fn get_validate_result(subtask_id: String, /* … */) -> Result<Option<ValidateResult>, ValidateCmdError>;
```

```ts
// tauri.ts
validateTicket: (subtaskId: string) => invoke<ValidateResult>("validate_ticket", { subtaskId }),
getValidateResult: (subtaskId: string) => invoke<ValidateResult | null>("get_validate_result", { subtaskId }),

// types.ts
export interface ValidateCheck { name: string; command: string; passed: boolean; exitCode: number | null; tailOutput: string; }
export interface ValidateResult { subtaskId: string; checks: ValidateCheck[]; passed: boolean; ranAtMs: number; }
```

Plus a RunCommand flag (migration + CRUD passthrough): `run_in_validate: boolean` on `RunCommand`
(`domain/run_command.rs`, `Create/UpdateRunCommandInput`, `tauri.ts`, `types.ts`). Default `false`.

### C.2 — Review / QAS gate (owner: **tauri-engineer**) — `commands/review.rs`

```rust
// Move a ticket into the Review lane. Writes review.json {state:"requested", by, validatePassed}. For a
// PRODUCER subtask also calls publish_contract_inner (dependents still unblock). Returns the board.
#[tauri::command]
pub async fn request_review(subtask_id: String, /* … */) -> Result<BoardState, ReviewCmdError>;

// Resolve a review. decision ∈ {"approve","bounce"}. "approve" → review.json{approved}. "bounce" →
// review.json{changes-requested, comment} + add_comment(comment). `comment` required for bounce. Returns board.
#[tauri::command]
pub async fn resolve_review(subtask_id: String, decision: ReviewDecision, comment: Option<String>,
    /* … */) -> Result<BoardState, ReviewCmdError>;

// Read one ticket's review.json (null if none). Cheap; for the card/header on load.
#[tauri::command]
pub async fn get_review(subtask_id: String, /* … */) -> Result<Option<ReviewRecord>, ReviewCmdError>;
```

```ts
// tauri.ts
requestReview: (subtaskId: string) => invoke<BoardState>("request_review", { subtaskId }),
resolveReview: (subtaskId: string, decision: "approve" | "bounce", comment?: string) =>
  invoke<BoardState>("resolve_review", { subtaskId, decision, comment }),
getReview: (subtaskId: string) => invoke<ReviewRecord | null>("get_review", { subtaskId }),

// types.ts
export type ReviewState = "requested" | "approved" | "changes-requested";
export interface ReviewRecord { subtaskId: string; state: ReviewState; by: string; comment: string | null; atMs: number; validatePassed: boolean; }
```

`BoardState` gains no new columns; the FE fetches `review.json`/`validate.json` per open ticket (and, for the
board, batched) and feeds them to `deriveBoardState`/`deriveNextGate`. The board query (`useBoard`) is
extended to include a `reviews: ReviewRecord[]` + `validations: ValidateResult[]` side-load
(**open decision J8**: batch endpoint `get_board_gates(parentId)` vs per-ticket reads — recommended: one
`get_board_gates` returning both arrays, read alongside `get_board`).

### C.3 — The `phasr` CLI ↔ app IPC socket (owner: **tauri-engineer**, ARCHITECTURE-HEAVY) — `ipc_server.rs` + `bin/phasr.rs`

**Not a Tauri command** — a separate local socket + a new binary. Wire = line-delimited JSON on
`~/.phasr/phasr.sock`.

```jsonc
// request  (CLI → app)
{ "verb": "request-review" | "comment" | "new-ticket" | "update-status" | "validate",
  "ticket": "<subtaskId>", "token": "<PHASR_TOKEN>", "args": { /* verb-specific */ } }
// response (app → CLI)
{ "ok": true,  "result": { /* verb-specific */ } }
{ "ok": false, "error": "human-readable reason" }     // e.g. bad token, ticket not active
```

CLI verbs (mirror the UI/⌘K names 1:1): `phasr request-review`, `phasr comment "<body>"`,
`phasr new-ticket --role <r> --agent <a> --prompt "<p>" [--after <role>]` (→ `create_decomposition`-style
sub-ticket under the same epic), `phasr update-status --done` (→ `publish_contract`), `phasr validate`.
Each reads `PHASR_SOCK`/`PHASR_TICKET`/`PHASR_TOKEN` from env (falls back to `--ticket/--token` flags for
manual use). `[[bin]] name = "phasr"` in `Cargo.toml`; the binary is tiny (connect, serialize, print JSON).

**Spawn-time injection** (extends the frozen Phase-2 seed path): `PtySpawnOptions.env: Vec<(String,String)>`
→ `TaskRuntime::spawn(..., env)` → `CommandBuilder::env` (`pty/handle.rs:143-149`); `spawn_ready_subtask`
(`service.rs:889`) mints the token, registers it, and sets the four env vars + prepends the "commands you can
run" prompt segment.

### C.4 — No new command for Integrate/Ship (owner: **fe-developer**) — reuse existing

Integrate = `integrate_parent` (`tauri.ts:278`). Ship = `git_merge_to_main(parentId)` (`tauri.ts` merge
wrapper) — the parent id is a valid workspace id carrying the integration branch after integrate. Restart =
the existing recovery command. The FE only adds the derived button/menu/palette wiring.

---

## D. Cross-cutting decisions

- **D1 — Coral scarcity.** Exactly one coral `NextGateButton` per header/card (the primary next gate). The
  ⌘K Commands + ⋯ menu items are neutral. Disabled gates are muted, never coral. Runs through
  `check-contrast.mjs` at DDR time only if a new pairing appears (none expected — all map to ADR-001).
- **D2 — Confirm the outward/irreversible.** Integrate + Ship → `ConfirmDialog` (`Dialog.tsx:166`,
  `destructive` for Ship). Bounce-back → a small comment-capture dialog (required reason). Request-review /
  Validate / Approve → no confirm (cheap + reversible-ish).
- **D3 — Errors always `humanizeError`.** Every gate action funnels failures through `humanizeError`
  (`humanizeError.ts`) into a toast or `ErrorDialog` — no raw strings (matches `BoardView.tsx:247`).
- **D4 — Conflict routes into the existing surface.** Integrate conflict → `IntegrationConflict{files}` →
  `<ChangesPanel workspaceId={parentId} />` (unchanged, `BoardView.tsx:305-312`). Ship conflict →
  `MergeToMainDialog`'s existing conflict path. Zero new conflict UI.
- **D5 — Every gate stays honest.** `NextGateButton` NEVER shows a state the board can't prove: it reads
  `deriveNextGate` (pure over real signals). A disabled gate always carries a `reason`.
- **D6 — The CLI is optional + local.** The app runs fine with the socket disabled (agents just don't
  self-advance); the socket is never a network listener; the token scopes each agent to its own ticket.
- **D7 — Docs-as-files for gates.** `validate.json` + `review.json` live in the ticket folder → versioned,
  agent-readable, and ship in the PR (the "docs never drift from code" thesis extends to gate state).

---

## E. Stories (Given/When/Then AC · owner · effort)

### Epic P3 — The command layer + QAS gates

#### Story G1 — `deriveNextGate` + the `NextGateButton` component — **fe-developer** · M
*Generalizes `BoardParentHeader`'s Integrate primary + `BoardCard`'s Mark-done into one derived button.*
- **Given** a ticket that is `working` with checks configured, **When** its header/card renders, **Then**
  the single primary is "Validate" (enabled); **and** there is no second primary anywhere on the entity.
- **Given** an epic where not every ticket is integrate-eligible, **When** the epic header renders, **Then**
  the primary reads "Integrate when ready", is disabled, and its `title`/`aria-describedby` names the unmet
  condition (parity with today's `board-integrate-pending`).
- **Given** any gate, **When** it is unavailable, **Then** the button is **disabled, never hidden**, with a
  `reason`.
- **Given** `deriveNextGate`, **When** unit-tested, **Then** every ladder branch (B) is covered and it is
  pure (no I/O).
- AC: `data-testid="next-gate"` + `data-gate-verb`; `BoardParentHeader` + `BoardCard` + `$workspaceId`
  header all render `<NextGateButton>`; the old bespoke Integrate/Mark-done JSX is deleted (no duplication).

#### Story G2 — ⌘K Commands group (the human mirror of the CLI) — **fe-developer** · M
- **Given** a focused ticket/epic, **When** ⌘K opens, **Then** a **Commands** group lists every applicable
  verb using the **CLI verb names** (`validate`, `request-review`, `approve`, `bounce-back`, `integrate`,
  `ship`, `comment`, `new-ticket`), each running the same action as its button.
- **Given** a verb that is currently gated, **When** it appears in the palette, **Then** it is shown disabled
  with its reason (never silently absent) OR filtered with a "not available — <reason>" hint (pick one;
  recommended: disabled+reason for parity with the button).
- **Given** no ticket/epic focus (plain navigation context), **When** ⌘K opens, **Then** the Commands group
  is empty/absent and navigation groups are unchanged (no regression to `CommandPalette.tsx`).
- AC: new `Commands` `PaletteGroup`; verb→action map imported from the same module the button uses.

#### Story G3 — Context-menu verbs on the ⋯ menu + Ship promotion — **fe-developer** · S
- **Given** the ticket ⋯ menu (`WorkspaceActionsMenu`), **When** opened, **Then** it gains the non-primary
  gate verbs (Validate, Bounce-back) above the existing Merge/PR/Archive/Delete, reusing `MenuItem`.
- **Given** an epic that is integrated, **When** its header renders, **Then** **Ship** appears as a
  `NextGateButton` primary (promoted out of the ⋯ menu, R7), confirmed via `ConfirmDialog`.
- **Given** Ship, **When** the merge conflicts, **Then** it routes into `MergeToMainDialog`'s existing
  conflict flow (no new UI).

#### Story V1 — `validate_ticket` captured per-worktree check runner — **tauri-engineer** · L
- **Given** a ticket worktree + ≥1 `RunCommand` with `run_in_validate:true`, **When** `validate_ticket`
  runs, **Then** each check runs `sh -c "<command>"` with `cwd=worktree_path`, sequentially, under a
  timeout, and the result aggregates `passed = all checks exit 0`.
- **Given** the run, **When** it finishes, **Then** `validate.json` is written into the ticket folder AND
  the `ValidateResult` is returned; a subsequent `get_validate_result` reads it without re-running.
- **Given** a ticket with no checks configured, **When** `validate_ticket` runs, **Then** it returns a
  legible empty result (`checks:[], passed:false`) — NOT an error — so the FE shows "Add a check".
- **Given** a non-subtask / no-worktree id, **When** called, **Then** it rejects `NotASubtask`/`NoWorktree`.
- **Given** the test harness, **When** the check binary/shell is env-overridden, **Then** a canned
  pass/fail is deterministic (mirror the planner's `claude`-binary override).
- AC: new `commands/validate.rs` + `orchestrator/validate.rs`; `run_in_validate` migration + CRUD; registered
  in `lib.rs`; `cargo test` covers pass, fail, timeout, no-checks, non-subtask.

#### Story V2 — Validate on the card + as a Request-review precondition — **fe-developer** · M
- **Given** a `ValidateResult`, **When** a card/header renders, **Then** a pass/fail chip shows (soft
  `success`/`danger`, never coral) with the failing-check count.
- **Given** validation is failing, **When** the ladder computes the gate, **Then** **Request review** is
  disabled with "Fix N failing checks" (unless the user takes an explicit "request anyway" override).
- **Given** Validate is running, **When** the button is clicked, **Then** it shows a spinner + is
  re-entrancy-guarded (belt+braces like `handleIntegrate`, `BoardView.tsx:214`).
- AC: `deriveNextGate` reads `validate.json`; the chip has a `data-testid="validate-chip"`.

#### Story R1 — `request_review` / `resolve_review` + `review.json` file-service — **tauri-engineer** · L
- **Given** a ticket, **When** `request_review` runs, **Then** `review.json{state:"requested"}` is written;
  **and** if the ticket is a producer, `publish_contract_inner` also runs (dependents unblock).
- **Given** an in-review ticket, **When** `resolve_review("approve")`, **Then** `review.json{approved}`;
  **When** `resolve_review("bounce", comment)`, **Then** `review.json{changes-requested, comment}` **and**
  `add_comment(comment)` appends to the thread; a bounce with no comment rejects.
- **Given** the ticket folder is fs-watched (Phase 2 `watch_ticket`), **When** `review.json` changes, **Then**
  the board/detail re-reads it live (reuse `phasr://ticket-changed` or a board invalidation).
- **Given** the writes, **When** inspected, **Then** `WorkspaceStatus` is unchanged (invariant #10 holds).
- AC: new `commands/review.rs` + a `tickets`-service reader/writer for `review.json` (single-writer, path
  traversal-safe like Phase 2 A1); registered; `cargo test` covers request/approve/bounce/producer-compose.

#### Story R2 — Review lane + QAS chips in the derive layer — **fe-developer** · M
- **Given** `review.json{requested}`, **When** the board derives lanes, **Then** the ticket is in the
  **Review** lane as `in-review`.
- **Given** `review.json{changes-requested}`, **When** derived, **Then** the ticket returns to **In progress**
  with a neutral "changes requested" chip (mirror `BlockedChip` tone) and its next gate is Request-review
  again (after re-work).
- **Given** `review.json{approved}`, **When** derived, **Then** the ticket shows a soft `success`
  integrate-eligible check and contributes to the epic's `integrable`.
- **Given** an in-review ticket viewed by the reviewer, **When** the header renders, **Then** the primary is
  a paired **Approve** (primary) + **Bounce-back** (secondary, opens the comment dialog).
- AC: `deriveBoardState` extended with `in-review`/`qas-changes-requested`; `boardColumn` maps them;
  `integrable` recomputed per B; unit tests + `e2e/board.spec.ts` review-lane flow.

#### Story CLI1 — The `phasr` CLI ↔ local IPC socket (no-MCP agent writes) — **tauri-engineer** · L · ARCHITECTURE-HEAVY (gated on J1)
- **Given** the app is running, **When** it starts, **Then** it binds `~/.phasr/phasr.sock` (0600) and
  serves line-delimited JSON, dispatching each verb through the SAME `_inner` handler as the Tauri command
  and emitting the SAME `phasr://…` event.
- **Given** a spawned ticket agent, **When** it runs `phasr request-review` (or `comment`/`new-ticket`/
  `update-status`), **Then** the board updates **live** (the human sees the lane move without a refresh) and
  the CLI prints the JSON result.
- **Given** a request whose `token` doesn't map to the named `ticket`, or whose subtask is not active,
  **When** received, **Then** the app rejects it (`#EXPORT_CRITICAL`: an agent can only mutate its own
  ticket).
- **Given** spawn, **When** a ticket agent starts, **Then** `PHASR_SOCK/PHASR_TICKET/PHASR_TOKEN/PHASR_BIN`
  are in its env and the seed prompt tells it which `phasr` verbs it may run.
- AC: `[[bin]] phasr`; `ipc_server.rs` listener; `PtySpawnOptions.env` plumbed; `CliTokenRegistry`;
  `cargo test` covers verb dispatch (with a stub socket client), token rejection, and event emission.
  **Do not start until system-architect signs off J1–J5.**

---

## F. Build order (dependency-correct)

1. **V1** (`validate_ticket` + `run_in_validate` migration) — no FE dep; unblocks the ladder's Validate step.
2. **R1** (`request_review`/`resolve_review` + `review.json`) — no FE dep; unblocks the Review lane.
3. **G1** (`deriveNextGate` + `NextGateButton`) — depends on V1/R1 result shapes existing (can stub the
   fetch initially); generalizes the two existing primaries.
4. **R2** (Review-lane derivation + chips) — depends on R1 + G1.
5. **V2** (Validate chip + precondition) — depends on V1 + G1.
6. **G2** (⌘K Commands group) + **G3** (⋯ verbs + Ship promotion) — depend on G1 (share the verb→action map).
7. **CLI1** (`phasr` socket) — **LAST**, gated on architect sign-off (J1–J5); reuses the `_inner` handlers
   from V1/R1 and `publish_contract`/`create_decomposition` so it must follow them.

Rationale: backend gate-writers first (they're pure additions with no UI risk), then the unifying FE
component, then the surfaces that read it, then the architecture-heavy CLI once its handlers exist and the
architect has ruled on the socket.

---

## G. State matrix (every state offers an action — no dead ends)

| Surface | Empty / none | Loading | Error | Gated / disabled | Live |
|---|---|---|---|---|---|
| `NextGateButton` | — (an entity always has a next gate; terminal "shipped" shows a calm "Done" pill) | spinner + gate label ("Integrating…", "Validating…") | `humanizeError` toast/dialog; button re-enables | disabled + `reason` in `title`/aria (never hidden) | primary coral, single per entity |
| Validate chip | "Add a check to validate" (links to run-commands settings) | "Validating…" | failing-check count + expand to `tailOutput` | — | pass = soft success, fail = soft danger |
| Review lane | empty lane placeholder "—" (as today) | — | bounce with no comment → inline "reason required" | Approve/Bounce only when `requested` | in-review + approved + changes-requested chips |
| ⌘K Commands | absent when no entity focus | reuses palette loading | — | disabled verbs carry their reason | verb list mirrors the CLI |
| `phasr` CLI | socket down → CLI prints "phasr app not running" (non-fatal) | — | bad token → "not authorized for this ticket" | — | live board update on success |

---

## H. Testing strategy

**Rust `cargo test`** — `validate_ticket` (pass/fail/timeout/no-checks/non-subtask, env-overridden check
binary); `request_review`/`resolve_review` (request, approve, bounce+comment, producer-compose, `review.json`
round-trip, path-traversal rejection); `deriveNextGate` equivalents where logic is shared; the `phasr` socket
dispatch (stub client → each verb hits the right `_inner`, token rejection, `phasr://` event fired via a test
`AppHandle`/emit spy); `PtySpawnOptions.env` reaches `CommandBuilder`.

**Frontend `pnpm typecheck` + `pnpm test`** — `deriveNextGate` (every ladder branch, pure); `deriveBoardState`
extended for `in-review`/`qas-changes-requested`; the verb→action map parity (button label == CLI verb name).

**Playwright (`e2e/board.spec.ts`, `e2e/brief.spec.ts` — run the FULL suite each time; a scoped run hid a
regression last session)** — the gate ladder (a ticket walks Validate → Request-review → in the Review lane →
Approve → the epic becomes integrate-eligible → Integrate → Ship); the disabled-with-reason on an
un-ready epic; the ⌘K Commands group firing the same action as the button; Bounce-back writing a comment and
re-opening the ticket. **Note the harness caveat (MEMORY testing-blind-spots):** the mocked-IPC e2e verifies
the flow *fires* the right command/verb — it can NOT prove the check subprocess actually ran or that the
socket round-trips. Those need the manual smoke.

**Manual smoke (the real gate)** — configure a real check (`pnpm typecheck`) with `run_in_validate`, run
Validate on a live ticket, watch it pass/fail from the branch; from a spawned agent's terminal run
`phasr request-review` and watch the board lane move live; Bounce-back and confirm the agent reads the
comment; Integrate → Ship and confirm the branch lands on main. Confirm `validate.json`/`review.json` appear
in the PR diff (docs-as-files).

---

## I. Files to touch (condensed)

**NEW** — `src-tauri/src/commands/validate.rs`, `orchestrator/validate.rs`, `commands/review.rs`,
`ipc_server.rs`, `bin/phasr.rs`; a `review.json`/`validate.json` reader-writer in the `tickets` service;
`src/lib/deriveNextGate.ts`, `src/components/board/NextGateButton.tsx` (+ its verb→action map), a bounce
comment dialog. **Migration** for `run_command.run_in_validate`.
**CHANGED** — `commands/board.rs` (expose `publish_contract_inner` for reuse), `run_commands.rs` +
`domain/run_command.rs` (the flag), `pty/handle.rs`+`pty/runtime.rs` (`env` field), `orchestrator/service.rs`
(mint token, set env, "commands you can run" prompt segment), `orchestrator/scheduler.rs` (prompt segment),
`lib.rs` (register commands + spawn the socket listener), `deriveBoardState.ts` (`in-review`/
`qas-changes-requested`), `board/BoardView.tsx` + `board/BoardCard.tsx` (→ `NextGateButton`, delete bespoke
primaries), `routes/.../$workspaceId.tsx` header (`NextGateButton`), `WorkspaceActionsMenu.tsx` (gate verbs +
Ship promotion), `CommandPalette.tsx` (Commands group), `tauri.ts` + `types.ts` (the C-contract),
`useBoard.ts` (gate side-load), `design-test.tsx` (all new states).

---

## J. Open architecture decisions (recommended defaults — **for system-architect before implementation**)

**J1 — The `phasr` CLI → board mechanism (THE decision).** **Recommend (b): a local Unix-domain-socket IPC
the app exposes**, CLI as a thin client, app as the single writer dispatching through the existing `_inner`
handlers + emitting `phasr://…` events (A6). Rationale: single-writer WAL integrity, live events (only the app
holds the `AppHandle`), in-memory coherence (scheduler guards + liveness + `TaskRuntime`), and DRY (CLI and UI
share one handler). Rejected (a) direct-DB-write: races the pool, fires no events, desyncs in-memory state.
Fallback (a') file+watch already works for pure-file verbs (`comment`→`comments.jsonl`, `fswatch.rs`) and is
the degraded path if the socket proves fragile. **Architect to rule: socket vs. named pipe vs. a loopback
HTTP port; and whether Windows (no AF_UNIX before recent builds) needs a named-pipe branch.**

**J2 — Which run-commands are Validate checks.** Recommend an opt-in `run_in_validate:bool` flag on
`RunCommand` (default false), so the user marks lint/test/typecheck explicitly; no checks → legible no-op.
Alternative rejected: a naming convention (fragile) or running all pinned (dev servers never exit).

**J3 — `PtySpawnOptions.env` plumbing.** Recommend adding `env: Vec<(String,String)>` through
`TaskRuntime::spawn` → `CommandBuilder::env` (the loop already exists, `pty/handle.rs:143-149`). This is the
clean injection point for `PHASR_*` (and future per-agent secrets). Architect to confirm this doesn't leak
into the interactive shell's exported env in a way that surprises the user.

**J4 — Getting `phasr` on the agent's PATH.** Recommend injecting `PHASR_BIN` = absolute path to the bundled
binary + instructing the agent to call `"$PHASR_BIN" <verb>` (no PATH mutation, no shim install). Alternatives:
prepend a resource dir to `PATH` in the spawn env, or install a `/usr/local/bin` shim (needs privileges).

**J5 — CLI token lifecycle.** Recommend a per-subtask random token minted at spawn, held in an in-memory
`CliTokenRegistry` (`token→(subtaskId,userId)`), invalidated when the subtask exits/is deleted. Scopes an
agent to its own ticket. Architect to rule on persistence across an app restart (re-mint on re-spawn vs.
persist) and whether the token also gates `new-ticket` (creating siblings) or only self-mutations.

**J6 — "Shipped" persistence.** Recommend deriving the terminal shipped state from
`git_branch_status(parentId).aheadOfTarget===0` after `git_merge_to_main` — **no new column, `WorkspaceStatus`
stays frozen**. Alternative: a `shipped.json` gate file (consistent with review/validate) if a stronger record
is wanted.

**J7 — Is QAS approval mandatory for Integrate?** Recommend: approval required only for tickets where a review
was *requested*; a ticket that reached `needs-review` without a request stays integrate-eligible
(backward-compatible with today's board, which has no review step). Alternative: hard-require an explicit
Approve on every ticket (stricter SAFe gate, but breaks the existing single-shot flow).

**J8 — Gate side-load shape.** Recommend one `get_board_gates(parentId) -> { reviews[], validations[] }` read
alongside `get_board`, over N per-ticket reads. Keeps the board render one round-trip.

**J9 — QAS as a real spawned *agent* (plan open decision #7).** Recommend v1 QAS is a **human** gate (the
Approve/Bounce buttons + the CLI verbs a *human-directed* agent could call). A dedicated QAS-persona agent that
auto-runs the review and writes `review.json` via the CLI is **Phase 4/5** (it needs the persona bundle). This
keeps `WorkspaceStatus` frozen now — if QAS becomes a real running agent later, its *running* state is a
genuine backend signal and revisits invariant #10. Flagged, not decided here.

---

## Forward hooks (explicitly out of scope, wired for later)

- **Retro / Quick-task / Autopilot** verbs (plan Phase 5) slot into the same `deriveNextGate` ladder + the
  `phasr` CLI verb set with no new mechanism.
- **Persona-seeded QAS agent** (Phase 4) reuses `request_review`/`resolve_review` `_inner` + the CLI socket.
- **External-harness MCP** (Phase 5) is the ONLY case that revisits "no MCP" — the socket here is
  local-agent-only by design.

## Architect Stage-1 corrections (REQUIRED before implementation — GO is conditional on these)

**BIGGEST RISK — the live-update path is asserted but does NOT exist.** `publish_contract`/`integrate_parent` refresh the UI only via their return value (`board.rs:247-269`); no `phasr://` event is emitted, and `useBoardTaskEvents` invalidates only for *already-known* subtask ids with no `refetchInterval` (`useBoard.ts:83-114`). So a CLI-driven mutation updates the DB/file but the open board does NOT move. This is the mocked-IPC blind spot (proves the verb fired, not that the board re-rendered) — needs a manual-smoke assertion.

1. **Live-refresh event plumbing (do FIRST, it's foundational).** After each successful `_inner` dispatch (from a command OR the CLI IPC server), emit a board-refresh event. Reuse the existing `broadcast::Sender<TaskStatusEvent>` that `spawn_status_bridge` re-emits as `phasr://task-status` (`orchestrator.rs:24,174-180`), or the `AppHandle`. Wire the IPC server with a clone.
2. **`new-ticket` live gap.** `useBoardTaskEvents` won't surface a NEW sibling (unknown id). Add a **`phasr://board-changed { parentId }`** event (or have the FE also invalidate when an event's parent/repository matches) so new tickets appear live without a manual refresh.
3. **Validate PATH (latent-bundle bug).** A Finder-launched `.app` has a minimal PATH (no `/opt/homebrew/bin`) → bare `sh -c "pnpm typecheck"` fails `command not found` (the planner has this latent). The captured Validate runner MUST augment PATH — reuse `shell::terminal_env`'s macOS PATH logic, or use a **login** shell (`sh -lc`), not `sh -c`.
4. **Socket lifecycle.** Bind `~/.phasr/phasr.sock`; **best-effort `remove_file` BEFORE bind** (stale-on-crash → else EADDRINUSE); `set_permissions(0o600)` after bind; **one task per connection** (a `validate` holds the conn tens of seconds, must not block `comment`); remove on quit via a `RunEvent::Exit` handler (`lib.rs:244` currently `.run()` with none). **Zero new dependency** — `tokio` `full` already ships `UnixListener`; gate the listener `#[cfg(unix)]` (Windows deferred; abstract behind a small `trait CliTransport`). Reject loopback-HTTP (network-reachable, no fs perms) and the file+watch fallback (fire-and-forget, no result/id, doubles surface) — standardize on the socket; file+watch is a documented non-goal, not code.
5. **Token model (reframed) + scope/lifecycle.** The token is NOT a hard security boundary — the agent already runs arbitrary code as the user (it can scribble ticket files directly; the socket adds no FS reach). Goal = accident-prevention + blast-radius bounding. The per-subtask token + 0600 socket + ticket-scoping is ACCEPTABLE for local single-user; do NOT add per-connection handshakes / rotating tokens. Registry `token → (subtaskId, userId, parentId)`; reject if token↔ticket mismatch or subtask not `Running`; **`new-ticket` bounded to the token's own epic (`parentId`)**; mint per-spawn in-memory, invalidate on exit, **re-mint on respawn — NEVER persist across app restart**. Residual risk to document: a same-user process can read another's env (`ps eww`) → a sibling token is harvestable; blast radius = mutate a sibling in the same epic (< the FS access it already has).
6. **"Shipped" derivation.** Not `aheadOfTarget===0` alone (a never-integrated parent also reads 0). Shipped = **parent carries an integration branch AND that branch is merged into base** (via `git_branch_status(parentId)`). Still no new column. Soften D7: brief + gate files are UNCOMMITTED on the main checkout — they don't "ship in the PR" until committed onto a branch (inherited Phase-2 property).
7. **CLI binary build.** `[[bin]] name="phasr"` in the same package, **dependency-light** (only `std::os::unix::net::UnixStream` + `serde_json` — do NOT `use phasr_lib::…` heavy modules; share a tiny leaf wire struct). Bundle as a **sidecar (`externalBin`) / resource** (`tauri.conf.json` has none today); the sidecar naming appends the target triple (pre-bundle copy step); `PHASR_BIN` = absolute path (J4), with a dev/`cargo test` fallback to `target/<profile>/phasr`.

Confirmed correct (no change): env on `PtySpawnOptions` (only `spawn_ready_subtask` populates it; other paths pass empty → identical), gates-as-files, `run_in_validate` opt-in (J2), one `get_board_gates` batch (J8), approval mandatory only where review was requested (J7), v1 QAS is a human gate (J9). `_inner` handlers need only `pub(crate)`.
