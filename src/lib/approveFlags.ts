/**
 * Confirmations collected while approving a task. The backend checks the
 * gates in turn (required checks, then a dirty worktree) and refuses at
 * the first one not confirmed; each refusal opens a dialog. A retry must
 * carry EVERY confirmation given so far, or confirming the second gate
 * drops the first and the dialogs loop.
 */
export interface ApproveFlags {
  overrideChecks: boolean;
  commitDirty: boolean;
}

export const NO_APPROVE_FLAGS: ApproveFlags = { overrideChecks: false, commitDirty: false };

/** Add confirmations; never removes one. */
export function withApproveFlags(prev: ApproveFlags, add: Partial<ApproveFlags>): ApproveFlags {
  return {
    overrideChecks: prev.overrideChecks || !!add.overrideChecks,
    commitDirty: prev.commitDirty || !!add.commitDirty,
  };
}

/** The `approve_and_create_pr` options for these flags (only the set ones). */
export function approveOptions(flags: ApproveFlags): { overrideChecks?: true; commitDirty?: true } {
  return {
    ...(flags.overrideChecks ? { overrideChecks: true as const } : {}),
    ...(flags.commitDirty ? { commitDirty: true as const } : {}),
  };
}
