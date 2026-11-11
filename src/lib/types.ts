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

/**
 * How much an agent may do without asking. Matches
 * `domain::agent::PermissionMode` (serde kebab-case). Strictest first.
 */
export type PermissionMode = "ask-edits" | "ask-shell" | "skip-all";

/** How a task ended. Matches `domain::workspace::TaskOutcome` (lowercase). */
export type TaskOutcome = "merged" | "closed";

/** Where `start_task` runs the agent. Matches `orchestrator::launch::RunIn`. */
export type RunIn = "worktree" | "in-place";

export interface Workspace {
  id: string;
  repositoryId: string;
  workspaceKind: "agent" | "local";
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
  updatedAt: string;
  /**
   * Mode the agent launched (or next launches) in. `null` = a row from
   * before permission modes, which runs skip-all.
   *
   * Always sent by the backend; `?` only so pre-M4 test fixtures that
   * build a full `Workspace` still type-check. Treat `undefined` as `null`.
   */
  permissionMode?: PermissionMode | null;
  /** Always sent (default true); `?` for the same fixture reason. */
  notifyOnAttention?: boolean;
  /**
   * When the agent last finished a turn (synced across devices). `null` =
   * never / before agent signals. `?` for the same fixture reason.
   */
  lastTurnEndedAt?: string | null;
  // ── Board (M7). Always sent by the backend; `?` only so the existing
  // test fixtures that build a full `Workspace` still type-check. Treat
  // `undefined` as `null`.
  /**
   * Branch the worktree was cut from — the diff base. `null` on rows from
   * before M7 (the repository's default branch) and on in-place tasks.
   */
  baseBranch?: string | null;
  /** Set while a not-yet-started task waits in the queue. */
  queuedAt?: string | null;
  /** The queued task starts once this task reaches review / is done. */
  dependsOnWorkspaceId?: string | null;
  /** `null` = still open. */
  outcome?: TaskOutcome | null;
  outcomeAt?: string | null;
  /** Where a merged task's branch went ("merged into main"). */
  mergedInto?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  /** "open" | "draft" | "merged" | "closed" as last seen (open set). */
  prState?: string | null;
  /**
   * How the agent is shown on THIS machine (local-only, never synced).
   * `"transcript"` = Claude runs headless and the pane renders
   * `get_transcript` + `phasr://transcript`; `"terminal"` / `null` = the
   * agent's TUI in a PTY. New Claude tasks start as `"transcript"`.
   * `?` for the same fixture reason; treat `undefined` as `null`.
   */
  agentView?: AgentView | null;
}

/** `Workspace.agentView` / `set_agent_view`. */
export type AgentView = "transcript" | "terminal";

/** A background command's own lifecycle (Rust `BackgroundStatus`, lowercase). */
export type BackgroundStatus = "running" | "done" | "killed" | "failed";

/** What a subagent call is doing (Rust `SubagentInfo`). */
export interface SubagentInfo {
  /** `subagent_type`: "general-purpose", a custom agent's name. */
  type: string;
  description: string;
  /** Its tool calls so far. */
  steps: number;
  /** Its latest activity ("Reading src/a.ts"). */
  latest?: string;
  /** Tokens it has used so far (the CLI reports no cost per subagent). */
  tokens?: number;
  /** When it finished (RFC 3339); it started at the call's `ts`. */
  finishedAt?: string;
}

/**
 * Fields every transcript item may carry. `parentId` is the tool_use id of
 * the subagent call (an `Agent` tool item) the item belongs to; absent in
 * the main conversation and in transcripts persisted before subagents
 * were shown.
 */
interface TranscriptItemBase {
  id: string;
  ts: string;
  parentId?: string;
}

/**
 * One row of a transcript-view task's transcript (Rust
 * `agent_stream::TranscriptItem`). Raw CLI events never reach the UI.
 * `ts` is ISO-8601. Optional fields are omitted when absent.
 */
export type TranscriptItem =
  | (TranscriptItemBase & { kind: "user"; text: string })
  | (TranscriptItemBase & { kind: "assistant"; text: string; streaming: boolean })
  | (TranscriptItemBase & {
      kind: "thinking";
      /** The thinking's summary; empty when Claude sent none (nothing to expand). */
      text: string;
      /** Absent while the block is still open. */
      durationMs?: number;
    })
  | (TranscriptItemBase & {
      kind: "tool";
      /** The tool_use id. */
      tool: string;
      input: unknown;
      /** e.g. "Editing src/a.ts", "Running pnpm test". */
      title: string;
      /** The CALL's status: a background command's is `done` once it's launched. */
      status: "running" | "done" | "error" | "denied";
      /** The result's last ~64 KB (a background command's: its output so far). */
      output?: string;
      outputTruncated?: boolean;
      /** A command that runs on after its call returned. */
      background?: boolean;
      /** That command's own status. */
      backgroundStatus?: BackgroundStatus;
      /** A subagent call (Agent / Task): its items carry this item's id as `parentId`. */
      subagent?: SubagentInfo;
    })
  | (TranscriptItemBase & {
      kind: "result";
      durationMs: number;
      /** This turn's cost; `null` when the CLI didn't price it. */
      costUsd: number | null;
      /** A failed turn (an interrupted one is NOT an error). */
      isError: boolean;
    })
  | (TranscriptItemBase & { kind: "system"; level: "info" | "error"; text: string });

/**
 * `phasr://transcript`. Always the FULL item: `append` adds it at the end,
 * `update` replaces the item with the same `id`.
 */
export interface TranscriptEvent {
  taskId: string;
  op: "append" | "update";
  item: TranscriptItem;
}

/**
 * A reply suggestion for a transcript-view task's last turn (Rust
 * `agent_stream::Suggestion`): a composer chip. `label` is on the chip
 * (≤ 40 chars); `text` goes into the composer when it's clicked.
 * `native` = the CLI's own prediction, `generated` = Phasr's Haiku call.
 */
export interface Suggestion {
  label: string;
  text: string;
  source: "native" | "generated";
}

/**
 * `phasr://suggestions`: a task's suggestions for the turn whose `result`
 * item is `turnId` are ready (or changed). Empty = nothing to suggest.
 */
export interface SuggestionsEvent {
  taskId: string;
  turnId: string;
  suggestions: Suggestion[];
}

/** One built-in agent as returned by `list_agents`. */
export interface AgentOption {
  agent: Agent;
  label: string;
  /**
   * What a new task with this agent runs by default: the effective
   * template rendered for the user's default permission mode.
   */
  command: string;
  isDefault: boolean;
  // The fields below are always sent by `list_agents`; they're `?` only so
  // pre-M4 test fixtures that build a full `AgentOption` still type-check.
  // Tighten to required once those fixtures carry them.
  /** Built-in template, with the `{{permissions}}` placeholder. */
  defaultTemplate?: string;
  /** Effective template: the user's override, else `defaultTemplate`. */
  template?: string;
  /** Modes this agent can express, strictest first. */
  permissionModes?: PermissionMode[];
  supportsHooks?: boolean;
  usageSupported?: boolean;
}

/** Result of `<binary> --version` detection. Matches `detect::DetectionStatus`. */
export type AgentDetectionStatus = "found" | "missing" | "timeout" | "error";

/** One row of `detect_agents`. */
export interface AgentDetection {
  agent: Agent;
  binary: string;
  /** Absolute path on the user's login-shell PATH, if installed. */
  path: string | null;
  version: string | null;
  status: AgentDetectionStatus;
  installHint: string;
  detectedAt: string;
}

/** Result of `check_environment`. */
export interface EnvironmentCheck {
  git: { version: string | null };
  gh: {
    installed: boolean;
    version: string | null;
    authenticated: boolean;
    account: string | null;
  };
  /** Shell terminals and agents launch in. */
  shell: string;
  checkedAt: string;
}

/**
 * A synced setting not yet trusted on this machine (`list_unconfirmed_settings`).
 * `key`: `"agentCommands.<agent>"`, `"terminalShell"` or
 * `"defaultPermissionMode"`. `value`: exactly what would be trusted.
 */
export interface UnconfirmedSetting {
  key: string;
  value: string;
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
  /** Mode for new tasks that don't pick one. Defaults to "ask-shell". */
  defaultPermissionMode: PermissionMode;
  /** Per-agent launch template overrides (`{{permissions}}` placeholder). */
  agentCommands: Partial<Record<Agent, string>>;
  /**
   * Inbox delivery: per-kind badge/system/sound, background-only, quiet
   * hours. Omit it from an update to keep the stored value. Decided by
   * `notificationPolicy.ts::shouldDeliver`.
   */
  notificationPrefs: NotificationPrefs;
  /**
   * Shell for session terminals and task PTYs (an absolute path, e.g. from
   * `list_shells`); `""` = the account's login shell. Synced — a shell this
   * machine lacks falls back to the login shell. Omit to keep the stored value.
   */
  terminalShell: string;
  /** Copy terminal selections to the clipboard on mouse-up. */
  copyOnSelect: boolean;
  updatedAt: string;
}

export type PtyEvent =
  /**
   * `chunk` is **base64** of the PTY's raw bytes, not text — decode it with
   * `decodePtyChunk` before handing it to a terminal. A terminal is a byte
   * protocol; carrying it as a string forced a lossy UTF-8 decode that
   * destroyed non-UTF-8 output and needed a split-codepoint carry in Rust.
   */
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

/** One task's most recent terminal output, from `list_task_activity`. */
export interface TaskActivity {
  taskId: string;
  /** Wall-clock epoch ms; spawn time until the first byte arrives. */
  lastOutputAt: number;
}

/**
 * Payload broadcast on `phasr://task-status` whenever the orchestrator
 * transitions a task between lifecycle states.
 */
export interface TaskStatusPayload {
  taskId: string;
  repositoryId: string;
  status: WorkspaceStatus;
  exitCode: number | null;
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

/**
 * PascalCase on the wire (`DiffScope` in `git/diff.rs`). `"Base"` = every
 * change vs the merge-base with the task's base branch (committed +
 * uncommitted + untracked) — the review diff.
 */
export type DiffScope = "Unstaged" | "Staged" | "Head" | "Base";

/** When a run command starts by itself (snake_case on the wire). */
export type RunWhen = "manual" | "task_start" | "before_review";

export interface RunCommand {
  id: string;
  repositoryId: string;
  name: string;
  command: string;
  shortcut: string | null;
  pinned: boolean;
  sortOrder: number;
  /**
   * `task_start` = headless in the task's worktree when its agent starts;
   * `before_review` = a check, auto-run on entering review. Auto-runs only
   * once the command text is trusted on this machine (see
   * `CheckSummary.needsConfirmation` / `confirmRunCommand`).
   */
  runWhen: RunWhen;
  /** Watch output for a dev-server port ("dev · :3000"). */
  detectPort: boolean;
  /** Gates "Approve & create PR". A command that is required or `before_review` is a check. */
  requiredForApprove: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A run command that ran (or runs) this session, from `list_running_commands`. */
export interface RunningCommand {
  runCommandId: string;
  /** `null` = running in the repository's own checkout. */
  workspaceId: string | null;
  startedAt: string;
  running: boolean;
  /** Set once it exited; `null` while running or when killed by a signal. */
  exitCode: number | null;
  /** A confirmed dev-server port, while running. */
  port: number | null;
}

/** A `package.json` script offered as a run command. */
export interface DetectedScript {
  name: string;
  /** e.g. `pnpm run dev` (package manager from the lockfile). */
  command: string;
  /** A run command with this exact command line exists. */
  alreadyAdded: boolean;
}

// ── review (M8) ──────────────────────────────────────────────────────

export type CheckStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cancelled"
  | "error"
  | "timeout";

export interface CheckRun {
  id: string;
  workspaceId: string;
  /** `null` once the run command was deleted. */
  runCommandId: string | null;
  name: string;
  command: string;
  status: CheckStatus;
  exitCode: number | null;
  /** Worktree state the run saw; compare via `CheckSummary.staleIds`. */
  fingerprint: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Last 64 KiB of output; `get_check_output` has the full log. */
  outputTail: string;
}

export interface CheckSummary {
  /** Latest run per run command (checks first). */
  runs: CheckRun[];
  /** Run command ids required for approve. */
  required: string[];
  /** Every required check passed on the worktree as it is now. */
  requiredSatisfied: boolean;
  /** Run ids whose code changed since they ran. */
  staleIds: string[];
  /** Auto-run command ids not yet confirmed on this machine (not auto-run). */
  needsConfirmation: string[];
}

/** Payload of `phasr://check-output` (≤ 1 per run per 250ms). */
export interface CheckOutputPayload {
  checkRunId: string;
  workspaceId: string;
  chunk: string;
}

export type CommentSide = "new" | "old";
export type CommentStatus = "pending" | "sent" | "resolved";

export interface ReviewComment {
  id: string;
  workspaceId: string;
  path: string;
  line: number;
  side: CommentSide;
  /** The commented line's text when written (quoted to the agent). */
  anchorText: string | null;
  body: string;
  status: CommentStatus;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  resolvedAt: string | null;
}

export interface SendCommentsOutcome {
  /** Comments delivered to the agent. */
  sent: number;
}

export interface PullRequestOutcome {
  /** The PR (`viaGh`), or the compare page to open one by hand. */
  url: string;
  number: number | null;
  viaGh: boolean;
  draft: boolean;
}

// ── notifications inbox (M8) ─────────────────────────────────────────

export type NotificationKind =
  | "needs_approval"
  | "task_finished"
  | "task_failed"
  | "checks_finished"
  | "run_command_failed";

export interface AppNotification {
  id: string;
  workspaceId: string | null;
  repositoryId: string | null;
  kind: NotificationKind;
  title: string;
  body: string | null;
  /**
   * Kind-specific routing data; always has `taskId`/`repositoryId` for task
   * kinds. A `task_finished` entry with `suggestion: "cleanup"` (plus
   * `worktreePath` / `branch`) is the cleanup-after-merge question — offer
   * `remove_worktrees` instead of "Open".
   */
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

export interface DeliveryChannels {
  badge: boolean;
  system: boolean;
  sound: boolean;
}

export interface QuietHours {
  enabled: boolean;
  /** Local "HH:MM"; may wrap midnight (22:00 → 08:00). */
  start: string;
  end: string;
}

export interface NotificationPrefs {
  /** Keyed by `NotificationKind` (unknown keys are kept as-is). */
  matrix: Partial<Record<NotificationKind, DeliveryChannels>>;
  /** System banners / sounds only while the window isn't focused. */
  backgroundOnly: boolean;
  quietHours: QuietHours;
}

export type NoteOriginKind =
  | "workspace"
  | "terminal"
  | "runCommand"
  | "repository";

/** Repository-scoped note. `origin*` is a creation-time snapshot — the
 *  referenced workspace/terminal may no longer exist. */
export interface Note {
  id: string;
  repositoryId: string;
  body: string;
  originKind: NoteOriginKind;
  originWorkspaceId: string | null;
  originWorkspaceName: string | null;
  originTerminalId: string | null;
  originLabel: string;
  createdAt: string;
  updatedAt: string;
  /** Non-null means done; the value is when it was ticked (sort key). */
  doneAt: string | null;
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
  /**
   * The branch "Merge locally" merges into and `aheadOfTarget` /
   * `behindOfTarget` are counted against: the task's base branch. Sent by
   * newer backends; read it through `mergeTargetBranch()`, which falls back
   * to the task's base, then the repository default.
   */
  baseBranch: string;
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

// ── Agent signals (M6) ────────────────────────────────────────────────
// Mirrors `src-tauri/src/agent_signals/state.rs` + `transcripts/mod.rs` +
// `domain/usage.rs`.

/** `AgentStateKind` (kebab-case). */
export type AgentStateKind = "working" | "idle" | "needs-you" | "exited";

/**
 * What kind of thing the agent is waiting on. `trust` = the agent's
 * folder-trust dialog ("Do you trust this folder?", detail = the worktree
 * path); the task's initial prompt is held until it's answered. Its
 * responses: `allow-once` / `allow-task` → "Yes, I trust this folder";
 * `deny` → "No, exit" (the agent quits and the prompt is dropped).
 */
export type AttentionKind = "shell" | "edit" | "tool" | "question" | "input" | "trust";

/** `hook` = the agent told us; `heuristic` = recognised from its output. */
export type AttentionSource = "hook" | "heuristic";

/** The agent's current dialog. A new dialog always has a new `id`. */
export interface Attention {
  id: string;
  kind: AttentionKind;
  title: string;
  /** e.g. the shell command, or the file path. */
  detail: string | null;
  /** ISO timestamp the dialog appeared (drives "blocked 4m"). */
  since: string;
  source: AttentionSource;
  /**
   * Whether Allow/Deny can be answered in-app. `false` → show
   * "Waiting for input · Open terminal".
   */
  canRespond: boolean;
  /**
   * Whether "Allow for this task" is answerable: the dialog on screen has an
   * option scoped to this session/task. False for Claude until its options
   * are read off the screen (its option 2 is often a persistent "always
   * allow … from this project" rule) — hide the button then;
   * `respondToAttention(…, "allow-task")` rejects in that case.
   */
  canAllowForTask: boolean;
}

/** Payload of `list_agent_states` and the `phasr://task-agent-state` event. */
export interface TaskAgentState {
  taskId: string;
  repositoryId: string;
  state: AgentStateKind;
  attention: Attention | null;
  /** Running-card activity line, e.g. "Editing src/x.ts". */
  lastActivity: string | null;
  lastTurnEndedAt: string | null;
}

/** `respond_to_attention` answers. */
export type AttentionResponse = "allow-once" | "allow-task" | "deny";

/** `notify_attention` (Rust `NotifyOutcome`, lowercase). */
export type NotifyAttentionOutcome = "sent" | "stale" | "unsupported";

/** `phasr://attention-activated`: a needs-you notification was clicked. */
export interface AttentionActivatedPayload {
  taskId: string;
  repositoryId: string;
}

/** Token/cost totals for a task, from the agent's own transcript. */
export interface TaskUsage {
  source: "claude" | "codex";
  model: string | null;
  /** Uncached input tokens (both agents). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** USD. `null` only when no model used has a known price — hide the cost. */
  costUsd: number | null;
  /**
   * Some model used has no known price: `costUsd` covers only the priced
   * part (a lower bound — show it as "≥ $x"). Always sent by current
   * backends; optional so older fixtures still type-check.
   */
  costPartial?: boolean;
  updatedAt: string;
}

/** Payload of `phasr://task-usage` (at most one per task per 5s). */
export interface TaskUsagePayload {
  taskId: string;
  usage: TaskUsage;
}

/** The agent's last assistant message. */
export interface AgentSummary {
  text: string;
  at: string;
  /** `hook` until the transcript is readable (or for non-transcript agents). */
  source: "transcript" | "hook";
}

/** A file the agent edited (latest edit per path, newest first). */
export interface AgentFileEdit {
  /** Worktree-relative when inside the worktree, else absolute. */
  path: string;
  at: string;
  /** "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "apply_patch". */
  tool: string;
}

// ── Board (M7) ────────────────────────────────────────────────────────
// Mirrors `src-tauri/src/domain/board.rs` + `orchestrator/board.rs` +
// `commands/board.rs`.

/**
 * A task's Board column, derived by the backend (`derive_lane`; kebab-case).
 * `draft` = saved, never started; `queued` = waiting to start;
 * `needs-review` = the agent stopped (or is idle) with changes vs base;
 * `done` = merged/closed, or finished with no changes; `archived` =
 * archived without an outcome (fold into Done or hide).
 */
export type BoardLane =
  | "draft"
  | "queued"
  | "running"
  | "needs-you"
  | "needs-review"
  | "failed"
  | "done"
  | "archived";

/** Changes on a task's branch vs its base: committed + uncommitted + untracked. */
export interface DiffStats {
  adds: number;
  removes: number;
  files: number;
}

/** One Board card, from `list_task_cards`. */
export interface TaskCard {
  workspace: Workspace;
  lane: BoardLane;
  /** `null` before launch, when archived, or with no worktree on this machine. */
  diff: DiffStats | null;
  /** `null` when phasr hasn't tracked the agent since startup. */
  agentState: TaskAgentState | null;
  /** Stored token/cost snapshot; `null` for agents without usage. */
  usage: TaskUsage | null;
  /** "finished 18m ago" — set for needs-review / done / failed / archived. */
  finishedAt: string | null;
  /** Name of the task a queued task waits on. */
  dependsOnName: string | null;
}

/** Payload of `phasr://task-cards-changed`: refetch that repository's cards. */
export interface TaskCardsChangedPayload {
  repositoryId: string;
  /** Exactly which cards changed; absent = any card in the repository. */
  taskIds?: string[];
}

/** Cloud-sync worker state. Matches `sync::SyncPhase` (lowercase). */
export type SyncPhase = "off" | "idle" | "syncing" | "error";

/** Status bar counts, from `get_system_status`. */
export interface SystemStatus {
  /** Agents running in task PTYs (not run commands / plain shells). */
  agentsRunning: number;
  /** The user's task worktrees present on this machine. */
  worktrees: number;
  sync: SyncPhase;
}

// ── Files tab (M9) ────────────────────────────────────────────────────

/** One row of `list_workspace_tree`. `status: null` = clean. */
export interface WorkspaceTreeFile {
  /** Worktree-relative, `/`-separated. */
  path: string;
  status: FileStatus | null;
}

/** Tracked + untracked (not ignored) files; capped at 50k (`truncated`). */
export interface WorkspaceTree {
  files: WorkspaceTreeFile[];
  truncated: boolean;
}

/** When the task's agent last edited a file (from its transcript). */
export interface LastAgentEdit {
  agent: Agent;
  at: string;
}

/** `read_workspace_file`: ≤ 1 MB UTF-8 text. */
export interface WorkspaceFile {
  path: string;
  contents: string;
  /** sha256 hex of the bytes; pass back as `expectedHash` when saving. */
  hash: string;
  sizeBytes: number;
  lastAgentEdit: LastAgentEdit | null;
}

/** `write_workspace_file`: the hash of what was written. */
export interface WriteWorkspaceFileResult {
  hash: string;
}

/** Diffs `revert_hunk` works on: uncommitted (`Head`) or vs the task's base. */
export type RevertHunkScope = Extract<DiffScope, "Head" | "Base">;

// ── Settings expansion + worktrees (M11) ──────────────────────────────

/** Whether agents may `git push` on their own (lowercase on the wire). */
export type PushPolicy = "ask" | "allow" | "deny";
/** What "Approve & create PR" opens by default. */
export type PrMode = "draft" | "ready";
/** What happens to a task's worktree + local branch once it's merged. */
export type CleanupAfterMerge = "ask" | "always" | "never";

/** Per-repository rules (local to this machine, never synced). */
export interface RepositoryConfig {
  repositoryId: string;
  /** `null` → the repository's default branch. */
  defaultBaseBranch: string | null;
  fetchBaseBeforeTask: boolean;
  agentsMayPush: PushPolicy;
  prMode: PrMode;
  /** Worktree-relative globs the agent must ask before editing. */
  protectedPaths: string[];
  /** Untracked/ignored files copied into each new worktree (never overwriting). */
  copyUntrackedGlobs: string[];
  cleanupAfterMerge: CleanupAfterMerge;
  /** "After creating" hook: runs once in a new worktree, output in the task log. */
  preTaskHook: string | null;
  /** Overrides `UserSettings.branchPrefixTemplate` (`{{slug}}`, `{{id}}`, `{{agent}}`). */
  branchPrefixTemplate: string | null;
  /** Overrides `UserSettings.worktreeBasePath` (absolute or `~/…`). */
  worktreeBasePath: string | null;
  /** Agents the push / protected-path rules bind (today: `["claude"]`); others aren't restricted. */
  policyEnforcedFor: Agent[];
  /** `null` = never saved (all defaults). */
  updatedAt: string | null;
}

/** API keys phasr keeps in the Keychain, injected only into the matching agent. */
export type ApiKeyName = "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" | "GEMINI_API_KEY";

export interface ApiKeyStatus {
  name: ApiKeyName;
  isSet: boolean;
  /** Last 4 characters ("…a1b2"); `null` when unset or too short to hint. */
  hint: string | null;
}

/** A Whisper model for voice input (`list_voice_models`), in Settings order. */
export interface VoiceModel {
  id: string;
  /** "Fast" / "Accurate" / "Multilingual". */
  label: string;
  /** "Whisper base · English". */
  detail: string;
  sizeBytes: number;
  languages: "english" | "multilingual";
  installed: boolean;
  /** Bytes so far while a download runs, else null. */
  downloading: number | null;
}

/** `phasr://voice-model`: a model download moved on. */
export interface VoiceModelProgress {
  modelId: string;
  phase: "downloading" | "done" | "failed" | "cancelled";
  downloaded: number;
  total: number;
  error: string | null;
}

/** A CLI that can clean up a dictation (`list_dictation_polishers`). */
export type Polisher = "claude" | "codex";
export interface PolisherInfo {
  id: Polisher;
  /** "Claude Haiku", "Codex gpt-6-luna". */
  label: string;
  available: boolean;
}

export type MicAccess = "authorized" | "not-determined" | "denied" | "restricted" | "unsupported";

/** One worktree of a repository (`list_repository_worktrees`; main checkout excluded). */
export interface RepositoryWorktree {
  path: string;
  branch: string | null;
  workspaceId: string | null;
  taskName: string | null;
  lane: BoardLane | null;
  /** In a phasr worktree folder with no task pointing at it. */
  orphaned: boolean;
}

/** `compute_worktree_sizes`; `bytes: null` = couldn't measure (timeout / error). */
export interface WorktreeSize {
  path: string;
  bytes: number | null;
}
