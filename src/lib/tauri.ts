import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  Agent,
  CommitOutput,
  DiffScope,
  FileChange,
  PathValidation,
  PtyEvent,
  Repository,
  RunningWorkspaceInfo,
  UserSettings,
  Workspace,
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

  // ── workspaces ───────────────────────────────────────────────────────
  createWorkspace: (input: CreateWorkspaceInput) =>
    invoke<Workspace>("create_workspace", { input }),
  listWorkspaces: (repositoryId: string) =>
    invoke<Workspace[]>("list_workspaces", { repositoryId }),
  getWorkspace: (id: string) => invoke<Workspace>("get_workspace", { id }),
  updateWorkspace: (id: string, input: UpdateWorkspaceInput) =>
    invoke<Workspace>("update_workspace", { id, input }),
  deleteWorkspace: (id: string) => invoke<void>("delete_workspace", { id }),

  // ── agents ───────────────────────────────────────────────────────────
  listAgents: () => invoke<Agent[]>("list_agents"),
  setAgentEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_agent_enabled", { id, enabled }),

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

  // ── localfs ──────────────────────────────────────────────────────────
  validateRepositoryPath: (path: string) =>
    invoke<PathValidation>("validate_workspace_path", { path }),

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
