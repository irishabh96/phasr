import { create } from "zustand";

/**
 * "Show me this item": a Background chip asks its task's transcript to
 * scroll to a tool item, open the subagent groups around it and expand its
 * output. `nonce` makes a second click on the same chip a new request.
 */
export interface FocusRequest {
  taskId: string;
  itemId: string;
  nonce: number;
}

interface TranscriptFocusState {
  request: FocusRequest | null;
  focus: (taskId: string, itemId: string) => void;
}

let seq = 0;

export const useTranscriptFocus = create<TranscriptFocusState>((set) => ({
  request: null,
  focus: (taskId, itemId) => set({ request: { taskId, itemId, nonce: ++seq } }),
}));
