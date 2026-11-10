import { create } from "zustand";

/**
 * "Show me this item": a Running chip (or the subagent panel's "Show in
 * transcript") asks its task's transcript to scroll to an item, open the
 * subagent groups around it and highlight it briefly. `expand` (the
 * default) also opens the item itself: a command's output, a subagent's
 * group. `nonce` makes a second click on the same chip a new request.
 */
export interface FocusRequest {
  taskId: string;
  itemId: string;
  nonce: number;
  expand: boolean;
}

interface TranscriptFocusState {
  request: FocusRequest | null;
  focus: (taskId: string, itemId: string, opts?: { expand?: boolean }) => void;
}

let seq = 0;

export const useTranscriptFocus = create<TranscriptFocusState>((set) => ({
  request: null,
  focus: (taskId, itemId, opts) => set({ request: { taskId, itemId, nonce: ++seq, expand: opts?.expand ?? true } }),
}));
