import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TaskAgentState } from "@/lib/types";
import { SUGGESTIONS_EVENT, transcriptApi, type SuggestionsEvent } from "./contract";
import { endedTurn, heuristicSuggestions, sanitizeSuggestions, type ReplyChip } from "./suggest";
import { useSuggestReplies } from "./suggestPref";
import { useTranscript } from "./useTranscript";

export interface ReplySuggestions {
  /** What the chip row shows: the backend's once they land, else the heuristics. */
  chips: ReplyChip[];
  /** The backend's are still coming (the row may show a shimmer chip). */
  pending: boolean;
}

/**
 * The composer's reply chips for a transcript-view task (`active`), for the
 * turn that ended last. The conversation's own suggestions show at once;
 * with "Suggest replies" on, the task's `suggest_replies` (one Haiku call
 * per turn, cached by the backend) replaces them when it answers or when
 * `phasr://suggestions` says they're ready. Off: no call, no listener.
 */
export function useReplySuggestions(
  taskId: string,
  active: boolean,
  state: TaskAgentState["state"] | null | undefined,
): ReplySuggestions {
  const enabled = useSuggestReplies();
  const { data: items } = useTranscript(taskId, active);
  const turn = useMemo(() => (active && items ? endedTurn(items) : null), [active, items]);
  const heuristic = useMemo(() => heuristicSuggestions(turn), [turn]);
  const turnId = turn?.turnId ?? null;
  // Not while a turn runs, nor while an approval is up.
  const between = state !== "working" && state !== "needs-you";
  const [remote, setRemote] = useState<{ turnId: string; chips: ReplyChip[] } | null>(null);

  useEffect(() => {
    if (!active || !enabled) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<SuggestionsEvent>(SUGGESTIONS_EVENT, (event) => {
      const e = event.payload;
      if (e?.taskId !== taskId || !e.turnId) return;
      setRemote({ turnId: e.turnId, chips: sanitizeSuggestions(e.suggestions) });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, enabled, taskId]);

  // Once per ended turn: the backend answers from its cache, joins a call
  // in flight, or makes the one call.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !enabled || !turnId || !between || asked.current === turnId) return;
    asked.current = turnId;
    transcriptApi.suggestReplies(taskId).then(
      (list) =>
        setRemote((prev) =>
          // An event may have brought these (or more) already.
          prev?.turnId === turnId && prev.chips.length ? prev : { turnId, chips: sanitizeSuggestions(list) },
        ),
      () => setRemote((prev) => (prev?.turnId === turnId ? prev : { turnId, chips: [] })),
    );
  }, [active, enabled, taskId, turnId, between]);

  if (!turnId || !between) return { chips: [], pending: false };
  const fresh = enabled && remote?.turnId === turnId ? remote : null;
  return {
    chips: fresh?.chips.length ? fresh.chips : heuristic,
    pending: enabled && !fresh,
  };
}
