import { useAllAgentLiveness } from "@/lib/agentLiveness";
import { deriveEpicIntegrable } from "@/lib/deriveEpicGate";
import { deriveNextGate, type NextGate } from "@/lib/deriveNextGate";
import {
  useBoard,
  useBoardGates,
  useIntegrateParent,
} from "@/lib/hooks/useBoard";
import { useGitBranchStatus } from "@/lib/hooks/useGit";
import { useRepository } from "@/lib/hooks/useRepositories";
import { useNow } from "@/lib/useNow";
import type { BoardState, Workspace } from "@/lib/types";

export interface EpicGateController {
  /** The single derived epic gate (Integrate → Ship) — the SAME `deriveNextGate` result the board header renders. */
  gate: NextGate;
  parentId: string;
  /** The parent workspace row — carries the integration branch; fed to `MergeToMainDialog` for Ship. */
  parentWorkspace: Workspace;
  integrable: boolean;
  integrated: boolean;
  shipped: boolean;
  baseBranch: string | undefined;
  pending: boolean;
  /** Fire Integrate via the EXISTING `integrate_parent` mutation (resolves the board / rejects on conflict). */
  integrate: () => Promise<BoardState>;
}

/**
 * The epic's gate controller — the derivation + Integrate dispatch mirrored from
 * `BoardParentHeader` so the ⌘K palette + the ⋯ menu read the SAME
 * `deriveNextGate` epic ladder and fire the SAME `integrate_parent` mutation.
 * Ship is intentionally NOT dispatched here: like the board header, Ship's
 * confirm IS `MergeToMainDialog` (strategy + conflict flow), so the command
 * surfaces open that dialog with {@link parentWorkspace} rather than a raw merge.
 *
 * Returns `null` until the board is loaded. Hooks run unconditionally; a `null`
 * `parentId` keeps every query disabled.
 */
export function useEpicGate(
  parentId: string | null | undefined,
): EpicGateController | null {
  const { data: board } = useBoard(parentId ?? undefined);
  const { data: gates } = useBoardGates(parentId ?? undefined);
  const { data: repository } = useRepository(board?.parent.repositoryId);
  const livenessMap = useAllAgentLiveness();

  // The parent carries an integration branch/worktree once integrated; only
  // then is its branch-vs-base status meaningful for "shipped" (mirrors the
  // board route's derivation exactly).
  const integrated = !!board?.parent.branch;
  const { data: parentBranch } = useGitBranchStatus(
    integrated ? (parentId ?? undefined) : undefined,
  );

  const integrateMutation = useIntegrateParent(parentId ?? "");

  // A stable read of the shared clock (no live ticker in a menu/palette).
  const now = useNow(false);

  if (!parentId || !board) return null;

  const shipped = integrated && parentBranch?.aheadOfTarget === 0;
  const integrable = deriveEpicIntegrable(board, gates?.reviews, livenessMap, now);

  const gate = deriveNextGate({
    kind: "epic",
    ticketCount: board.subtasks.length,
    integrable,
    integrated,
    shipped: !!shipped,
    ...(repository?.defaultBranch
      ? { baseBranch: repository.defaultBranch }
      : {}),
    // Autopilot rides on the already-fetched board DTO (`board.parent` is this
    // epic). Threading it downgrades the AUTO Integrate gate to neutral
    // "autopilot-driving" so the ⌘K palette matches the board header. Ship is
    // never downgraded (HUMAN-STOP). Off/absent ⇒ pre-autopilot ladder.
    autopilotEnabled: board.parent.autopilotEnabled,
  });

  return {
    gate,
    parentId,
    parentWorkspace: board.parent,
    integrable,
    integrated,
    shipped: !!shipped,
    baseBranch: repository?.defaultBranch,
    pending: integrateMutation.isPending,
    integrate: () => integrateMutation.mutateAsync(),
  };
}
