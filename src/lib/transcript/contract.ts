/**
 * The transcript contract (specs/agent-transcript-view-spec.md §4), held
 * here until it folds into `lib/types.ts` / `lib/tauri.ts` (those two files
 * belong to the backend change landing in parallel).
 *
 * Everything below mirrors §4 verbatim. Where §4 is silent the choice is
 * marked ASSUMPTION so the merge can check it against the Rust side.
 */
import { invoke } from "@tauri-apps/api/core";
import type { Workspace } from "@/lib/types";

/** Phasr's normalized transcript item. Raw CLI events never reach the UI. */
export type TranscriptItem =
  | { kind: "user"; id: string; ts: string; text: string }
  | { kind: "assistant"; id: string; ts: string; text: string; streaming: boolean }
  | { kind: "thinking"; id: string; ts: string; text: string; durationMs?: number }
  | {
      kind: "tool";
      /** The tool_use id. */
      id: string;
      ts: string;
      tool: string;
      input: unknown;
      /** e.g. "Editing src/a.ts". */
      title: string;
      status: ToolStatus;
      output?: string;
      outputTruncated?: boolean;
    }
  | { kind: "result"; id: string; ts: string; durationMs: number; costUsd: number | null; isError: boolean }
  | { kind: "system"; id: string; ts: string; level: "info" | "error"; text: string };

export type ToolStatus = "running" | "done" | "error" | "denied";
export type TranscriptItemKind = TranscriptItem["kind"];
export type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** Payload of `phasr://transcript`. */
export interface TranscriptEvent {
  taskId: string;
  op: "append" | "update";
  item: TranscriptItem;
}

/** ASSUMPTION: the event name follows the `phasr://` family in `lib/events.ts`. */
export const TRANSCRIPT_EVENT = "phasr://transcript";

export type AgentView = "transcript" | "terminal";

/**
 * Commands. ASSUMPTIONS: camelCase argument names (Tauri's default
 * conversion, as every other command in `lib/tauri.ts`), `view` is the
 * bare string, `interrupt_task` resolves to nothing.
 */
export const transcriptApi = {
  /** The full persisted transcript, oldest first. */
  getTranscript: (taskId: string) => invoke<TranscriptItem[]>("get_transcript", { taskId }),
  /** Switch the view (and the process). Rejects e.g. while a turn runs. */
  setAgentView: (taskId: string, view: AgentView) => invoke<Workspace>("set_agent_view", { taskId, view }),
  /** Interrupt the current turn without ending the session. */
  interruptTask: (taskId: string) => invoke<void>("interrupt_task", { taskId }),
};

/**
 * `Workspace.agentView`, read without depending on the field existing yet:
 * anything other than "transcript" (null, missing, unknown) is the
 * terminal, as §4 defines null.
 */
export function agentViewOf(workspace: Pick<Workspace, "id"> | null | undefined): AgentView {
  const raw = (workspace as { agentView?: unknown } | null | undefined)?.agentView;
  return raw === "transcript" ? "transcript" : "terminal";
}

/** Phase 1: only Claude tasks have a transcript view (spec §2). */
export function canUseTranscript(workspace: Pick<Workspace, "agent" | "workspaceKind"> | null | undefined): boolean {
  return workspace?.workspaceKind === "agent" && workspace.agent === "claude";
}

/** Whether this task's agent pane shows the transcript. */
export function showsTranscript(workspace: Workspace | null | undefined): boolean {
  return canUseTranscript(workspace) && agentViewOf(workspace) === "transcript";
}
