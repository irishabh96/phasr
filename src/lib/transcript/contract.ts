/**
 * The transcript contract (specs/agent-transcript-view-spec.md §4). The
 * types and commands live with the rest of the IPC surface in
 * `lib/types.ts` / `lib/tauri.ts` / `lib/events.ts`; this module re-exports
 * them under the names the transcript UI uses, plus small view helpers.
 */
import { tauri } from "@/lib/tauri";
import type { AgentView, TranscriptItem, Workspace } from "@/lib/types";

export type { AgentView, Suggestion, SuggestionsEvent, TranscriptEvent, TranscriptItem } from "@/lib/types";
export { SUGGESTIONS_EVENT, TRANSCRIPT_EVENT } from "@/lib/events";

export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
export type ToolStatus = ToolItem["status"];
export type TranscriptItemKind = TranscriptItem["kind"];

export const transcriptApi = {
  getTranscript: tauri.getTranscript,
  setAgentView: tauri.setAgentView,
  interruptTask: tauri.interruptTask,
  stopBackgroundShell: tauri.stopBackgroundShell,
  suggestReplies: tauri.suggestReplies,
};

/** `Workspace.agentView`: anything but "transcript" (null, missing) is the terminal. */
export function agentViewOf(workspace: Pick<Workspace, "agentView"> | null | undefined): AgentView {
  return workspace?.agentView === "transcript" ? "transcript" : "terminal";
}

/**
 * Phase 1: only Claude tasks in their own worktree have a transcript view
 * (the backend refuses in-place / local workspaces).
 */
export function canUseTranscript(
  workspace: Pick<Workspace, "agent" | "workspaceKind"> | null | undefined,
): boolean {
  return workspace?.workspaceKind === "agent" && workspace.agent === "claude";
}

/** Whether this task's agent pane shows the transcript. */
export function showsTranscript(workspace: Workspace | null | undefined): boolean {
  return canUseTranscript(workspace) && agentViewOf(workspace) === "transcript";
}
