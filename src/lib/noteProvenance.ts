import type { InnerTab, RepoInnerTab } from "@/lib/store";
import type { NoteOriginKind } from "@/lib/types";

/** The origin fields `create_note` wants (label hint is display-only —
 *  the backend resolves the workspace NAME itself and never trusts it). */
export interface NoteOrigin {
  originKind: NoteOriginKind;
  originWorkspaceId?: string | null;
  originTerminalId?: string | null;
  originLabelHint?: string | null;
}

/**
 * Provenance for a note created from a WORKSPACE surface, derived from
 * the active inner tab. Pure — tested directly.
 */
export function originFromWorkspace(
  workspaceId: string,
  activeTab: InnerTab | undefined,
): NoteOrigin {
  if (activeTab?.kind === "terminal") {
    return {
      originKind: "terminal",
      originWorkspaceId: workspaceId,
      originTerminalId: activeTab.ptySessionId ?? null,
      originLabelHint: activeTab.title,
    };
  }
  // Main (agent) tab, preview tab, or no tab info — the note comes from
  // the workspace itself.
  return {
    originKind: "workspace",
    originWorkspaceId: workspaceId,
    originLabelHint: activeTab?.kind === "main" ? "Agent" : null,
  };
}

/**
 * Provenance for a note created from the REPO-HOME surface (no
 * workspace). A repo-home terminal tab is still `terminal`-origin, just
 * with no workspace attached.
 */
export function originFromRepoHome(
  activeTab: RepoInnerTab | undefined,
): NoteOrigin {
  if (activeTab?.kind === "terminal") {
    return {
      originKind: "terminal",
      originTerminalId: activeTab.ptySessionId ?? null,
      originLabelHint: activeTab.title,
    };
  }
  return { originKind: "repository" };
}
