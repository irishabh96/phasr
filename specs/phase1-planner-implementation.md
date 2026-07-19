# Phase 1 — The Planner (goal → board): Implementation Breakdown

**Mode:** story elaboration → implementation-ready. **Date:** 2026-07-20. **Author:** BSA.
**Roadmap:** [`velvety-sniffing-thompson.md`](/Users/rishabh/.claude/plans/velvety-sniffing-thompson.md)
— Phase 0 (harden the P0 board) + **Phase 1 (the Planner)**, phasr's evolution into a local AI software factory.
**Design contract (build to this):** `scratchpad/phasr-factory-pages.html` — the founder-approved page
mockups. **Page 02 "Planner — New epic → decompose review"** and **Page 03 "Epic board"** are the surfaces
this milestone builds. Tokens transcribed verbatim from `src/index.css`; discipline preserved (only STATUS
carries semantic color; persona/role chips neutral; coral scarce = primary gate + selection).
**Continuity:** [`multi-agent-task-board-spec.md`](./multi-agent-task-board-spec.md) (the MATB epic),
[`task-board-p0-implementation.md`](./task-board-p0-implementation.md) (the P0 gate/scheduler/integrate that
shipped), [`step0-honest-status-implementation.md`](./step0-honest-status-implementation.md) (the honest-status
substrate). This spec turns Phase 0 + Phase 1 into files-to-touch, Given/When/Then, the frozen IPC contract,
owners, effort, tests, and a build order. Every load-bearing claim is checked against code (`file:line`).

---

## 0. Validation Log (claims checked against code, before planning)

| # | Claim | Verdict | Evidence (`file:line`) |
|---|-------|---------|----------------------|
| 1 | `validate_decomposition` does **NOT** reject dependency cycles | **CONFIRMED — the gap** | `commands/board.rs:390-431` — checks only: non-empty subtasks (`:392`), non-empty role (`:399`), duplicate role (`:404`), self-edge (`:412`), unknown from/to-role (`:418`/`:424`). **No cycle detection, no size cap.** The doc-comment at `:100` even says a cycle is "detected at integration time," and `:562-564` confirms "the gate's `validate_decomposition` doesn't reject cycles." A cyclic plan is only surfaced later by `topological_subtask_order` (`:673-674`), which would deadlock the scheduler if it ever spawned. |
| 2 | Kahn indegree logic exists to reuse for the cycle check | **CONFIRMED** | `topological_subtask_order` (`board.rs:635-680`) is a full Kahn sort over `&[Workspace]`+`&[WorkspaceDependency]` (id-keyed); returns `InvalidDecomposition("dependency cycle detected…")` when `order.len() != subtasks.len()` (`:672-675`). The pattern is directly portable to a role-keyed check. |
| 3 | The gate doesn't reject cycles is asserted by a test | **CONFIRMED** | `topological_subtask_order_puts_producers_before_consumers` (`board.rs:1411`); the cycle assertion is `:1428-1433` (`back_edge` → `InvalidDecomposition`). Comment `:1408-1409`: "a cycle is surfaced (the gate doesn't reject cycles)." (The plan cited `:1409`; the `#[test]` fn is `:1411`.) |
| 4 | The backend is **generic** — accepts an arbitrary N-subtask/M-edge DAG with a per-subtask agent | **CONFIRMED** | `create_decomposition_inner` (`board.rs`) loops over `input.subtasks` (`:329-345`) and `input.edges` (`:349-372`) with no fixed topology; `DecompositionInput`/`SubtaskInput`/`EdgeInput` (`board.rs:38/49/59`) are generic. The doc-comment `:388` states the fixed shape "is enforced by the frontend form, not the command." **The planner produces exactly this shape.** |
| 5 | The **form** is hardcoded to 2 subtasks | **CONFIRMED** | `DecomposeForm.tsx` — `FIXED_EDGE = { fromRole:"backend", toRole:"frontend" }`, a literal 2-element `subtasks` array both `agent:"claude"` (`subtasks: [{role:"backend"…},{role:"frontend"…}]`), one fixed read-only edge, button text "Start 2 agents". Two `RolePrompt` fields, no agent picker, no add/remove, no editable DAG. **This is the file rewritten in this milestone.** |
| 6 | `Agent` enum + `command()` provide the capability menu + per-agent CLI | **CONFIRMED** | `domain/agent.rs` — `Agent::{Claude,Codex,Copilot,Gemini,OpenCode}` (`:10-17`), `ALL` (`:20-27`), `as_str`/`from_str` (`:34-55`, lowercase serde), `command()` (`:69-79`). `list_agents` (`commands/agents.rs:23`) returns `AgentOption{agent,label,command,isDefault}` — the FE agent-select source (`tauri.ts:187`, `types.ts:74-80`). |
| 7 | `SubtaskInput`/`EdgeInput` are **Deserialize-only** (need `Serialize` for the planner to return them) | **CONFIRMED** | `board.rs:47` and `board.rs:56` both `#[derive(Debug, Deserialize)]` — no `Serialize`. `ProposedPlan` returns these to the FE, so both need `Serialize` added (the plan's ask). |
| 8 | Phase 0: after a clean `integrate_parent`, the combined-diff review is **empty** | **CONFIRMED** | `integrate_parent_inner` commits every merge into the integration worktree, leaving it **clean** (`board.rs:609-624`). The review dialog renders `<ChangesPanel workspaceId={board.parent.id} />` (`BoardView.tsx:297`), which reads working-tree state via `useGitStatus`→`git_status` (`ChangesPanel.tsx:69`, `commands/git.rs:90-97`). A clean worktree → `git_status` empty → **nothing to review** on the clean path. (Conflict path is fine: the mid-merge worktree carries conflict markers.) |
| 9 | git shells out to a **hardcoded** `"git"` binary; there is no existing env-overridable "Command git-test scaffolding" to mirror | **CONFIRMED — plan wording corrected** | `git/error.rs:52` (`run_git`) and `:79` (`run_git_with_stdin`) both `std::process::Command::new("git")`, no env lookup. Board tests use **real** git on tempdirs (`fresh_with_git`, `commit_on_branch`, `board.rs` test mod). So the planner introduces a **new** `PHASR_CLAUDE_BIN` override (structurally the same idea, but net-new — see §C-CORR-A). |
| 10 | There is no existing captured (non-PTY) async subprocess to model the planner on | **CONFIRMED** | The scheduler spawns agents via `portable_pty` (`service.rs:46`, `spawn_ready_subtask :888`); git uses **sync** `std::process` (`error.rs:52`). The planner's `tokio::process` captured one-shot + `tokio::time::timeout` is net-new but standard; model the **stdout capture** on `run_git`'s `capture_stdout` (`error.rs:29-39`). |
| 11 | `plan_decomposition` persists nothing; the existing gate (`start_decomposition`) is the only write | **CONFIRMED (design intent)** | `start_decomposition` is the sole B2 write path (`board.rs`); nothing else creates parent/subtask rows. `plan_decomposition` returns a `ProposedPlan` DTO and touches no repo/store — the FE draft lives in the form until "Start N agents" fires `start_decomposition` (unchanged). |

**Net:** every load-bearing claim in the brief is confirmed. Three wording corrections (§C-CORR) do not change scope; they sharpen the implementation.

---

## A. Architecture decisions (`#PATH_DECISION`)

**A1 — One shared, hardened validator.** `validate_decomposition` is refactored to take `(&[SubtaskInput], &[EdgeInput])` instead of `&DecompositionInput`, so **both** the gate (`create_decomposition_inner`) **and** the planner call the *same* well-formedness check. The cycle check + `MAX_SUBTASKS` cap land once and protect both entry points. (Alternative — a second validator in `planner.rs` — rejected: drift between "what the planner accepts" and "what the gate accepts" is exactly the deadlock class we're closing.) The id-keyed `topological_subtask_order` cycle check **stays** as integration-time defense-in-depth.

**A2 — The planner runs on phasr's own agent infra, read-only, captured.** New `orchestrator/planner.rs` runs `claude -p "<prompt>" --output-format json --permission-mode plan` as a `tokio::process` one-shot **in the repository directory** (so it can inspect the codebase) with `--permission-mode plan` (read-only — the planner must never mutate the repo) under a `tokio::time::timeout`. **No API key, no SDK, no MCP** — same "shell out to the user's installed agent" posture as the scheduler. The planner *itself* is always Claude even though it *assigns* codex/gemini/etc. to individual tickets (agent-per-ticket is a field it fills from a capability menu, not backend routing).

**A3 — The planner returns the generic gate shape.** `ProposedPlan = { subtasks: SubtaskInput[], edges: EdgeInput[] }` — literally `DecompositionInput` minus `repositoryId`+`parentPrompt`. The FE takes it, lets the user edit, then submits `DecompositionInput { repositoryId, parentPrompt: goal, subtasks, edges }` to the **unchanged** `start_decomposition`. The planner is a *drafting* step in front of a gate that already works.

**A4 — Nothing persists before "Start N agents."** The B2 approval gate is preserved byte-for-byte. `plan_decomposition` is a pure read/compute; the editable draft lives in FE state; the single `start_decomposition` call is the only write. The whole surface is "never a dead end": a planner failure drops the user into manual editing rather than blocking.

---

## B. Phase 0 prerequisite — the empty combined-diff fix

**Story P0-1 — Branch-vs-base combined diff for a clean integration.**
**As** a user who just integrated an epic, **I want** the "Integration review" dialog to show the combined
diff of everything the agents produced, **so that** I can review the merged work before shipping to main —
even though the integration worktree is clean (already committed).

**Root cause (verified, claim #8):** `integrate_parent_inner` commits each subtask merge into the integration
worktree → it's clean → the review dialog's `ChangesPanel`→`git_status` (`BoardView.tsx:297`) shows nothing.

**Fix:** add a **branch-vs-base** read at the git layer + a command; the FE points the *clean-case* review at
it. The *conflict-case* keeps the existing `ChangesPanel` worktree surface (which correctly shows conflict
markers on a mid-merge worktree).

**Owners:** tauri-engineer (backend, B.1–B.2) · fe-developer (wire, B.3).

**B.1 — git layer (tauri-engineer).** New fn beside `diff.rs`/`status.rs`:
```rust
// git/diff.rs (or a new git/range.rs re-exported from git/mod.rs)
/// Unified diff of everything `branch` added since it diverged from `base`
/// (symmetric three-dot: `git diff <base>...<branch>`), scoped to `path` when given.
pub fn diff_branch_range(cwd: &Path, base: &str, branch: &str, path: Option<&str>)
    -> Result<String, GitError>
```
Implementation: `run_git(cwd, &["diff", "--no-color", &format!("{base}...{branch}"), …])` (reuse the existing
`run_git` + `capture_stdout` truncation, `error.rs:52/29`). Three-dot = merge-base diff, so it shows exactly
the integration branch's additions, not unrelated drift on `base`.

**B.2 — command (tauri-engineer).** New `commands/board.rs` handler (register in `lib.rs` invoke_handler
beside the other board commands, `lib.rs:164-167`):
```rust
#[tauri::command]
pub async fn board_integration_diff(parent_id: String, path: Option<String>, …)
    -> Result<String, BoardCmdError>
```
Resolve the parent row (owner-scoped, `get_for_user`), read `parent.branch` (the integration branch set by
`integrate_parent`) + the repository's `default_branch` as `base` (mirror `git_branch_status`'s repo lookup,
`commands/git.rs:264-268`), run `diff_branch_range` inside `parent.worktree_path` off the blocking pool
(`blocking_git`, `commands/git.rs:76`). Errors reuse `BoardCmdError::Git`.

**B.3 — FE wire (fe-developer).** `tauri.ts` + `useGit`/board hooks: `boardIntegrationDiff(parentId, path?)`.
In `BoardParentHeader` (`BoardView.tsx:283-298`), the **clean** review (`reviewMode === "clean"`) renders a
diff view fed by `board_integration_diff` (a read-only `DiffView`/`DiffList` over the returned unified diff);
the **conflict** review (`reviewMode === "conflict"`) keeps `<ChangesPanel workspaceId={parent.id} />`
unchanged. Selecting which surface stays a pure function of `reviewMode` (already tracked, `BoardView.tsx:195`).

**Acceptance criteria (P0-1):**
- **Given** a clean integration (parent carries an integration `branch`/`worktreePath`, worktree committed),
  **When** the user opens "Integration review", **Then** the dialog shows the combined `base...branch` diff
  (both subtasks' files) — not an empty panel.
- **Given** an integration that stopped on a conflict, **When** the dialog opens, **Then** the existing
  conflict-resolution surface (`ChangesPanel` → `git_merge_in_progress`/`git_resolve_conflict`/
  `git_continue_merge`/`git_abort_merge`, claim in `task-board-p0` spec) is shown unchanged.
- **Given** the diff exceeds the 16 MiB cap, **Then** it truncates with the existing `capture_stdout` marker
  (`error.rs:33-37`) — no IPC flood.
- cargo test: `diff_branch_range` returns both files' additions for two non-overlapping branches merged into an
  integration branch (extend the `integrate_parent_merges_two_subtasks_cleanly` fixture, `board.rs:1201+`).
- Playwright: the clean-integration review renders a non-empty diff (extend `e2e/board.spec.ts`, which already
  mocks `integrate_parent` clean + a `SAMPLE_DIFF`).

**Effort:** Small. **Independent of Phase 1** — can land alongside the backend planner stream.

---

## C. Phase 1 — the frozen IPC contract (3-place, author FIRST to unblock parallel FE)

Freeze this before either stream starts; the FE builds against the types even while the backend planner is
still stubbed (the e2e harness already mocks IPC).

### C.1 — Rust (`commands/planner.rs`, new)
```rust
use crate::commands::board::{EdgeInput, SubtaskInput};   // reused verbatim

/// The planner's proposed decomposition — DecompositionInput minus repositoryId + parentPrompt.
/// Persists nothing; the FE edits it, then submits the whole plan through the unchanged gate.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposedPlan {
    pub subtasks: Vec<SubtaskInput>,   // { role, agent, prompt }
    pub edges: Vec<EdgeInput>,         // { fromRole, toRole }
}

#[tauri::command]
pub async fn plan_decomposition(
    repository_id: String,
    goal: String,
    repositories: State<'_, RepositoryRepo>,
    session: State<'_, Arc<SessionState>>,
) -> Result<ProposedPlan, PlannerCmdError>;
```
**Precondition (board.rs):** add `Serialize` to `SubtaskInput` (`board.rs:47`) and `EdgeInput` (`board.rs:56`)
→ `#[derive(Debug, Serialize, Deserialize)]`. Both keep `#[serde(rename_all = "camelCase")]`, so the wire is
`{ role, agent, prompt }` / `{ fromRole, toRole }` in both directions. `Agent` already round-trips lowercase.

**`PlannerCmdError` (serializes to a plain string, like `BoardCmdError`):** `EmptyGoal`, `NoRepoPath`,
`Auth(AuthError)`, `Planner(PlannerError)` where `PlannerError ∈ { Spawn(String), Timeout, Malformed(String),
Invalid(String) }` (§D.2). Each maps to honest, `humanizeError`-friendly copy.

### C.2 — TS (`types.ts` + `tauri.ts`)
```ts
// types.ts — beside DecompositionInput
export interface ProposedPlan {
  subtasks: SubtaskInput[];   // reuse existing SubtaskInput (types.ts:359)
  edges: EdgeInput[];         // reuse existing EdgeInput (types.ts:366)
}
// tauri.ts — beside startDecomposition (tauri.ts:244)
planDecomposition: (repositoryId: string, goal: string) =>
  invoke<ProposedPlan>("plan_decomposition", { repositoryId, goal }),
```

### C.3 — corrections to the brief's wording (no scope change)
- **C-CORR-A (claim #9):** there is no env-overridable git "Command scaffolding" to mirror. The planner
  introduces its **own** `PHASR_CLAUDE_BIN` override (default `"claude"`); tests point it at a stub script.
- **C-CORR-B (claim #10):** no existing captured async subprocess. `tokio::process::Command` + captured
  stdout + `tokio::time::timeout` is net-new; model stdout handling on `run_git`/`capture_stdout`.
- **C-CORR-C:** `--output-format json` returns claude's **envelope** (`{ "type":"result", "result":"…", … }`),
  not the plan JSON directly. Extraction is **two-layer**: parse the envelope, take `.result`, then
  fenced-JSON-extract the plan from that text (§D.2). Extraction must tolerate raw JSON, ```json fences, and
  the envelope.

---

## D. Phase 1 — backend stories (owner: tauri-engineer, one sequential stream)

### Story BE-1 — Harden the shared validator (cycle check + size cap)
**As** the scheduler, **I want** the gate to reject cyclic or oversized plans up front, **so that** an invalid
plan can never be persisted into a DAG that deadlocks me.

**Files:** `commands/board.rs`.
**Tasks:**
1. Refactor `validate_decomposition(&DecompositionInput)` → `validate_decomposition(subtasks: &[SubtaskInput],
   edges: &[EdgeInput])`; update the single caller `create_decomposition_inner` to pass
   `(&input.subtasks, &input.edges)` (`board.rs:326`).
2. Add `const MAX_SUBTASKS: usize = 12;` (open decision D-OQ1). After the non-empty check (`:392`), reject
   `subtasks.len() > MAX_SUBTASKS` → `InvalidDecomposition("a decomposition can have at most {MAX_SUBTASKS} …")`.
3. After the edge referential-integrity checks (`:406-427`), add a **role-keyed Kahn cycle check** (indegree
   over role strings; roles are already unique + edges already referential at that point) → reject with
   `InvalidDecomposition("dependency cycle detected among subtasks")` (same message the id-keyed sort uses,
   `:674`). Structurally identical to `topological_subtask_order` (`:635-680`) but keyed on `role`.
4. Leave the integration-time `topological_subtask_order` cycle guard in place (defense-in-depth).

**Acceptance criteria (Given/When/Then):**
- **Given** subtasks `a,b` with edges `a→b, b→a`, **When** validated, **Then** `InvalidDecomposition` (cycle).
- **Given** a chain `a→b→c→a`, **Then** `InvalidDecomposition` (multi-hop cycle).
- **Given** `MAX_SUBTASKS + 1` subtasks, **Then** `InvalidDecomposition` (cap).
- **Given** a valid DAG (the existing `sample_input`, `board.rs:739`), **Then** `Ok(())` — regression holds; the
  P0 gate/scheduler/integrate tests still pass unchanged.
**Tests (cargo):** `validate_rejects_two_node_cycle`, `validate_rejects_multi_hop_cycle`,
`validate_rejects_over_cap`, `validate_accepts_valid_dag` — the cycle-rejection is the net-new coverage that
closes the claim #1 gap.
**Effort:** Small. **Ships value immediately** (independent of the planner).

### Story BE-2 — The planner subprocess (`orchestrator/planner.rs`, new)
**As** phasr, **I want** to turn a one-line goal into a validated `{subtasks, edges}` draft by running Claude
read-only over the repo, **so that** the user gets a real proposed plan to review instead of a blank form.

**Files:** new `orchestrator/planner.rs`; export from `orchestrator/mod.rs` (`mod planner; pub use planner::{plan, PlannerConfig, PlannerError};`).
**Shape:**
```rust
pub struct PlannerConfig { pub binary: String, pub timeout: Duration }
impl Default for PlannerConfig {  // binary from env PHASR_CLAUDE_BIN or "claude"; timeout 90s (D-OQ2)
    fn default() -> Self { … }
}
pub async fn plan(repo_dir: &Path, goal: &str, config: &PlannerConfig)
    -> Result<(Vec<SubtaskInput>, Vec<EdgeInput>), PlannerError>;
```
**Tasks:**
1. **Prompt (SAW-method BSA):** compose a read-only decomposition prompt embedding (a) the goal, (b) a
   **capability menu** enumerating `Agent::ALL` lowercase strings (`agent.rs:20`) + labels so the LLM picks an
   agent per ticket, (c) the exact output schema `{"subtasks":[{"role","agent","prompt"}],"edges":[{"fromRole","toRole"}]}`,
   (d) constraints: unique roles, a **DAG** (no cycles), ≤ `MAX_SUBTASKS`, edges = "producer → consumer" handoff.
2. **Run:** `tokio::process::Command::new(&config.binary).args(["-p", &prompt, "--output-format","json",
   "--permission-mode","plan"]).current_dir(repo_dir)` with captured stdout/stderr, wrapped in
   `tokio::time::timeout(config.timeout, …)`. Non-zero exit / spawn failure (binary missing) → `PlannerError::Spawn(stderr)`;
   elapsed → `PlannerError::Timeout`.
3. **Extract (two-layer, C-CORR-C):** parse the claude JSON envelope, take `.result`; from that text extract the
   plan JSON via a robust fenced-JSON finder (first ```json…``` block, else first balanced `{…}`); `serde_json`
   into `{ subtasks: Vec<SubtaskInput>, edges: Vec<EdgeInput> }`. Parse failure → `PlannerError::Malformed`.
4. **Validate:** call the hardened `validate_decomposition(&subtasks, &edges)` (BE-1). Failure → `PlannerError::Invalid`.
5. **One retry:** wrap 2–4 so a `Malformed` **or** `Invalid` result retries **once**; second failure returns the
   error (the FE falls back to manual editing).

**Agent-field leniency (D-OQ3, recommended default):** deserialize a ticket's `agent` **leniently** — unknown/
missing → `Agent::default()` (Claude), because the agent is user-editable in the review surface. Keep edge
**role** references strict (structural). Implement via a small `#[serde(default)]`/custom-deser wrapper in the
planner's internal parse struct, mapping to `SubtaskInput` before validation.

**Acceptance criteria:**
- **Given** the stub `claude` echoes a valid 4-ticket/3-edge plan, **When** `plan()` runs, **Then** it returns
  those 4 `SubtaskInput` + 3 `EdgeInput`, parsed from the envelope+fence.
- **Given** the stub returns malformed JSON twice, **Then** `PlannerError::Malformed` after exactly one retry.
- **Given** the stub returns a **cyclic** plan twice, **Then** `PlannerError::Invalid` (validator rejected it).
- **Given** the stub sleeps past the timeout, **Then** `PlannerError::Timeout`.
- **Given** `PHASR_CLAUDE_BIN` points at a nonexistent binary, **Then** `PlannerError::Spawn`.
- **Given** a ticket names an unknown agent, **Then** it parses with `agent = claude` (leniency) and validates.
**Tests (cargo):** JSON-extraction unit tests (raw / fenced / enveloped); the five scenarios above driven by
env-overridable stub scripts (written to a tempdir, `PHASR_CLAUDE_BIN` set per-test — the new pattern from C-CORR-A).
**Effort:** Medium.

### Story BE-3 — The command (`commands/planner.rs`, new) + registration
**As** the FE, **I want** a `plan_decomposition(repositoryId, goal)` IPC that returns a `ProposedPlan` and
persists nothing, **so that** "Decompose" produces an editable draft.

**Files:** new `commands/planner.rs`; `commands/mod.rs` (`pub mod planner;`); `lib.rs` invoke_handler (add
`commands::planner::plan_decomposition` beside `board::*`, `lib.rs:164-167`).
**Tasks:** require session (`session.require()`), reject `goal.trim().is_empty()` → `EmptyGoal`, resolve the
repository's `local_path` (owner context) → `NoRepoPath` if absent, call `planner::plan(repo_dir, &goal,
&PlannerConfig::default())`, map to `ProposedPlan { subtasks, edges }`. **No store write.**
**Acceptance criteria:**
- **Given** a valid repo + goal, **Then** returns a `ProposedPlan`; a follow-up `list_by_repository_for_user`
  shows **no** new rows (persists nothing).
- **Given** an empty goal, **Then** `EmptyGoal` (backend guard behind the FE's disabled button).
- **Given** an unsigned session, **Then** `Auth(NotSignedIn)`.
**Tests (cargo):** `plan_decomposition_persists_nothing` (stub claude, assert zero new workspace rows);
`plan_decomposition_rejects_empty_goal`.
**Effort:** Small.

---

## E. Phase 1 — frontend story (owner: fe-developer, follows the frozen contract) — build to mockup Page 02

### Story FE-1 — Rewrite `DecomposeForm` into the Planner review/edit surface
**As** a user starting an epic, **I want** to type one goal, watch the planner propose N tickets + a dependency
graph, edit anything (persona/role, agent-type, prompt, edges), and start them all at once, **so that** I get a
real multi-agent plan without hand-building it — and nothing runs until I approve.

**Build to:** `scratchpad/phasr-factory-pages.html` **Page 02** — Goal input → "Planner proposed N tickets ·
Re-plan" → N `tickrow`s (`grip` · persona chip · agent `sel` · "runs first · no deps"/"waits for X" hint ·
prompt · ✕) → "Add ticket" → a **Dependencies** `dag` box (edges `persona → persona` + note, "Add edge") →
footer "Nothing is created until you start. K handoff contracts." + Cancel + **"Start N agents"**.

**Files:** `src/components/DecomposeForm.tsx` (rewrite), `DecomposeModal.tsx` (copy: title/description →
"Split one goal into agents…"; drop the "two agents — a backend and a frontend" wording), `design-test.tsx`
(harness states). Reuse `GlassSelect` (`ui/GlassSelect.tsx`), `GlassInput`/`GlassTextarea`, `GlassButton`,
`humanizeError` (`lib/humanizeError.ts`), `list_agents` via `tauri.listAgents()` (`tauri.ts:187`).

**State model (a `useReducer`):** a draft of `tickets: { id, role, agent, prompt }[]` keyed by an internal
**stable client id**, and `edges: { fromId, toId }[]` referencing those client ids. Roles/agents/prompts are
editable; **edges reference client ids internally** and are projected to `{ fromRole, toRole }` only at submit
(D-OQ7) — so renaming or removing a ticket can never silently break an edge. Phases:
`idle → planning → review → (submitting)`; a `plannerFailed` flag routes to a manual-editing seed.

**Flow:**
1. **Goal** input (existing `decompose-goal`). "Decompose" primary is disabled while empty.
2. Click **Decompose** → `phase="planning"`, show the spinner "Planning…" (mockup's `.planning` row). Call
   `tauri.planDecomposition(repoId, goal)`.
3. **Success** → `phase="review"`, hydrate tickets+edges from `ProposedPlan`; header shows "Planner proposed N
   tickets · **Re-plan**" (Re-plan re-runs step 2, D-OQ6: discard-and-rerun, confirm if the draft was edited).
4. **Review/edit:** per ticket — a neutral **persona/role chip** (editable label, must stay unique), an
   **agent** `GlassSelect` populated from `list_agents` (options = `AgentOption.label`, value = `agent`), a
   **prompt** `GlassTextarea`, a **remove** (✕). "**Add ticket**" appends a blank row (role `"role-N"`, agent =
   default). The **Dependencies** box lists edges (two role `GlassSelect`s `from → to`) with remove + "**Add
   edge**". A derived per-ticket hint ("runs first · no deps" / "waits for X").
5. **Client-side validation** mirrors BE-1: unique non-empty roles, no self-edge, no unknown-role edge, **no
   cycle** (client Kahn), ≤ `MAX_SUBTASKS`. "**Start N agents**" is disabled-**with-reason** (never hidden)
   when invalid; the footer shows the handoff-contract count (= number of edges).
6. **Start N agents** → build `DecompositionInput { repositoryId, parentPrompt: goal, subtasks: tickets.map(
   {role,agent,prompt}), edges: edges.map→{fromRole,toRole} }` → `tauri.startDecomposition` (the **unchanged**
   gate) → existing `onStarted` → navigate to the board (`DecomposeModal.tsx:52-57`). Preserve the D1 in-flight
   `inFlightRef` guard (double-submit defense) verbatim from the current form.
7. **Planner failure** (reject) → toast via `humanizeError` + **fall back to manual editing**: seed one blank
   ticket row so the user can build the plan by hand and still Start. Never a dead end.

**Acceptance criteria (Given/When/Then):**
- **Given** an empty goal, **Then** "Decompose" is disabled.
- **Given** a goal + a successful plan of N tickets/M edges, **When** the plan returns, **Then** N editable
  ticket rows + M edges render matching Page 02; each agent `GlassSelect` lists the `list_agents` options.
- **Given** a proposed plan, **When** the user edits a prompt, changes an agent, removes a ticket, and adds an
  edge, **Then** the draft updates and **no** IPC fires (nothing persists pre-Start).
- **Given** an edited valid draft, **When** "Start N agents" is clicked once, **Then** `start_decomposition`
  fires **exactly once** with the edited subtasks/edges and the goal as `parentPrompt`, and the app navigates to
  the new board.
- **Given** the user creates a cycle (or exceeds the cap, or an empty role), **Then** "Start N agents" is
  disabled with a legible reason; the client never submits an invalid plan.
- **Given** the planner rejects/times out/returns garbage, **Then** a `humanizeError` toast shows and the form
  drops into manual editing (one seed row) — the user can still build + Start a plan.
- **Given** a double-click on "Start N agents", **Then** the gate fires at most once (`inFlightRef`).
- Renaming a ticket's role updates any edge that referenced it (client-id indirection) — no orphaned edge.

**Effort:** Medium. **Depends on:** the frozen contract (§C) — can start against the types while BE-2/BE-3 are
in flight (the e2e harness mocks `plan_decomposition`).

---

## F. Edge & error cases (every one has an honest UI response — never a dead end)

| Case | Backend | Frontend response |
|---|---|---|
| Empty goal | `EmptyGoal` (guard) | "Decompose" disabled; no call fired |
| Planner binary not installed | `PlannerError::Spawn` | toast (`humanizeError`) → manual-editing fallback |
| Planner times out | `PlannerError::Timeout` | toast "The planner took too long — edit the plan by hand." → manual fallback |
| Planner returns garbage (twice) | `PlannerError::Malformed` | toast → manual fallback |
| Planner returns a cyclic / over-cap plan (twice) | `PlannerError::Invalid` | toast → manual fallback |
| User builds a cyclic / over-cap / dup-role / self-edge / unknown-role plan | gate rejects (BE-1, belt) | client validation disables Start **with reason** *before* submit |
| An assigned agent's CLI isn't installed | not the planner's concern | ticket still starts (scheduler owns spawn); the agent row shows honest **Failed/Wedged** status on the board (Step 0 substrate) — surfaced there, not blocked here (D-OQ8) |
| Double-submit of Start | server dedup mints a fresh parent (`re_decompose_mints_a_fresh_independent_parent`, `board.rs:882`) | `inFlightRef` guard fires the gate once |
| Re-plan with unsaved edits | n/a | confirm-then-discard (D-OQ6) |

---

## G. Test plan (run the FULL suite each time — a scoped run hid a regression this session)

**cargo (`src-tauri`):**
- BE-1: cycle-rejection (2-node, multi-hop), over-cap, valid-DAG regression.
- BE-2: JSON extraction (raw/fenced/enveloped); stubbed env-overridable `claude` for success / malformed→retry
  / cyclic→invalid / timeout / spawn-failure; agent-field leniency.
- BE-3: `plan_decomposition_persists_nothing`, `plan_decomposition_rejects_empty_goal`.
- P0-1: `diff_branch_range` over two merged branches returns both files.

**vitest (`pnpm test`):** the `DecomposeForm` reducer (add/remove ticket, add/remove edge, role-rename cascade);
client DAG validation (cycle/cap/self-edge/unknown-role → Start disabled); planner-reject → manual-fallback.

**Playwright (`e2e/`, mocked IPC — extend `board.spec.ts` or add `planner.spec.ts`):** goal → Decompose (mock
`plan_decomposition` → 4 tickets/3 edges) → review renders N rows + edges + agent selects (mock `list_agents`)
→ edit prompt/agent + remove a ticket + add an edge → **Start N** fires `start_decomposition` **once** with the
edited plan → navigates to board. Plus the planner-failure path (mock reject → manual fallback → Start still
works) and the P0-1 clean-integration non-empty diff. **Caveat (testing-blind-spots):** the mocked-IPC harness
proves the flow *fires the right command with the right shape* but cannot catch a real `claude` producing bad
JSON or a bad plan — the **manual smoke** below is the real gate.

**Manual smoke (the real gate):** goal → Decompose (real `claude`) → review/edit → Start → agents run → Validate
→ Integrate → the P0-1 combined diff is non-empty → merge to main.

---

## H. Build sequence

1. **P0-1 empty-combined-diff fix** — *lands alongside*, independent (tauri-engineer B.1–B.2 → fe-developer B.3). Small.
2. **Freeze the contract (§C)** — add `Serialize` to `SubtaskInput`/`EdgeInput`; author `ProposedPlan` +
   `plan_decomposition` types in `types.ts`/`tauri.ts`. Unblocks the FE to build against mocks in parallel.
3. **Backend planner stream (tauri-engineer, sequential):** **BE-1** (harden the shared validator — ships value
   immediately, closes the cycle gap) → **BE-2** (`orchestrator/planner.rs` + stub tests) → **BE-3**
   (`commands/planner.rs` + register).
4. **Frontend (fe-developer), against the frozen contract:** **FE-1** (rewrite `DecomposeForm` to Page 02) →
   `DecomposeModal` copy + `design-test` states + e2e.

Streams 3 and 4 run in parallel after step 2; BE-1 can even precede the planner (pure hardening).

---

## I. Explicitly deferred to Phase 2+ (keep this milestone tight)

- **Rich tickets / versioned briefs** (`.phasr/tickets/<id>/{ticket.md,prd.md,trd.md,assets,figma.json}`), the
  **Brief tab**, attachment upload, Figma links, comments — Phase 2. The planner drafting `prd.md`/`trd.md`
  onto each ticket needs docs-as-files first; Phase 1 tickets carry only `{role, agent, prompt}`.
- **First-class persona taxonomy + per-persona default agent** — Phase 1 treats **role = persona label**
  (free-text chip). BSA/Architect/Dev/QAS/POPM as first-class personas is D-OQ9 → Phase 4 (SAW fork).
- **Worklist home + repo-level board index** — a separate design-build track (roadmap UX section); not required
  for the planner milestone.
- **Drag-to-reorder tickets** — Page 02 shows a `grip` ⠿, but order is **derived from the DAG**, not manual;
  reorder is cosmetic → defer.
- **Persona chip color / agent-type mark on board cards** (Page 03) — board-card polish, not the planner.
- **Smart Re-plan that merges edits** — v1 Re-plan is discard-and-rerun.
- **The `phasr` agent CLI / command layer / Review lane / QAS gate** — Phase 3.

---

## J. Open decisions (recommended defaults — not blocking)

| # | Decision | Recommended default |
|---|---|---|
| D-OQ1 | `MAX_SUBTASKS` cap | **12** — a sane board size; rejects runaway plans. Edges are implicitly bounded by roles. |
| D-OQ2 | Planner timeout | **90s** — codebase inspection + generation; env-tunable via `PlannerConfig`. |
| D-OQ3 | LLM emits unknown/missing agent | **Tolerate → default to Claude** (agent is user-editable). Keep edge **roles** strict. |
| D-OQ4 | Retry scope | **Retry once on {Malformed OR Invalid}**; second failure → error → FE manual fallback. |
| D-OQ5 | Planner binary | **Always `claude`** (env `PHASR_CLAUDE_BIN` for tests). The planner itself is Claude even when it assigns codex/gemini to tickets. Not per-user configurable in v1. |
| D-OQ6 | Re-plan with edits | **Discard-and-rerun**, confirm if the draft was edited. |
| D-OQ7 | Role rename cascade | **Internal stable client ids**; project to `{fromRole,toRole}` at submit — edges never break on rename. |
| D-OQ8 | Assigned-agent CLI missing | **Not the planner's job** — surfaces as honest Failed/Wedged on the board (Step 0), where Restart lives. |
| D-OQ9 | User-facing vocabulary | Modal reads **"New epic" / "N tickets" / "Start N agents"** (matches Page 02); keep `parent`/`subtask` internal. Full sidebar/breadcrumb rename (Epic→Ticket, plan OQ#8) deferred to the vocabulary-lock pass. |
| D-OQ10 | `--permission-mode plan` | **Yes** — the planner is read-only; it must never mutate the repo while inspecting it. |

---

## K. Definition of done

- P0-1: clean integration shows a non-empty combined diff; conflict path unchanged; cargo + Playwright green.
- BE-1: the shared validator rejects cycles + over-cap; the cycle-rejection test (the claim #1 gap) is green;
  P0 gate/scheduler/integrate regressions pass.
- BE-2/BE-3: `plan_decomposition` returns a validated `ProposedPlan`, persists nothing, handles
  spawn/timeout/malformed/invalid honestly; stub-`claude` cargo tests green.
- FE-1: `DecomposeForm` matches mockup Page 02 — planner draft → edit tickets/agents/DAG → "Start N agents"
  fires the unchanged gate once → board; planner failure → manual fallback; client validation blocks invalid
  plans with a reason; vitest + Playwright green.
- Full `cargo test` + `pnpm typecheck` + `pnpm test` + Playwright suite green; manual smoke (real `claude`)
  completes goal → board → integrate → non-empty diff.
