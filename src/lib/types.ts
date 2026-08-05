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
