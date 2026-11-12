import type { TranscriptEvent, TranscriptItem } from "./contract";

/**
 * Fold `phasr://transcript` events into a transcript, by `item.id`.
 *
 * Every event carries the item's full current state, so applying one is a
 * replace-by-id. Delivery isn't assumed to be orderly:
 *
 *  - an `update` for an id we haven't seen is an append (its `append` was
 *    coalesced away, or fell between a snapshot and the listener);
 *  - an `append` for an id we already hold is an update (the snapshot
 *    already had it);
 *  - an update never moves an item backwards: a finished tool stays
 *    finished, a background command that ended stays ended, a finished
 *    assistant message stops streaming for good, and a stale streaming
 *    delta can't shorten the text already shown.
 *
 * Returns `items` itself when nothing changed, so a no-op batch doesn't
 * re-render anything.
 */
export function applyTranscriptEvents(
  items: readonly TranscriptItem[] | undefined,
  events: Iterable<Pick<TranscriptEvent, "op" | "item">>,
): TranscriptItem[] {
  const base = (items ?? []) as TranscriptItem[];
  let out: TranscriptItem[] | null = null;
  for (const { item } of events) {
    const list: TranscriptItem[] = out ?? base;
    // Updates land near the end almost always: search backwards.
    let i = -1;
    for (let j = list.length - 1; j >= 0; j--) {
      if (list[j]!.id === item.id) {
        i = j;
        break;
      }
    }
    if (i === -1) {
      out ??= base.slice();
      out.push(item);
      continue;
    }
    const merged = mergeItem(list[i]!, item);
    if (merged === list[i]) continue;
    out ??= base.slice();
    out[i] = merged;
  }
  return out ?? base;
}

const SETTLED = new Set(["done", "error", "denied"]);

/** `next` unless it would move `prev` backwards. */
export function mergeItem(prev: TranscriptItem, next: TranscriptItem): TranscriptItem {
  if (prev === next) return prev;
  if (prev.kind === "tool" && next.kind === "tool") {
    if (SETTLED.has(prev.status) && next.status === "running") return prev;
    // A live output tail (a coalesced, unpersisted update) landing after
    // the command's final state.
    if (prev.backgroundStatus && prev.backgroundStatus !== "running" && next.backgroundStatus === "running") return prev;
  }
  if (prev.kind === "assistant" && next.kind === "assistant") {
    if (!prev.streaming && next.streaming) return prev;
    if (next.streaming && next.text.length < prev.text.length && prev.text.startsWith(next.text)) return prev;
  }
  return next;
}
