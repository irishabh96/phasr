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
 * The approved decomposition plan submitted by the "Start N agents" gate. The
 * draft lives entirely in the frontend form until the user clicks — nothing is
 * persisted before `startDecomposition` fires (B2).
 */
export interface DecompositionInput {
  repositoryId: string;
  parentPrompt: string;
  subtasks: SubtaskInput[];
  edges: EdgeInput[];
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

/** Everything the worklist buckets: every repo, every epic board, and loose agents. */
export interface WorklistState {
  /** For the filter chips + repo-name labels on each row. */
  repositories: RepoBrief[];
  /** Every epic (`parent`) for the signed-in user, cross-repo, WITH subtasks/deps/contracts. */
  boards: BoardState[];
  /** `agent`/`local` workspaces NOT part of any decomposition (single-agent work). */
  looseAgents: Workspace[];
}
