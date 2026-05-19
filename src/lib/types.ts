// Mirrors the Rust domain types (src-tauri/src/domain/*) with the
// camelCase shape they serialize to. Keep these in lockstep with the
// Rust side — when a field changes there, update it here too.

export type TaskStatus =
  | "pending"
  | "running"
  | "stopped"
  | "completed"
  | "failed"
  | "archived";

export interface Workspace {
  id: string;
  name: string;
  remoteUrl: string | null;
  localPath: string | null;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  name: string;
  prompt: string | null;
  presetId: string | null;
  command: string;
  status: TaskStatus;
  branch: string | null;
  worktreePath: string | null;
  exitCode: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
}

export interface Preset {
  id: string;
  name: string;
  command: string;
  icon: string | null;
  isDefault: boolean;
  isEnabled: boolean;
  isSeed: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
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
}

export type DiffScope = "Unstaged" | "Staged" | "Head";

export interface CommitOutput {
  sha: string;
  message: string;
}

export type PtyEvent =
  | { type: "output"; taskId: string; chunk: string }
  | { type: "exit"; taskId: string; exitCode: number | null };

export interface RunningTaskInfo {
  taskId: string;
  startedAt: string;
}

export interface PathValidation {
  path: string;
  absolutePath: string | null;
  exists: boolean;
  isDir: boolean;
  isGitRepo: boolean;
  message: string | null;
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
  defaultPresetId: string | null;
  keyboardShortcuts: string;
  branchPrefixTemplate: string;
  worktreeBasePath: string;
  defaultMergeStrategy: string;
  autoFetchSeconds: number;
  honorGpgSign: boolean;
  autoPushOnCommit: boolean;
  updatedAt: string;
}
