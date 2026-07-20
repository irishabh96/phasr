import { Channel, invoke } from "@tauri-apps/api/core";
import { maybeRequestNotificationPermission } from "./notificationPermission";
import type {
  Agent,
  AgentOption,
  BoardState,
  BranchStatus,
  Commit,
  CommitFileChange,
  CommitOutput,
  ConflictSide,
  DecompositionInput,
  DiffScope,
  FileChange,
  GitPushOutcome,
  InProgress,
  Launcher,
  LogOptions,
  MergeOutcome,
  MergeStrategy,
  OpenPullRequestOutcome,
  PathValidation,
  ProposedPlan,
  PtyEvent,
  Repository,
  RunCommand,
  RunningTaskInfo,
  StartedTask,
  UserSettings,
  Workspace,
  WorkspaceDeleteCheck,
  WorkspaceStatus,
  WorklistState,
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
}

interface StartTaskInput {
  repositoryId: string;
  agent: Agent;
  name: string;
  prompt?: string;
  baseBranch?: string;
  rows?: number;
  cols?: number;
}

interface StartCloudSyncInput {
  supabaseUrl: string;
  supabaseAnonKey: string;
  machineId: string;
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
  listSoftDeletedRepositories: () =>
    invoke<string[]>("list_soft_deleted_repositories"),
  markRepositorySynced: (id: string) =>
    invoke<void>("mark_repository_synced", { id }),
  repositoryIsSoftDeleted: (id: string) =>
    invoke<boolean>("repository_is_soft_deleted", { id }),
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
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),

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

  // ── settings ─────────────────────────────────────────────────────────
  getUserSettings: () => invoke<UserSettings>("get_user_settings"),
  updateUserSettings: (settings: UserSettings) =>
    invoke<UserSettings>("update_user_settings", { settings }),

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
  gitMergeToMain: (workspaceId: string, strategy: MergeStrategy) =>
    invoke<MergeOutcome>("git_merge_to_main", { workspaceId, strategy }),
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

  // ── localfs ──────────────────────────────────────────────────────────
  validateRepositoryPath: (path: string) =>
    invoke<PathValidation>("validate_workspace_path", { path }),

  // ── task board (multi-agent decomposition, P0 slice) ─────────────────
  // Thin wrappers over the FROZEN §C wire contract (`commands/board.rs`).
  // Errors arrive as plain strings. All four return the SAME `BoardState`.
  //
  // The Planner drafting step (Phase 1, §C.2). Runs Claude read-only over the
  // repo and returns a proposed `{ subtasks, edges }` the review surface edits.
  // Persists NOTHING — the single write is still `startDecomposition` below.
  // Rejects with `EmptyGoal | NoRepoPath | Auth | Planner(...)` as plain strings
  // (humanized by the form); on any reject the surface falls back to manual edit.
  planDecomposition: (repositoryId: string, goal: string) =>
    invoke<ProposedPlan>("plan_decomposition", { repositoryId, goal }),
  startDecomposition: (input: DecompositionInput) =>
    invoke<BoardState>("start_decomposition", { input }),
  getBoard: (parentId: string) =>
    invoke<BoardState>("get_board", { parentId }),
  // "Mark done" override (E2-T4): publishes one subtask's handoff contract so a
  // stuck producer never leaves its dependent silently blocked. Returns the
  // refreshed board so the caller re-renders without a follow-up `get_board`.
  publishContract: (subtaskId: string) =>
    invoke<BoardState>("publish_contract", { subtaskId }),
  // Integrate a completed decomposition (E3-T1): mints the parent's integration
  // worktree and merges every subtask branch in topological order. A CLEAN run
  // resolves with the board whose `parent.branch`/`worktreePath` now point at
  // the integration worktree (review the ONE combined diff against the parent
  // id). A conflict REJECTS with "integration stopped on conflicts in: <files>"
  // — the worktree is left mid-merge and the parent row already points at it, so
  // the frontend drives the EXISTING conflict flow (git_merge_in_progress /
  // git_resolve_conflict / git_continue_merge / git_abort_merge) keyed on the
  // parent id (spec claim #6).
  integrateParent: (parentId: string) =>
    invoke<BoardState>("integrate_parent", { parentId }),
  // Combined review for a CLEAN integration (P0-1). After `integrate_parent`
  // the worktree is clean, so a worktree-based review shows EMPTY — these read
  // the integration BRANCH against its base instead, so the review shows what
  // the agents actually produced. `board_integration_diff` returns the combined
  // file list (the EXISTING `FileChange` shape: status rides `staged`,
  // `unstaged` is `"other"`, `adds`/`removes` from numstat / null for
  // binary+renamed); `board_integration_file_diff` returns one file's raw
  // unified diff (what `DiffView` renders), lazy-loaded per file on expand.
  // Errors are plain strings (humanized by the surface).
  boardIntegrationDiff: (parentId: string) =>
    invoke<FileChange[]>("board_integration_diff", { parentId }),
  boardIntegrationFileDiff: (parentId: string, path: string) =>
    invoke<string>("board_integration_file_diff", { parentId, path }),

  // ── worklist (cross-repo attention home, Phase 2 §C.3) ────────────────
  // One call returns every repo, every epic's board, and loose agents for the
  // signed-in user, so the worklist buckets everything without N round-trips.
  // Computes NO state — the frontend derives buckets (`deriveWorklist.ts`).
  listWorklist: () => invoke<WorklistState>("list_worklist"),

  // ── launchers ────────────────────────────────────────────────────────
  listLaunchers: () => invoke<Launcher[]>("list_launchers"),
  launchApp: (launcherId: string, path: string) =>
    invoke<void>("launch_app", { launcherId, path }),

  // ── run commands ─────────────────────────────────────────────────────
  listRunCommands: (repositoryId: string) =>
    invoke<RunCommand[]>("list_run_commands", { repositoryId }),
  createRunCommand: (input: {
    repositoryId: string;
    name: string;
    command: string;
    shortcut?: string;
    pinned?: boolean;
  }) => invoke<RunCommand>("create_run_command", { input }),
  updateRunCommand: (
    id: string,
    input: {
      name?: string;
      command?: string;
      shortcut?: string;
      pinned?: boolean;
      sortOrder?: number;
    },
  ) => invoke<RunCommand>("update_run_command", { id, input }),
  deleteRunCommand: (id: string) => invoke<void>("delete_run_command", { id }),
  upsertRunCommandFromCloud: (input: RunCommand) =>
    invoke<RunCommand>("upsert_run_command_from_cloud", { input }),
  startRunCommand: (
    id: string,
    onEvent: Channel<PtyEvent>,
    rows = 24,
    cols = 80,
  ) => invoke<void>("start_run_command", { id, onEvent, rows, cols }),
  stopRunCommand: (id: string) => invoke<void>("stop_run_command", { id }),
  sendRunCommandInput: (id: string, data: string) =>
    invoke<void>("send_run_command_input", { id, data }),
  resizeRunCommand: (id: string, rows: number, cols: number) =>
    invoke<void>("resize_run_command", { id, rows, cols }),

  // ── orchestrator (task lifecycle + terminal) ─────────────────────────
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
  readTaskLog: (taskId: string) => invoke<string>("read_task_log", { taskId }),
  resizeTask: (taskId: string, rows: number, cols: number) =>
    invoke<void>("resize_task", { taskId, rows, cols }),
  interruptTask: (taskId: string) => invoke<void>("interrupt_task", { taskId }),
};

export { Channel };
