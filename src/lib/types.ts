// Mirrors the Rust domain types (src-tauri/src/domain/*) with the
// camelCase shape they serialize to. Keep these in lockstep.

export type WorkspaceStatus =
  | "pending"
  | "running"
  | "stopped"
  | "completed"
  | "failed"
  | "archived";

export interface Repository {
  id: string;
  name: string;
  remoteUrl: string | null;
  localPath: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

/** The fixed set of built-in agents. Matches `domain::agent::Agent`. */
export type Agent = "claude" | "codex" | "copilot" | "gemini" | "opencode";

export interface Workspace {
  id: string;
  repositoryId: string;
  /**
   * `agent`/`local` are the standalone single-task kinds. `parent`/`subtask`
   * are the multi-agent task-board kinds (P0 slice): a `parent` is the
   * decomposition container (no PTY until integration), a `subtask` is a real
   * agent tied to a `parentId` + `role`. Mirrors the Rust `WorkspaceKind`
   * enum (`domain/workspace.rs`). Progressive disclosure: `parent`/`subtask`
   * rows never appear in the flat sidebar list — the board is their home.
   */
  workspaceKind: "agent" | "local" | "parent" | "subtask";
  name: string;
  prompt: string | null;
  agent: Agent | null;
  command: string;
  status: WorkspaceStatus;
  branch: string | null;
  worktreePath: string | null;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  /**
   * Set only when this `running` row was orphaned by an app relaunch and
   * swept to `stopped` during startup recovery (`lib.rs::recover_startup_state`).
   * Mirrors the machine-local `interrupted_at` column (never synced). The
   * frontend derives the honest "was interrupted" state from
   * `status === "stopped" && interruptedAt != null` — a calm user `stop_task`
   * leaves this `null`. ISO-8601 UTC. (Step 0 — Honest Status, E0.)
   */
  interruptedAt: string | null;
  /**
   * Multi-agent board linkage (P0 slice). `null` for standalone `agent`/`local`
   * workspaces. Set on a `subtask` row to its owning `parent` workspace id;
   * `null` on the parent itself. Mirrors the additive `parent_id` column
   * (migration 0013).
   */
  parentId: string | null;
  /**
   * The subtask's DAG slot (e.g. `"backend"` / `"frontend"`). `null` for
   * `agent`/`local`/`parent`. The subtask dedup key is `(parentId, role)`,
   * never `name`. Mirrors the additive `role` column (migration 0013).
   */
  role: string | null;
  /**
   * Autopilot per-epic toggle (Phase 5a). Meaningful ONLY on a `parent` (epic)
   * row: when `true` the driver auto-advances that epic's gate ladder. LOCAL-ONLY
   * (mirrors the additive `autopilot_enabled` column, migration 0015 — board rows
   * are never synced). Defaults `false` (opt-in per epic). The FE threads this
   * into `worklistBucket`/`deriveNextGate` so autopilot-owned tickets group under
   * "Autopilot driving" instead of masquerading as coral "Needs you".
   */
  autopilotEnabled: boolean;
  updatedAt: string;
}

/** One built-in agent as returned by `list_agents`. */
export interface AgentOption {
  agent: Agent;
  label: string;
  command: string;
  isDefault: boolean;
}

export interface UserSettings {
  theme: string;
  accentColor: string;
  sansFont: string;
  monoFont: string;
  baseFontSize: number;
  cursorStyle: string;
  cursorBlink: boolean;
  terminalScrollback: number;
  defaultEditor: string;
  defaultTerminal: string;
  keyboardShortcuts: string;
  branchPrefixTemplate: string;
  worktreeBasePath: string;
  defaultMergeStrategy: string;
  autoFetchSeconds: number;
  honorGpgSign: boolean;
  autoPushOnCommit: boolean;
  updatedAt: string;
}

export type PtyEvent =
  | { type: "output"; taskId: string; chunk: string }
  | { type: "exit"; taskId: string; exitCode: number | null };

/**
 * Result of `start_task` — orchestrator-side vocabulary uses "task" but
 * the persisted row is still in the `workspaces` table (renamed from
 * `tasks` in migration 0002).
 */
export interface StartedTask {
  taskId: string;
  workspace: Workspace;
}

export interface RunningTaskInfo {
  taskId: string;
  startedAt: string;
}

/**
 * The honest, *derived* runtime state of an agent, as emitted by the Rust
 * liveness poller and exit-watcher over `phasr://task-status`. Mirrors
 * `orchestrator::liveness::DerivedState` (serde `kebab-case`; every variant is
 * a single word so it renders lowercase). Verified against the Rust source:
 * `src-tauri/src/orchestrator/liveness.rs` (`DerivedState::as_str`) and
 * `src-tauri/src/commands/orchestrator.rs` (`TaskStatusPayload::derived_state`).
 *
 * - `working` / `idle` / `wedged` — liveness poller, from output recency.
 * - `done` / `failed` — exit-watcher, from the PTY exit code.
 *
 * NOTE (product decision — honest-neutral): a quiet agent is a neutral `idle`
 * that escalates to `wedged`; there is deliberately no coral "needs-attention"
 * variant at P0 (the plan's §B `needs-attention` was superseded — see
 * `liveness.rs` module doc). The frontend adds its own UI-only buckets
 * (`resolving`, `interrupted`, `stopped`) in `deriveAgentState` — those are
 * NEVER on the wire.
 */
export type DerivedAgentState =
  | "working"
  | "idle"
  | "wedged"
  | "done"
  | "failed";

/**
 * Payload broadcast on `phasr://task-status` whenever the orchestrator
 * transitions a task between lifecycle states.
 *
 * `derivedState` + `lastActivityAt` are additive (both `null` on plain
 * lifecycle transitions), so existing consumers keying off `status` are
 * unaffected (Step 0 — Honest Status, E0 / S0.1).
 */
export interface TaskStatusPayload {
  taskId: string;
  repositoryId: string;
  status: WorkspaceStatus;
  exitCode: number | null;
  /**
   * Honest derived state. `working | idle | wedged` on liveness-poller
   * transitions, `done | failed` on the exit-watcher, `null` on plain
   * lifecycle transitions (pending→running, →stopped).
   */
  derivedState: DerivedAgentState | null;
  /**
   * ISO-8601 UTC timestamp of the agent's last output, carried on poller
   * transitions so the frontend can count "Ns ago" upward locally between
   * events. `null` on exit-watcher / plain lifecycle events.
   */
  lastActivityAt: string | null;
}

export interface PathValidation {
  path: string;
  absolutePath: string | null;
  exists: boolean;
  isDir: boolean;
  isGitRepo: boolean;
  message: string | null;
}

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "other";

export interface FileChange {
  path: string;
  oldPath: string | null;
  staged: FileStatus;
  unstaged: FileStatus;
  /**
   * Lines added for this path (working-tree + index numstat, summed).
   * `null` for binary files and untracked files — the backend has no
   * numstat entry for those. Lets a collapsed diff card draw its +N/-N
   * badge without fetching the file's full diff.
   */
  adds: number | null;
  /** Lines removed for this path (see `adds`). */
  removes: number | null;
}

export type DiffScope = "Unstaged" | "Staged" | "Head";

export interface RunCommand {
  id: string;
  repositoryId: string;
  name: string;
  command: string;
  shortcut: string | null;
  pinned: boolean;
  /**
   * Opt-in flag (Phase 3 §A4 / C.1): this command is a Validate CHECK — run as a
   * captured, non-interactive subprocess in the ticket's worktree with a
   * pass/fail exit code, NOT the interactive dev-server PTY. Default `false`
   * (running every pinned command would hang on a dev server). ≥1 command with
   * this flag set means Validate is available for the repo's tickets.
   */
  runInValidate: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommitOutput {
  sha: string;
  message: string;
}

export interface BranchStatus {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasRemote: boolean;
  detached: boolean;
  /**
   * The resolved ref the workspace branch is compared against for
   * merge-target purposes. Prefers `origin/<defaultBranch>` when a
   * remote exists, otherwise the local default branch. `null` when
   * the workspace is on the default branch itself.
   */
  targetRef: string | null;
  /** Commits on this branch not reachable from `targetRef`. */
  aheadOfTarget: number;
  /** Commits on `targetRef` not reachable from this branch. */
  behindOfTarget: number;
}

export type MergeStrategy = "merge" | "squash" | "fastForward" | "rebase";

export type MergeOutcome =
  | { kind: "clean"; message: string }
  | { kind: "conflicts"; files: string[] };

export type InProgress =
  | { kind: "none" }
  | { kind: "merge"; conflicts: string[] }
  | { kind: "rebase"; conflicts: string[] };

export type ConflictSide = "ours" | "theirs";

export interface Commit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string | null;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  parents: string[];
}

export interface LogOptions {
  branchOnly: boolean;
  limit?: number;
  skip?: number;
  messageGrep?: string;
  defaultBranch?: string;
}

export interface CommitFileChange {
  path: string;
  oldPath: string | null;
  status: FileStatus;
}

export interface OpenPullRequestOutcome {
  url: string;
  provider: string;
  headBranch: string;
  baseBranch: string;
}

export interface GitPushOutcome {
  branch: string;
  /** Best-effort "create PR/MR" link, or null for unknown remotes. */
  pullRequestUrl: string | null;
  provider: string | null;
}

export interface WorkspaceDeleteCheck {
  hasUnpushedCommits: boolean;
}

export type LauncherKind = "editor" | "terminal" | "filemanager";

export interface Launcher {
  id: string;
  name: string;
  kind: LauncherKind;
  available: boolean;
}

// ── multi-agent task board (P0 slice) ──────────────────────────────────────
// Mirrors the FROZEN Rust ↔ TS wire contract (§C): `commands/board.rs`
// (`DecompositionInput`/`BoardState`) + `domain/{dependency,contract}.rs`
// (both `#[serde(rename_all = "camelCase")]`). Board/DAG state stays OUT of
// `WorkspaceStatus` — "blocked"/"needs-review" are frontend-DERIVED buckets,
// never stored (spec claim #10).

/**
 * A directed edge in a parent's DAG, addressed by concrete subtask ids. The
 * PoC persists exactly one: `backend → frontend`. `fromSubtaskId` is the
 * producer (whose published contract unblocks the consumer `toSubtaskId`).
 */
export interface WorkspaceDependency {
  id: string;
  parentId: string;
  fromSubtaskId: string;
  toSubtaskId: string;
  createdAt: string;
}

/**
 * A subtask's published handoff contract. `publishedAt != null` is the
 * file→DB bridge that satisfies a downstream edge — it drives the frontend
 * "blocked" derivation. `null` while a row exists but the contract isn't
 * published yet.
 */
export interface WorkspaceContract {
  id: string;
  parentId: string;
  subtaskId: string;
  role: string;
  contractPath: string;
  publishedAt: string | null;
  createdAt: string;
}

/** Everything the board route renders — the response of both board commands. */
export interface BoardState {
  /** `workspaceKind:"parent"`, `status:"pending"` until integration. */
  parent: Workspace;
  /** `workspaceKind:"subtask"`, each with `parentId` + `role` set. */
  subtasks: Workspace[];
  dependencies: WorkspaceDependency[];
  contracts: WorkspaceContract[];
}

/** One planned subtask in a decomposition draft (frontend-only until approval). */
export interface SubtaskInput {
  role: string;
  agent: Agent;
  prompt: string;
}

/** One planned edge in a decomposition draft, addressed by role. */
export interface EdgeInput {
  fromRole: string;
  toRole: string;
}

/**
 * One epic-wide Figma link on the decomposition wire (Phase 2b). Only `url` +
 * optional `label` are supplied by the FE; the `id`/`addedBy`/`addedAt` are
 * minted server-side when the gate appends it to the epic's `figma.json`.
 * Mirrors the Rust `FigmaLinkInput` (`commands/board.rs`, camelCase).
 */
export interface FigmaLinkInput {
  url: string;
  label?: string | null;
}

/**
 * The approved decomposition plan submitted by the "Start N agents" gate. The
 * draft lives entirely in the frontend form until the user clicks — nothing is
 * persisted before `startDecomposition` fires (B2).
 *
 * Phase 2b adds the optional EPIC-brief fields: the shared PRD/TRD/Figma/assets
 * for the WHOLE epic, written to `<repo>/.phasr/epics/<parentId>/` at the gate
 * (before any subtask spawns) and inherited by every task's spawn prompt (E4).
 * All optional — omit them for a doc-less epic (a pre-2b caller is unchanged).
 * The "Workflow brief" review-step panel (E2) populates them.
 */
export interface DecompositionInput {
  repositoryId: string;
  parentPrompt: string;
  subtasks: SubtaskInput[];
  edges: EdgeInput[];
  /** Epic PRD markdown (written to `prd.md` when non-empty). */
  epicPrd?: string | null;
  /** Epic TRD markdown (written to `trd.md` when non-empty). */
  epicTrd?: string | null;
  /** Epic-wide Figma links (validated + appended to `figma.json`). */
  epicFigma?: FigmaLinkInput[];
  /** Absolute source paths of staged assets, copied into the epic `assets/`. */
  epicAssetPaths?: string[];
}

/**
 * The planner's proposed decomposition — `DecompositionInput` minus
 * `repositoryId`/`parentPrompt` (the FROZEN §C contract). Returned by
 * `plan_decomposition`; persists NOTHING. The Planner review surface hydrates
 * its editable draft from this, then submits the (possibly edited) plan through
 * the unchanged `startDecomposition` gate. Mirrors the Rust `ProposedPlan`
 * (`commands/planner.rs`, `#[serde(rename_all = "camelCase")]`).
 */
export interface ProposedPlan {
  subtasks: SubtaskInput[];
  edges: EdgeInput[];
}

// ── Worklist / Home (Phase 2 — the cross-repo attention home) ───────────────
// Mirrors the FROZEN §C.3 wire contract (`commands/worklist.rs` → `WorklistState`).
// `list_worklist()` does the cross-repo JOIN once (repos × boards × loose agents)
// and computes NO state — the frontend derives every bucket in one place
// (`deriveWorklist.ts::worklistBucket`), identical to how the board derives lanes
// (spec §A4). All user-scoped server-side; a different account never sees another's.

/** A repository trimmed to what the worklist needs — filter chips + name labels. */
export interface RepoBrief {
  id: string;
  name: string;
}

/**
 * A subtask's review decision, trimmed to what the worklist derivation needs to
 * move a lane HONESTLY (M4): the `state` + when it landed. Mirrors the trimmed
 * Rust `SubtaskReview` (`commands/worklist.rs`) — the same kebab-case
 * {@link ReviewState} + camelCase `atMs` as a full {@link ReviewRecord}, minus the
 * `by`/`comment`/`validatePassed` the lane derivation never reads.
 */
export interface SubtaskReview {
  state: ReviewState;
  atMs: number;
}

/**
 * A worklist subtask = the {@link Workspace} (its fields are flattened onto the
 * wire, so it stays a drop-in for `deriveBoardState`) PLUS its `review` decision
 * (M4). `review` is `null` until the ticket enters the review gate. This is what
 * lets the worklist's `deriveBoardState` tell "awaiting YOUR review" apart from a
 * bounced (`changes-requested`) ticket the agent must rework.
 *
 * `review` is marked OPTIONAL (not just `| null`) so a plain `Workspace`/
 * `BoardState`-shaped value still satisfies this type — the Rust wire always
 * sends the key (`null` when the ticket never entered the review gate), so a
 * reader treats absent and `null` identically. The FE follow-up threads
 * `subtask.review` into `deriveBoardState` as the honest lane signal.
 */
export interface WorklistSubtask extends Workspace {
  review?: SubtaskReview | null;
}

/**
 * One epic's board as the worklist renders it — the {@link BoardState} shape, but
 * each subtask carries its `review` inline (M4). A worklist-LOCAL type (not
 * `BoardState`) precisely because the review side-load rides on each subtask
 * here; the board route reads reviews separately via `getBoardGates`.
 */
export interface WorklistBoard {
  parent: Workspace;
  subtasks: WorklistSubtask[];
  dependencies: WorkspaceDependency[];
  contracts: WorkspaceContract[];
}

/** Everything the worklist buckets: every repo, every epic board, and loose agents. */
export interface WorklistState {
  /** For the filter chips + repo-name labels on each row. */
  repositories: RepoBrief[];
  /**
   * Every epic (`parent`) for the signed-in user, cross-repo, WITH
   * subtasks/deps/contracts — plus each subtask's `review` decision (M4), so the
   * FE's `deriveBoardState` renders the honest lane (a bounced ticket is re-work,
   * not "ready for you").
   */
  boards: WorklistBoard[];
  /** `agent`/`local` workspaces NOT part of any decomposition (single-agent work). */
  looseAgents: Workspace[];
}

// ── Rich tickets / versioned brief (Phase 2 — the Brief tab) ────────────────
// Mirrors the FROZEN §C.1 wire contract (`commands/tickets.rs`). The brief lives
// in the managed repo at `<repo>/.phasr/tickets/<ticketId>/` (git-versioned);
// `ticketId == subtask workspace id` (§D2). Field names are camelCase on the wire.
//
// Honesty invariant (Architect Stage-1 #1): the agent is READ-ONLY on the brief
// in Phase 2 (agent writes are Phase 3, via the `phasr` CLI). Every FE-visible
// edit is attributed to `"you"` or left NEUTRAL (`null`) — the frontend NEVER
// renders authorship as `"agent"`. The `"agent"` union member is kept only to
// match the frozen wire type for the Phase-3 forward hook.

/** The three editable brief sections (§B section↔file map). */
export type BriefSection = "description" | "prd" | "trd";

/** One brief section's content + optimistic-concurrency + authorship sidecar. */
export interface BriefSectionContent {
  /** Raw markdown (`""` when the on-disk file is missing — an empty section, never an error). */
  content: string;
  /** On-disk mtime for optimistic concurrency; the base a save is checked against. */
  mtimeMs: number | null;
  /**
   * Who last edited this section, from the local `.meta.json` sidecar. Phase 2:
   * `"you"` or `null` (neutral) only — the FE never renders `"agent"` (Architect #1).
   */
  lastEditedBy: "you" | "agent" | null;
  lastEditedAtMs: number | null;
}

/** The whole ticket brief — every section + attachments (§C.1). */
export interface TicketBrief {
  ticketId: string;
  /** H1 of `ticket.md` (falls back to the workspace name). */
  title: string;
  description: BriefSectionContent;
  prd: BriefSectionContent;
  trd: BriefSectionContent;
  assets: TicketAsset[];
  figma: FigmaLink[];
  commentCount: number;
}

/**
 * Result of `write_ticket_section`. `saved` returns the freshly-written section
 * (its new `mtimeMs` becomes the next optimistic base); `conflict` means the
 * `baseMtimeMs` was stale — the FE shows Reload (take `onDisk`) / Keep-mine
 * (re-save against `onDisk.mtimeMs`) and NOTHING was overwritten.
 */
export type WriteSectionResult =
  | { kind: "saved"; section: BriefSectionContent }
  | { kind: "conflict"; onDisk: BriefSectionContent };

/** An attachment on a ticket — an in-repo copy or an app-data large binary (§B). */
export interface TicketAsset {
  /** Stable id (sanitised filename). */
  id: string;
  name: string;
  storage: "in-repo" | "app-data";
  /** Absolute, resolvable path (`convertFileSrc` for image preview). */
  path: string;
  sizeBytes: number;
  kind: "image" | "pdf" | "binary";
  addedAtMs: number;
}

/** A linked Figma file (link-only v1 — URL + label + placeholder thumb, §B). */
export interface FigmaLink {
  id: string;
  url: string;
  label: string | null;
  addedBy: "you" | "agent";
  addedAtMs: number;
}

/** One thread comment (human or — Phase 3 — agent, read-only in Phase 2). */
export interface TicketComment {
  id: string;
  /** Display name (signed-in user or agent label). */
  author: string;
  authorKind: "you" | "agent";
  /** Persona/role for agent comments; `null` for human comments. */
  role: string | null;
  body: string;
  createdAtMs: number;
}

/** Payload of `phasr://ticket-changed` — which sections changed on disk (§C.1 / F4). */
export interface TicketChangedPayload {
  ticketId: string;
  sections: BriefSection[];
}

// ── Phase 3 — the command layer + QAS gates (§C.1/§C.2) ─────────────────────
// Mirrors the FROZEN Rust ↔ TS wire contract for the two new gates (Validate,
// Review). Both gate records live as files in the ticket folder
// (`validate.json` / `review.json`, §D7 docs-as-files) and are read alongside
// the board via a single `get_board_gates(parentId)` batch (§J8). The lane
// derivation stays DERIVED — `WorkspaceStatus` is never touched (invariant #10).

/** One check inside a Validate run (a captured `RunCommand` subprocess). */
export interface ValidateCheck {
  name: string;
  command: string;
  passed: boolean;
  /** Process exit code; `null` on timeout / spawn failure. */
  exitCode: number | null;
  /** Tail of captured stdout+stderr, for the "expand to output" affordance. */
  tailOutput: string;
}

/**
 * The aggregate result of `validate_ticket` (also cached to `validate.json`).
 * `passed` is true iff EVERY check exited 0. A ticket with no checks configured
 * returns `{ checks: [], passed: false }` — a legible empty result, NOT an error
 * (the FE renders an "Add a check" affordance, never a dead end).
 */
export interface ValidateResult {
  subtaskId: string;
  checks: ValidateCheck[];
  passed: boolean;
  ranAtMs: number;
}

/** The three review states a ticket's `review.json` can hold (§A5). */
export type ReviewState = "requested" | "approved" | "changes-requested";

/**
 * A ticket's review decision (`review.json`). `state` layers over the honest
 * board state to derive the Review lane; it is NEVER a stored `WorkspaceStatus`.
 * `comment` is required for `changes-requested` (a bounce reason, also appended
 * to the comment thread). `validatePassed` snapshots the last Validate at the
 * moment review was requested.
 */
export interface ReviewRecord {
  subtaskId: string;
  state: ReviewState;
  by: string;
  comment: string | null;
  atMs: number;
  validatePassed: boolean;
}

/**
 * The batched gate side-load for a whole board (§J8): one `get_board_gates`
 * read returns every ticket's `review.json` + `validate.json`, so the board
 * renders lanes + chips in one round-trip instead of N per-ticket reads. Absent
 * entries just mean "no gate file yet" (a ticket never validated / never
 * reviewed).
 */
export interface BoardGates {
  reviews: ReviewRecord[];
  validations: ValidateResult[];
}

/** The review decision passed to `resolve_review`. */
export type ReviewDecision = "approve" | "bounce";

/**
 * Payload of the NEW `phasr://board-changed` event (Architect Stage-1 §R2): the
 * app emits this after any successful gate mutation (from a Tauri command OR the
 * `phasr` CLI IPC server) so an open board invalidates + refetches keyed on
 * `parentId`. Unlike `phasr://task-status` (keyed on a KNOWN subtask id), this
 * surfaces lane moves AND brand-new sibling tickets live.
 */
export interface BoardChangedPayload {
  parentId: string;
}

// ── Autopilot (Phase 5a, Stage A — the self-driving board) ──────────────────
// Mirrors the FROZEN wire contract (`commands/autopilot.rs`). The per-epic
// `autopilotEnabled` flag rides on `Workspace` (above); this is the GLOBAL kill
// switch the FE halted-banner reads. Board/autopilot state is LOCAL-ONLY (never
// synced).

/**
 * The global autopilot state (`get_autopilot_state`). `killSwitchHalted` is the
 * PERSISTED true-halt (§5): while set, the driver no-ops and the FE shows a
 * persistent "Autopilot halted" banner with a single explicit "Resume". There is
 * NO auto-resume. Mirrors the Rust `AutopilotState` (`#[serde(rename_all =
 * "camelCase")]`).
 */
export interface AutopilotState {
  killSwitchHalted: boolean;
}
