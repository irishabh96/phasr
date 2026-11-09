import type { BranchStatus, Repository, Workspace } from "@/lib/types";

/**
 * The branch a task merges into (and syncs from): its base, not the
 * repository's default. `git_branch_status` reports it as `baseBranch`;
 * an older backend omits it, so fall back to the task's recorded base,
 * then the repository default.
 */
export function mergeTargetBranch(
  status: Pick<BranchStatus, "baseBranch"> | null | undefined,
  workspace: Pick<Workspace, "baseBranch"> | null | undefined,
  repository: Pick<Repository, "defaultBranch"> | null | undefined,
): string {
  const fromStatus = (status as { baseBranch?: unknown } | null | undefined)?.baseBranch;
  if (typeof fromStatus === "string" && fromStatus.trim()) return fromStatus;
  if (workspace?.baseBranch) return workspace.baseBranch;
  return repository?.defaultBranch || "main";
}
