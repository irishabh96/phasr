import { listen } from "@tauri-apps/api/event";
import { notifyManager, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { createKeyedCoalescer } from "@/lib/coalesce";
import { TRANSCRIPT_EVENT, transcriptApi, type TranscriptEvent, type TranscriptItem } from "./contract";
import { applyTranscriptEvents } from "./reduce";

export const transcriptKeys = {
  all: ["transcript"] as const,
  task: (taskId: string) => [...transcriptKeys.all, taskId] as const,
};

/**
 * Events that arrived while a task's snapshot was loading, replayed over
 * it when it lands: the backend may emit between reading the JSONL and the
 * answer reaching us, and nothing else would ever resend those.
 */
const inFlight = new Map<string, TranscriptEvent[]>();

/** `get_transcript`, plus whatever arrived while it was in flight. Exported for tests. */
export async function loadTranscript(taskId: string): Promise<TranscriptItem[]> {
  const buffered: TranscriptEvent[] = [];
  inFlight.set(taskId, buffered);
  try {
    const items = await transcriptApi.getTranscript(taskId);
    return applyTranscriptEvents(items ?? [], buffered);
  } finally {
    if (inFlight.get(taskId) === buffered) inFlight.delete(taskId);
  }
}

/** Apply one coalesced batch to the cached transcripts. Exported for tests. */
export function applyTranscriptBatch(queryClient: QueryClient, events: Iterable<TranscriptEvent>): void {
  const byTask = new Map<string, TranscriptEvent[]>();
  for (const e of events) {
    let list = byTask.get(e.taskId);
    if (!list) byTask.set(e.taskId, (list = []));
    list.push(e);
  }
  notifyManager.batch(() => {
    for (const [taskId, list] of byTask) {
      inFlight.get(taskId)?.push(...list);
      // Only a transcript someone has loaded: one that isn't cached loads
      // whole from the backend when it's first shown.
      if (queryClient.getQueryData(transcriptKeys.task(taskId)) === undefined) continue;
      queryClient.setQueryData<TranscriptItem[]>(transcriptKeys.task(taskId), (prev) =>
        applyTranscriptEvents(prev, list),
      );
    }
  });
}

/**
 * Keep every cached transcript live. Mounted ONCE (by `useAppEvents`), so a
 * transcript you switched away from is still current when you come back.
 *
 * Coalesced to ≤ 30 Hz per item (`lib/coalesce.ts`): a streaming reply
 * updates its item on every delta, and only the latest state of each item
 * in a window matters.
 */
export function useTranscriptEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    const events = createKeyedCoalescer<TranscriptEvent>((batch) => applyTranscriptBatch(queryClient, batch.values()));
    void listen<TranscriptEvent>(TRANSCRIPT_EVENT, (event) => {
      const e = event.payload;
      if (!e?.taskId || !e.item?.id) return;
      events.push(`${e.taskId}\u0000${e.item.id}`, e);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
      events.flush();
      events.dispose();
    };
  }, [queryClient]);
}

/**
 * One task's transcript: the persisted snapshot, then live events. Kept in
 * the query cache by task, so switching tasks and back renders at once.
 * `enabled: false` (a terminal-view task) never loads it.
 */
export function useTranscript(taskId: string, enabled = true) {
  return useQuery({
    queryKey: transcriptKeys.task(taskId),
    queryFn: () => loadTranscript(taskId),
    enabled,
    // Events keep it current (`useTranscriptEvents`).
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });
}
