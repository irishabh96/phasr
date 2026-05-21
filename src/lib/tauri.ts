import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Agent,
  BranchStatus,
  CommitOutput,
  DiffScope,
  FileChange,
  Launcher,
  OpenPullRequestOutcome,
  PathValidation,
  PtyEvent,
  Repository,
  RunCommand,
  RunningWorkspaceInfo,
  StartedTask,
  UserSettings,
  Workspace,
  WorkspaceDeleteCheck,
  WorkspaceStatus,
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
  command: string;
  prompt?: string;
  agentId?: string;
}

interface UpdateWorkspaceInput {
  name?: string;
  prompt?: string;
  agentId?: string;
  command?: string;
  status?: WorkspaceStatus;
  branch?: string;
  worktreePath?: string;
  exitCode?: number;
}

interface StartTaskInput {
  repositoryId: string;
  agentId: string;
  name: string;
  prompt?: string;
  baseBranch?: string;
  rows?: number;
  cols?: number;
}

export const tauri = {
  // ── auth ─────────────────────────────────────────────────────────────
  setSession: (jwt: string) => invoke<string>("set_session", { jwt }),
  clearSession: () => invoke<void>("clear_session"),
  currentUserId: () => invoke<string | null>("current_user_id"),

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
    invoke<string>("git_init_from_template", { templateGitUrl, destinationPath }),
  gitInitEmptyRepository: (destinationPath: string) =>
    invoke<string>("git_init_empty_repository", { destinationPath }),
  listRepoFiles: (path: string) => invoke<string[]>("list_repo_files", { path }),
  listLocalBranches: (path: string) =>
    invoke<string[]>("list_local_branches", { path }),
  readTextFile: (path: string) => invoke<string>("read_text_file", { path }),

  // ── session terminals (in-app shell PTYs for the repo tab system) ──
  startSessionTerminal: (cwd: string, onEvent: Channel<PtyEvent>, rows?: number, cols?: number) =>
    invoke<string>("start_session_terminal", { cwd, onEvent, rows, cols }),
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
  archiveWorkspace: (id: string) => invoke<Workspace>("archive_workspace", { id }),
  openPullRequest: (id: string) =>
    invoke<OpenPullRequestOutcome>("open_pull_request", { id }),
  checkWorkspaceDelete: (id: string) =>
    invoke<WorkspaceDeleteCheck>("check_workspace_delete", { id }),
  deleteWorkspace: (id: string) => invoke<void>("delete_workspace", { id }),
  watchWorkspace: (id: string) => invoke<void>("watch_workspace", { id }),
  unwatchWorkspace: (id: string) => invoke<void>("unwatch_workspace", { id }),

  // ── agents ───────────────────────────────────────────────────────────
  listAgents: () => invoke<Agent[]>("list_agents"),
  setAgentEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_agent_enabled", { id, enabled }),
  setAgentCommand: (id: string, command: string) =>
    invoke<void>("set_agent_command", { id, command }),
  setAgentDefault: (id: string) => invoke<void>("set_agent_default", { id }),
  createCustomAgent: (input: { name: string; command: string }) =>
    invoke<Agent>("create_custom_agent", { input }),
  deleteAgent: (id: string) => invoke<void>("delete_agent", { id }),

  // ── settings ─────────────────────────────────────────────────────────
  getUserSettings: () => invoke<UserSettings>("get_user_settings"),
  updateUserSettings: (settings: UserSettings) =>
    invoke<UserSettings>("update_user_settings", { settings }),

  // ── git ──────────────────────────────────────────────────────────────
  gitStatus: (workspaceId: string) => invoke<FileChange[]>("git_status", { workspaceId }),
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
  gitPush: (workspaceId: string) => invoke<void>("git_push", { workspaceId }),
  gitBranchStatus: (workspaceId: string) =>
    invoke<BranchStatus>("git_branch_status", { workspaceId }),

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

  // ── orchestrator (new task lifecycle) ────────────────────────────────
  // The new path that creates a workspace row, sets up its worktree,
  // and spawns the PTY in one shot. Use this for ⌘T / "New task" UX.
  // (The legacy `createWorkspace` + `startWorkspace` two-step is still
  // wired below for the project-creation wizard until task #25 retires
  // it.)
  startTask: (input: StartTaskInput) => invoke<StartedTask>("start_task", { input }),
  stopTask: (taskId: string) => invoke<void>("stop_task", { taskId }),
  sendInputToTask: (taskId: string, data: string) =>
    invoke<void>("send_input_to_task", { taskId, data }),

  // ── runtime (PTY) ────────────────────────────────────────────────────
  startWorkspace: (
    workspaceId: string,
    onEvent: Channel<PtyEvent>,
    rows = 24,
    cols = 80,
  ) => invoke<RunningWorkspaceInfo>("start_workspace", { workspaceId, onEvent, rows, cols }),
  readWorkspaceLog: (workspaceId: string) =>
    invoke<string>("read_workspace_log", { workspaceId }),
  sendWorkspaceInput: (workspaceId: string, data: string) =>
    invoke<void>("send_workspace_input", { workspaceId, data }),
  resizeWorkspace: (workspaceId: string, rows: number, cols: number) =>
    invoke<void>("resize_workspace", { workspaceId, rows, cols }),
  interruptWorkspace: (workspaceId: string) =>
    invoke<void>("interrupt_workspace", { workspaceId }),
  stopWorkspace: (workspaceId: string) => invoke<void>("stop_workspace", { workspaceId }),
};

export { Channel };
