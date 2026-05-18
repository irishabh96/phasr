import { invoke } from "@tauri-apps/api/core";
import type { PathValidation, Preset, Task, TaskStatus, UserSettings, Workspace } from "./types";

interface CreateWorkspaceInput {
  name: string;
  localPath?: string;
  remoteUrl?: string;
}

interface UpdateWorkspaceInput {
  name?: string;
  remoteUrl?: string;
  localPath?: string;
  defaultBranch?: string;
}

interface CreateTaskInput {
  workspaceId: string;
  name: string;
  command: string;
  prompt?: string;
  presetId?: string;
}

interface UpdateTaskInput {
  name?: string;
  prompt?: string;
  presetId?: string;
  command?: string;
  status?: TaskStatus;
  branch?: string;
  worktreePath?: string;
  exitCode?: number;
}

/**
 * Typed wrappers around Tauri commands. Components must never call
 * `invoke()` directly — go through these helpers so the contract stays
 * type-safe and discoverable.
 */
export const tauri = {
  // ── auth ─────────────────────────────────────────────────────────────
  setSession: (jwt: string) => invoke<string>("set_session", { jwt }),
  clearSession: () => invoke<void>("clear_session"),
  currentUserId: () => invoke<string | null>("current_user_id"),

  // ── workspaces ───────────────────────────────────────────────────────
  createWorkspace: (input: CreateWorkspaceInput) =>
    invoke<Workspace>("create_workspace", { input }),
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  getWorkspace: (id: string) => invoke<Workspace>("get_workspace", { id }),
  updateWorkspace: (id: string, input: UpdateWorkspaceInput) =>
    invoke<Workspace>("update_workspace", { id, input }),
  deleteWorkspace: (id: string) => invoke<void>("delete_workspace", { id }),

  // ── tasks ────────────────────────────────────────────────────────────
  createTask: (input: CreateTaskInput) => invoke<Task>("create_task", { input }),
  listTasks: (workspaceId: string) => invoke<Task[]>("list_tasks", { workspaceId }),
  getTask: (id: string) => invoke<Task>("get_task", { id }),
  updateTask: (id: string, input: UpdateTaskInput) =>
    invoke<Task>("update_task", { id, input }),
  deleteTask: (id: string) => invoke<void>("delete_task", { id }),

  // ── presets ──────────────────────────────────────────────────────────
  listPresets: () => invoke<Preset[]>("list_presets"),
  setPresetEnabled: (id: string, enabled: boolean) =>
    invoke<void>("set_preset_enabled", { id, enabled }),

  // ── settings ─────────────────────────────────────────────────────────
  getUserSettings: () => invoke<UserSettings>("get_user_settings"),
  updateUserSettings: (settings: UserSettings) =>
    invoke<UserSettings>("update_user_settings", { settings }),

  // ── localfs ──────────────────────────────────────────────────────────
  validateWorkspacePath: (path: string) =>
    invoke<PathValidation>("validate_workspace_path", { path }),
};
