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

export interface Workspace {
  id: string;
  repositoryId: string;
  name: string;
  prompt: string | null;
  agentId: string | null;
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
}

export interface Agent {
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
  defaultAgentId: string | null;
  disabledAgentIds: string;
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

export interface RunningWorkspaceInfo {
  workspaceId: string;
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

export interface OpenPullRequestOutcome {
  url: string;
  provider: string;
  headBranch: string;
  baseBranch: string;
}

export interface WorkspaceDeleteCheck {
  hasUnpushedCommits: boolean;
}

export type LauncherKind = "editor" | "terminal" | "filemanager";

export interface Launcher {
  id: string;
  name: string;
  kind: LauncherKind;
}
