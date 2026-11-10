import { Channel, invoke } from "@tauri-apps/api/core";
import { maybeRequestNotificationPermission } from "./notificationPermission";
import type {
  Agent,
  AgentDetection,
  AgentFileEdit,
  AgentSummary,
  ApiKeyName,
  ApiKeyStatus,
  CleanupAfterMerge,
  AgentOption,
  AppNotification,
  AttentionResponse,
  NotifyAttentionOutcome,
  BranchStatus,
  CheckRun,
  CheckSummary,
  Commit,
  CommitFileChange,
  CommitOutput,
  ConflictSide,
  CommentSide,
  CommentStatus,
  DetectedScript,
  DiffScope,
  EnvironmentCheck,
  FileChange,
  GitPushOutcome,
  InProgress,
  Launcher,
  LogOptions,
  MergeOutcome,
  MergeStrategy,
  Note,
  NoteOriginKind,
  OpenPullRequestOutcome,
  PathValidation,
  PermissionMode,
  PrMode,
  PtyEvent,
  PushPolicy,
  PullRequestOutcome,
  Repository,
  RepositoryConfig,
  RepositoryWorktree,
  RevertHunkScope,
  ReviewComment,
  RunCommand,
  RunIn,
  RunningCommand,
  RunWhen,
  SendCommentsOutcome,
  RunningTaskInfo,
  StartedTask,
  SystemStatus,
  TaskActivity,
  TaskAgentState,
  TaskCard,
  TaskUsage,
  UnconfirmedSetting,
  UserSettings,
  Workspace,
  WorkspaceDeleteCheck,
  WorkspaceFile,
  WorkspaceStatus,
  WorkspaceTree,
  WorktreeSize,
  WriteWorkspaceFileResult,
} from "./types";

interface CreateRepositoryInput {
  name: string;
  localPath?: string;
  remoteUrl?: string;
}

interface UpdateRepositoryInput {
  name?: string;
  remoteUrl?: string;
  localPath?: string;
  defaultBranch?: string;
}

interface CreateWorkspaceInput {
  repositoryId: string;
  name: string;
  prompt?: string;
  agent?: Agent;
}

interface UpdateWorkspaceInput {
  name?: string;
  prompt?: string;
  agent?: Agent;
  command?: string;
  status?: WorkspaceStatus;
  branch?: string;
  worktreePath?: string;
  exitCode?: number;
  /** Takes effect the next time the task starts/resumes. */
  permissionMode?: PermissionMode;
  notifyOnAttention?: boolean;
}

interface StartTaskInput {
  repositoryId: string;
  agent: Agent;
  name: string;
  prompt?: string;
  baseBranch?: string;
  rows?: number;
  cols?: number;
  /** Omitted → the user's `defaultPermissionMode`. */
  permissionMode?: PermissionMode;
  /** Omitted → true. */
  notifyOnAttention?: boolean;
  /** Omitted → "worktree". "in-place" runs in the repo's local workspace. */
  runIn?: RunIn;
  /**
   * New task's Run chip: a run command the backend starts in the task's
   * worktree once its agent is up (setup finishes after `start_task`
   * returns). One that can't start becomes an inbox entry, never a failed
   * task.
   */
  runCommandId?: string;
}

export interface CreateTaskDraftInput {
  repositoryId: string;
  name: string;
  prompt?: string;
  agent: Agent;
  /** Omitted → the user's `defaultPermissionMode`. */
  permissionMode?: PermissionMode;
  /** Omitted → the repository's default branch, read when it starts. */
  baseBranch?: string;
  /** `true` → queued (starts when `dependsOn` reaches review); `false` → draft. */
  queue: boolean;
  /** Task id to wait for. */
  dependsOn?: string;
  /** Omitted → true. */
  notifyOnAttention?: boolean;
}

/**
 * Edits to a draft / queued task. Omitted = unchanged; `null` clears
 * `prompt` / `baseBranch` / `dependsOn`. Rejected once the task started.
 */
export interface UpdateTaskDraftInput {
  name?: string;
  prompt?: string | null;
  agent?: Agent;
  permissionMode?: PermissionMode;
  baseBranch?: string | null;
  dependsOn?: string | null;
  notifyOnAttention?: boolean;
}

export interface CreateReviewCommentInput {
  workspaceId: string;
  path: string;
  line: number;
  /** Omitted → "new". */
  side?: CommentSide;
  /** The commented line's text, quoted to the agent. */
  anchorText?: string;
  body: string;
}

export interface UpdateReviewCommentInput {
  body?: string;
  status?: CommentStatus;
}

export interface ApproveInput {
  draft?: boolean;
  /** Omitted → the task name. */
  title?: string;
  /** Omitted → the agent's summary + check results. */
  body?: string;
  /** Open the PR although required checks aren't passing. */
  overrideChecks?: boolean;
  /**
   * The worktree has uncommitted (incl. untracked) changes: commit them all
   * (message = the task name) before pushing. Without it a dirty worktree
   * rejects with exactly "worktree has uncommitted changes".
   */
  commitDirty?: boolean;
}

export interface ListNotificationsInput {
  unreadOnly?: boolean;
  /** Newest first; capped at 500 by the backend. */
  limit?: number;
}

/**
 * Edits to a repository's rules. Omitted = unchanged; `null` (or `""`)
 * clears the text fields back to their default.
 */
export interface UpdateRepositoryConfigInput {
  defaultBaseBranch?: string | null;
  fetchBaseBeforeTask?: boolean;
  agentsMayPush?: PushPolicy;
  prMode?: PrMode;
  protectedPaths?: string[];
  copyUntrackedGlobs?: string[];
  cleanupAfterMerge?: CleanupAfterMerge;
  /** "After creating" hook. */
  preTaskHook?: string | null;
  branchPrefixTemplate?: string | null;
  worktreeBasePath?: string | null;
}

interface StartCloudSyncInput {
  supabaseUrl: string;
  supabaseAnonKey: string;
  // The machine id is derived from the hardware on the Rust side (so it
  // survives a wiped profile); there is no frontend field for it anymore.
}

interface RegisterNotificationRouteInput {
  taskId: string;
  repositoryId: string;
  status?: WorkspaceStatus;
}

export const tauri = {
  // ── auth ─────────────────────────────────────────────────────────────
  setSession: (jwt: string) => invoke<string>("set_session", { jwt }),
  clearSession: () => invoke<void>("clear_session"),
  currentUserId: () => invoke<string | null>("current_user_id"),
  consumePendingAuthCallback: () =>
    invoke<string | null>("consume_pending_auth_callback"),
  startCloudSync: (input: StartCloudSyncInput) =>
    invoke<void>("start_cloud_sync", { input }),
  stopCloudSync: () => invoke<void>("stop_cloud_sync"),

  // ── repositories ─────────────────────────────────────────────────────
  createRepository: (input: CreateRepositoryInput) =>
    invoke<Repository>("create_repository", { input }),
  listRepositories: () => invoke<Repository[]>("list_repositories"),
  getRepository: (id: string) => invoke<Repository>("get_repository", { id }),
  updateRepository: (id: string, input: UpdateRepositoryInput) =>
    invoke<Repository>("update_repository", { id, input }),
  deleteRepository: (id: string) => invoke<void>("delete_repository", { id }),
  gitInitRepository: (id: string) =>
    invoke<Repository>("git_init_repository", { id }),
  gitCloneRepository: (url: string, destinationPath: string) =>
    invoke<string>("git_clone_repository", { url, destinationPath }),
  gitInitFromTemplate: (templateGitUrl: string, destinationPath: string) =>
    invoke<string>("git_init_from_template", {
      templateGitUrl,
      destinationPath,
    }),
  gitInitEmptyRepository: (destinationPath: string) =>
    invoke<string>("git_init_empty_repository", { destinationPath }),
  listRepoFiles: (path: string) =>
    invoke<string[]>("list_repo_files", { path }),
  listLocalBranches: (path: string) =>
    invoke<string[]>("list_local_branches", { path }),
  /** Absolute path inside one of your repositories / worktrees; else rejects. */
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),
  /** Write pasted image bytes to `<app_data>/attachments/<uuid>.<ext>`
   *  (png/jpg/jpeg/gif/webp, ≤ 20 MB); resolves to the absolute path.
   *  A plain array: serde's `Vec<u8>` can't read a JSON'd Uint8Array. */
  saveAttachment: (bytes: Uint8Array, extension: string) =>
    invoke<string>("save_attachment", { bytes: Array.from(bytes), extension }),

  // ── session terminals (in-app shell PTYs for the repo tab system) ──
  startSessionTerminal: (
    cwd: string,
    onEvent: Channel<PtyEvent>,
    rows?: number,
    cols?: number,
    initialCommand?: string,
  ) =>
    invoke<string>("start_session_terminal", {
      cwd,
      onEvent,
      rows,
      cols,
      initialCommand,
    }),
  attachSessionTerminal: (sessionId: string, onEvent: Channel<PtyEvent>) =>
    invoke<void>("attach_session_terminal", { sessionId, onEvent }),
  sendSessionInput: (sessionId: string, data: string) =>
    invoke<void>("send_session_input", { sessionId, data }),
  resizeSession: (sessionId: string, rows: number, cols: number) =>
    invoke<void>("resize_session", { sessionId, rows, cols }),
  stopSessionTerminal: (sessionId: string) =>
    invoke<void>("stop_session_terminal", { sessionId }),

  // ── localfs ──────────────────────────────────────────────────────────
  defaultProjectsDir: () => invoke<string>("default_projects_dir"),
  ensureDir: (path: string) => invoke<string>("ensure_dir", { path }),

  // ── workspaces ───────────────────────────────────────────────────────
  createWorkspace: (input: CreateWorkspaceInput) =>
    invoke<Workspace>("create_workspace", { input }),
  listWorkspaces: (repositoryId: string) =>
    invoke<Workspace[]>("list_workspaces", { repositoryId }),
  getWorkspace: (id: string) => invoke<Workspace>("get_workspace", { id }),
  updateWorkspace: (id: string, input: UpdateWorkspaceInput) =>
    invoke<Workspace>("update_workspace", { id, input }),
  archiveWorkspace: (id: string) =>
    invoke<Workspace>("archive_workspace", { id }),
  openPullRequest: (id: string) =>
    invoke<OpenPullRequestOutcome>("open_pull_request", { id }),
  checkWorkspaceDelete: (id: string) =>
    invoke<WorkspaceDeleteCheck>("check_workspace_delete", { id }),
  deleteWorkspace: (id: string) => invoke<void>("delete_workspace", { id }),
  watchWorkspace: (id: string) => invoke<void>("watch_workspace", { id }),
  unwatchWorkspace: (id: string) => invoke<void>("unwatch_workspace", { id }),

  // ── notifications (DDR-003 §6 activation seam) ───────────────────────
  // Records the routing metadata for a workspace's OS notification so the
  // Rust side can resolve it on activation. Called before `sendNotification`
  // because the notification plugin drops `extra` on desktop.
  registerNotificationRoute: (input: RegisterNotificationRouteInput) =>
    invoke<void>("register_notification_route", { input }),
  // Emits `phasr://notification-activated` for a task (the seam a
  // notification-click transport calls). See useCompletionNotifications.ts.
  activateNotification: (taskId: string) =>
    invoke<void>("activate_notification", { taskId }),

  // ── agents ───────────────────────────────────────────────────────────
  listAgents: () => invoke<AgentOption[]>("list_agents"),
  detectAgents: (force = false) =>
    invoke<AgentDetection[]>("detect_agents", { force }),
  checkEnvironment: (force = false) =>
    invoke<EnvironmentCheck>("check_environment", { force }),
  previewAgentCommand: (agent: Agent, mode: PermissionMode) =>
    invoke<string>("preview_agent_command", { agent, mode }),

  // ── settings ─────────────────────────────────────────────────────────
  getUserSettings: () => invoke<UserSettings>("get_user_settings"),
  /**
   * Saving trusts (on this machine) any agent template / terminal shell the
   * user CHANGED; unchanged synced values stay unconfirmed.
   */
  updateUserSettings: (settings: UserSettings) =>
    invoke<UserSettings>("update_user_settings", { settings }),
  /**
   * Synced settings that would run (or loosen what runs) here but aren't
   * confirmed on this machine, each with the value that would be trusted:
   * `"agentCommands.<agent>"`, `"terminalShell"`, `"defaultPermissionMode"`.
   * Until confirmed, launches use the default template / login shell /
   * the safe default mode.
   */
  listUnconfirmedSettings: () => invoke<UnconfirmedSetting[]>("list_unconfirmed_settings"),
  /**
   * "Allow on this machine" for exactly these keys, at the values shown
   * (the backend trusts the current value per key). Resolves to the keys
   * it confirmed.
   */
  confirmSettingsOnThisMachine: (keys: string[]) =>
    invoke<string[]>("confirm_settings_on_this_machine", { keys }),
  /** Shells from `/etc/shells` present on this machine. */
  listShells: () => invoke<string[]>("list_shells"),

  // ── repository rules + worktrees (M11) ──────────────────────────────
  getRepositoryConfig: (repositoryId: string) =>
    invoke<RepositoryConfig>("get_repository_config", { repositoryId }),
  updateRepositoryConfig: (repositoryId: string, input: UpdateRepositoryConfigInput) =>
    invoke<RepositoryConfig>("update_repository_config", { repositoryId, input }),
  /** The repository's worktrees (main checkout excluded) with task + lane. */
  listRepositoryWorktrees: (repositoryId: string) =>
    invoke<RepositoryWorktree[]>("list_repository_worktrees", { repositoryId }),
  /** `du` per worktree (slow on big trees — fetch on demand). */
  computeWorktreeSizes: (repositoryId: string) =>
    invoke<WorktreeSize[]>("compute_worktree_sizes", { repositoryId }),
  /**
   * Remove worktrees (branches kept). All-or-nothing: rejects the batch for
   * the main checkout, a path outside phasr's worktree folders, or one with
   * a running agent — and, unless `force`, for worktrees with uncommitted
   * changes or unpushed/unmerged commits ("uncommitted changes or unpushed
   * commits would be lost in: <paths>; …"). Resolves to the removed paths.
   */
  removeWorktrees: (repositoryId: string, paths: string[], force = false) =>
    invoke<string[]>("remove_worktrees", { repositoryId, paths, force }),

  // ── API keys (Keychain; values never come back) ──────────────────────
  listApiKeys: () => invoke<ApiKeyStatus[]>("list_api_keys"),
  setApiKey: (name: ApiKeyName, value: string) =>
    invoke<ApiKeyStatus>("set_api_key", { name, value }),
  deleteApiKey: (name: ApiKeyName) => invoke<void>("delete_api_key", { name }),

  // ── git ──────────────────────────────────────────────────────────────
  gitStatus: (workspaceId: string) =>
    invoke<FileChange[]>("git_status", { workspaceId }),
  gitDiff: (workspaceId: string, scope: DiffScope, path?: string) =>
    invoke<string>("git_diff", {
      input: { workspaceId, scope, ...(path ? { path } : {}) },
    }),
  gitStage: (workspaceId: string, paths: string[]) =>
    invoke<void>("git_stage", { workspaceId, paths }),
  gitUnstage: (workspaceId: string, paths: string[]) =>
    invoke<void>("git_unstage", { workspaceId, paths }),
  gitDiscard: (workspaceId: string, paths: string[]) =>
    invoke<void>("git_discard", { workspaceId, paths }),
  gitCommit: (workspaceId: string, message: string) =>
    invoke<CommitOutput>("git_commit", { workspaceId, message }),
  gitPush: (workspaceId: string) =>
    invoke<GitPushOutcome>("git_push", { workspaceId }),
  gitBranchStatus: (workspaceId: string) =>
    invoke<BranchStatus>("git_branch_status", { workspaceId }),
  gitFetch: (workspaceId: string) => invoke<void>("git_fetch", { workspaceId }),
  gitSyncWithMain: (workspaceId: string, strategy: MergeStrategy) =>
    invoke<MergeOutcome>("git_sync_with_main", { workspaceId, strategy }),
  /**
   * Merge the task into its base in the main checkout. Gated like Approve:
   * rejects "required checks not passing: …" / "worktree has uncommitted
   * changes" unless `overrideChecks` / `commitDirty` (both may be sent).
   */
  gitMergeToMain: (
    workspaceId: string,
    strategy: MergeStrategy,
    gates: { overrideChecks?: boolean; commitDirty?: boolean } = {},
  ) => invoke<MergeOutcome>("git_merge_to_main", { workspaceId, strategy, ...gates }),
  gitMergeInProgress: (workspaceId: string) =>
    invoke<InProgress>("git_merge_in_progress", { workspaceId }),
  gitAbortMerge: (workspaceId: string) =>
    invoke<void>("git_abort_merge", { workspaceId }),
  gitContinueMerge: (workspaceId: string) =>
    invoke<MergeOutcome>("git_continue_merge", { workspaceId }),
  gitResolveConflict: (workspaceId: string, path: string, side: ConflictSide) =>
    invoke<void>("git_resolve_conflict", { workspaceId, path, side }),
  gitLog: (workspaceId: string, opts: LogOptions) =>
    invoke<Commit[]>("git_log", { workspaceId, opts }),
  gitCommitFiles: (workspaceId: string, sha: string) =>
    invoke<CommitFileChange[]>("git_commit_files", { workspaceId, sha }),
  gitCommitDiff: (workspaceId: string, sha: string, path?: string) =>
    invoke<string>("git_commit_diff", {
      workspaceId,
      sha,
      ...(path ? { path } : {}),
    }),

  // ── Files tab (M9) ───────────────────────────────────────────────────
  /** Tracked + untracked files of the worktree with git badges (≤ 50k). */
  listWorkspaceTree: (workspaceId: string) =>
    invoke<WorkspaceTree>("list_workspace_tree", { workspaceId }),
  /** ≤ 1 MB UTF-8; `path` is worktree-relative (no `..`, `.git/`, absolute). */
  readWorkspaceFile: (workspaceId: string, path: string) =>
    invoke<WorkspaceFile>("read_workspace_file", { workspaceId, path }),
  /**
   * Atomic save. Rejects with "file changed on disk" when the file no
   * longer matches `expectedHash`; `null` writes unconditionally.
   */
  writeWorkspaceFile: (
    workspaceId: string,
    path: string,
    contents: string,
    expectedHash: string | null,
  ) =>
    invoke<WriteWorkspaceFileResult>("write_workspace_file", {
      workspaceId,
      path,
      contents,
      expectedHash,
    }),
  /**
   * Reverse-apply the hunk with this exact header AND body (its +/-/context
   * lines as rendered); rejects "hunk no longer matches" when either moved.
   */
  revertHunk: (
    workspaceId: string,
    path: string,
    hunkHeader: string,
    hunkBody: string,
    scope: RevertHunkScope,
  ) => invoke<void>("revert_hunk", { workspaceId, path, hunkHeader, hunkBody, scope }),

  // ── localfs ──────────────────────────────────────────────────────────
  validateRepositoryPath: (path: string) =>
    invoke<PathValidation>("validate_workspace_path", { path }),

  // ── launchers ────────────────────────────────────────────────────────
  listLaunchers: () => invoke<Launcher[]>("list_launchers"),
  launchApp: (launcherId: string, path: string) =>
    invoke<void>("launch_app", { launcherId, path }),

  // ── run commands ─────────────────────────────────────────────────────
  listRunCommands: (repositoryId: string) =>
    invoke<RunCommand[]>("list_run_commands", { repositoryId }),
  /** Created here = trusted to auto-run on this machine. */
  createRunCommand: (input: {
    repositoryId: string;
    name: string;
    command: string;
    shortcut?: string;
    pinned?: boolean;
    runWhen?: RunWhen;
    detectPort?: boolean;
    requiredForApprove?: boolean;
  }) => invoke<RunCommand>("create_run_command", { input }),
  /** Editing `command` here re-trusts it; toggling `runWhen` alone does not. */
  updateRunCommand: (
    id: string,
    input: {
      name?: string;
      command?: string;
      shortcut?: string;
      pinned?: boolean;
      sortOrder?: number;
      runWhen?: RunWhen;
      detectPort?: boolean;
      requiredForApprove?: boolean;
    },
  ) => invoke<RunCommand>("update_run_command", { id, input }),
  deleteRunCommand: (id: string) => invoke<void>("delete_run_command", { id }),
  /** "Allow on this machine": a synced command's text may auto-run here. */
  confirmRunCommand: (id: string) => invoke<RunCommand>("confirm_run_command", { id }),
  /** Ids of the repository's run commands NOT trusted on this machine yet. */
  listUntrustedRunCommands: (repositoryId: string) =>
    invoke<string[]>("list_untrusted_run_commands", { repositoryId }),
  /**
   * Start a run command headless in a task's worktree with the task (New
   * task's Run chip). Rejects a command not trusted on this machine; a
   * no-op if it is already running there. The run pane attaches later.
   */
  startRunCommandForTask: (id: string, workspaceId: string) =>
    invoke<void>("start_run_command_for_task", { id, workspaceId }),
  /** Running / exited-this-session run commands, one task or all. */
  listRunningCommands: (workspaceId?: string | null) =>
    invoke<RunningCommand[]>("list_running_commands", { workspaceId: workspaceId ?? null }),
  /** `package.json` scripts as run-command suggestions. */
  detectPackageScripts: (repositoryId: string) =>
    invoke<DetectedScript[]>("detect_package_scripts", { repositoryId }),

  // ── notes ────────────────────────────────────────────────────────────
  listNotesForRepository: (repositoryId: string) =>
    invoke<Note[]>("list_notes_for_repository", { repositoryId }),
  createNote: (input: {
    repositoryId: string;
    body: string;
    originKind: NoteOriginKind;
    originWorkspaceId?: string | null;
    originTerminalId?: string | null;
    originLabelHint?: string | null;
  }) => invoke<Note>("create_note", { input }),
  updateNote: (
    id: string,
    input: {
      body?: string;
      /** RFC3339 `updatedAt` the editor loaded — optimistic-concurrency guard. */
      expectedUpdatedAt?: string;
    },
  ) => invoke<Note>("update_note", { id, input }),
  setNoteDone: (id: string, done: boolean) =>
    invoke<Note>("set_note_done", { id, done }),
  deleteNote: (id: string) => invoke<void>("delete_note", { id }),
  /**
   * Attach (with replay) to a run command that is ALREADY running for this
   * task (`workspaceId`) or the repository checkout. Never starts it:
   * rejects with exactly "not running" when nothing is live under that key
   * (including an exec-mode command that has exited). Call on mount.
   */
  attachRunCommand: (
    id: string,
    onEvent: Channel<PtyEvent>,
    rows = 24,
    cols = 80,
    workspaceId?: string | null,
  ) =>
    invoke<void>("attach_run_command", {
      id,
      onEvent,
      rows,
      cols,
      workspaceId: workspaceId ?? null,
    }),
  /**
   * Explicitly start a run command (the user pressed Run); attaches instead
   * if it is already running. With `workspaceId` it runs in that task's
   * worktree (one process per task); without, in the repository's checkout.
   * Pass the same `workspaceId` to stop/input/resize.
   */
  startRunCommand: (
    id: string,
    onEvent: Channel<PtyEvent>,
    rows = 24,
    cols = 80,
    workspaceId?: string | null,
  ) =>
    invoke<void>("start_run_command", {
      id,
      onEvent,
      rows,
      cols,
      workspaceId: workspaceId ?? null,
    }),
  stopRunCommand: (id: string, workspaceId?: string | null) =>
    invoke<void>("stop_run_command", { id, workspaceId: workspaceId ?? null }),
  sendRunCommandInput: (id: string, data: string, workspaceId?: string | null) =>
    invoke<void>("send_run_command_input", { id, data, workspaceId: workspaceId ?? null }),
  resizeRunCommand: (id: string, rows: number, cols: number, workspaceId?: string | null) =>
    invoke<void>("resize_run_command", { id, rows, cols, workspaceId: workspaceId ?? null }),

  // ── orchestrator (task lifecycle + terminal) ─────────────────────────
  /**
   * Resolves once the task row exists; its worktree setup and agent spawn
   * continue in the backend, so `workspace.status` is usually still
   * `pending` (the board shows it Running, "Setting up the worktree…").
   * A setup that fails later marks the task `failed` (status event).
   */
  startTask: (input: StartTaskInput) =>
    invoke<StartedTask>("start_task", { input }).then((started) => {
      // First successful agent launch is the moment to ask for OS-notification
      // permission (DDR-003 §7 — never on cold start). Fire-and-forget; the
      // helper prompts at most once ever via a localStorage guard.
      void maybeRequestNotificationPermission();
      return started;
    }),
  stopTask: (taskId: string) => invoke<void>("stop_task", { taskId }),
  openTaskTerminal: (
    taskId: string,
    onEvent: Channel<PtyEvent>,
    rows = 24,
    cols = 80,
  ) =>
    invoke<RunningTaskInfo>("open_task_terminal", {
      taskId,
      onEvent,
      rows,
      cols,
    }),
  sendInputToTask: (taskId: string, data: string) =>
    invoke<void>("send_input_to_task", { taskId, data }),
  sendMessageToTask: (taskId: string, text: string, submit = true) =>
    invoke<void>("send_message_to_task", { taskId, text, submit }),
  readTaskLog: (taskId: string) => invoke<string>("read_task_log", { taskId }),
  resizeTask: (taskId: string, rows: number, cols: number) =>
    invoke<void>("resize_task", { taskId, rows, cols }),
  interruptTask: (taskId: string) => invoke<void>("interrupt_task", { taskId }),
  listTaskActivity: () => invoke<TaskActivity[]>("list_task_activity"),

  // ── agent signals (M6) ───────────────────────────────────────────────
  /** Every tracked task's agent state (tasks launched since app start). */
  listAgentStates: () => invoke<TaskAgentState[]>("list_agent_states"),
  /**
   * Answer the agent's approval dialog. Rejects with "stale attention" when
   * `attentionId` is no longer the dialog on screen (nothing is typed).
   */
  respondToAttention: (
    taskId: string,
    attentionId: string,
    response: AttentionResponse,
  ) => invoke<void>("respond_to_attention", { taskId, attentionId, response }),
  /**
   * Show the native needs-you notification for `attentionId` (macOS: Allow /
   * Deny buttons that answer allow-once / deny without opening Phasr; a click
   * emits `phasr://attention-activated`). Call only once the notification
   * policy says to. `"unsupported"` → show your own banner; `"stale"` → that
   * dialog is gone, show nothing.
   */
  notifyAttention: (taskId: string, attentionId: string, sound: boolean) =>
    invoke<NotifyAttentionOutcome>("notify_attention", { taskId, attentionId, sound }),
  /** `null` for agents without readable transcripts (Gemini/Copilot/OpenCode). */
  getTaskUsage: (taskId: string) =>
    invoke<TaskUsage | null>("get_task_usage", { taskId }),
  getAgentSummary: (taskId: string) =>
    invoke<AgentSummary | null>("get_agent_summary", { taskId }),
  listAgentFileEdits: (taskId: string) =>
    invoke<AgentFileEdit[]>("list_agent_file_edits", { taskId }),

  // ── board (M7) ───────────────────────────────────────────────────────
  /**
   * Every task card, one repository or (`null`) all, newest first.
   * Finished (merged/closed/archived) tasks are limited to the last week
   * plus the 50 latest unless `includeAllFinished`.
   */
  listTaskCards: (repositoryId: string | null, includeAllFinished?: boolean) =>
    invoke<TaskCard[]>("list_task_cards", { repositoryId, includeAllFinished }),
  /** Save without starting: a draft, or (`queue: true`) a queued task. */
  createTaskDraft: (input: CreateTaskDraftInput) =>
    invoke<Workspace>("create_task_draft", { input }),
  updateTaskDraft: (id: string, input: UpdateTaskDraftInput) =>
    invoke<Workspace>("update_task_draft", { id, input }),
  /** Move a not-yet-started task into / out of the queue. */
  setTaskQueued: (id: string, queued: boolean) =>
    invoke<Workspace>("set_task_queued", { id, queued }),
  /**
   * "Start now" for a draft / queued / failed-before-launch task. Resolves
   * once the task is claimed, like `startTask`: its worktree setup and
   * agent spawn continue in the backend, so `workspace.status` is usually
   * `pending` (the board shows it Running, "Setting up the worktree…"). A
   * setup that fails later marks it `failed` (status event). A task that
   * already started, or is being set up, is returned as is.
   */
  startQueuedTask: (id: string, rows?: number, cols?: number) =>
    invoke<StartedTask>("start_queued_task", { id, rows, cols }).then((started) => {
      // Same first-launch moment as `startTask` (DDR-003 §7).
      void maybeRequestNotificationPermission();
      return started;
    }),
  getSystemStatus: () => invoke<SystemStatus>("get_system_status"),

  // ── review (M8) ──────────────────────────────────────────────────────
  /** Files changed vs the merge-base with the task's base (committed too). */
  gitReviewFiles: (workspaceId: string) =>
    invoke<FileChange[]>("git_review_files", { workspaceId }),
  /** Run checks now: these run commands, or every check when omitted. */
  runChecks: (workspaceId: string, runCommandIds?: string[]) =>
    invoke<CheckRun[]>("run_checks", { workspaceId, runCommandIds: runCommandIds ?? null }),
  /** Cancel the task's queued/running checks; resolves to how many. */
  cancelChecks: (workspaceId: string) => invoke<number>("cancel_checks", { workspaceId }),
  listCheckRuns: (workspaceId: string) =>
    invoke<CheckSummary>("list_check_runs", { workspaceId }),
  /** Full output (end of the log, ≤ 4 MiB). */
  getCheckOutput: (checkRunId: string) =>
    invoke<string>("get_check_output", { checkRunId }),
  listReviewComments: (workspaceId: string) =>
    invoke<ReviewComment[]>("list_review_comments", { workspaceId }),
  createReviewComment: (input: CreateReviewCommentInput) =>
    invoke<ReviewComment>("create_review_comment", { input }),
  updateReviewComment: (id: string, input: UpdateReviewCommentInput) =>
    invoke<ReviewComment>("update_review_comment", { id, input }),
  deleteReviewComment: (id: string) => invoke<void>("delete_review_comment", { id }),
  /**
   * Send pending comments to the task's agent as one message. Rejects with
   * "agent not running" (no PTY) or "no pending comments to send".
   */
  sendReviewComments: (workspaceId: string, message?: string) =>
    invoke<SendCommentsOutcome>("send_review_comments", { workspaceId, message: message ?? null }),
  /** Like `sendReviewComments`, but a message alone is enough. */
  requestChanges: (workspaceId: string, message?: string) =>
    invoke<SendCommentsOutcome>("request_changes", { workspaceId, message: message ?? null }),
  /**
   * Gate on required checks → push → `gh pr create` (or the compare URL).
   * Rejects with "required checks not passing: a, b" unless `overrideChecks`,
   * and with "worktree has uncommitted changes" unless `commitDirty`.
   */
  approveAndCreatePr: (workspaceId: string, input: ApproveInput = {}) =>
    invoke<PullRequestOutcome>("approve_and_create_pr", { workspaceId, input }),
  /** Re-read open PRs via `gh`; returns the tasks whose PR state / outcome changed. */
  refreshPrStates: (repositoryId?: string | null) =>
    invoke<Workspace[]>("refresh_pr_states", { repositoryId: repositoryId ?? null }),
  /** Remove worktree + branch, outcome closed; the row and notes are kept. */
  discardWorkspace: (workspaceId: string) =>
    invoke<Workspace>("discard_workspace", { workspaceId }),

  // ── notifications inbox (M8) ─────────────────────────────────────────
  listNotifications: (input: ListNotificationsInput = {}) =>
    invoke<AppNotification[]>("list_notifications", { input }),
  unreadNotificationCount: () => invoke<number>("unread_notification_count"),
  /** `null` = mark everything read. Resolves to how many changed. */
  markNotificationsRead: (ids: string[] | null) =>
    invoke<number>("mark_notifications_read", { ids }),
  clearNotifications: () => invoke<number>("clear_notifications"),
};

export { Channel };
