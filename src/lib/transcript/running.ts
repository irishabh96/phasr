import type { ToolItem, TranscriptItem } from "./contract";
import { commandOf, isSubagentRunning, subagentSteps } from "./tree";

/**
 * The "Running" strip above the composer (transcript view): one chip per
 * subagent at work and per background command, derived from the
 * transcript. A chip that finishes shows its end state for a moment
 * (`LINGER_MS`), then drops off, unless it's pinned; a pinned one stays
 * until unpinned or dismissed.
 */

/** How long a finished chip keeps showing its end state. */
export const LINGER_MS = 4000;

export type ChipStatus = "running" | "done" | "failed" | "stopped";

/** What the transcript says a chip is, before pins and the linger. */
export interface ChipSource {
  kind: "subagent" | "shell";
  /** The tool item's id (the `Agent` / `Bash` tool_use id). */
  id: string;
  /** A subagent's description; a command's first line. */
  label: string;
  /** When the call started (the item's `ts`). */
  startedAt: string;
  status: ChipStatus;
  /** A subagent's steps so far (0 for a command). */
  steps: number;
  /** A subagent's type ("general-purpose", "Explore"). */
  agentType?: string;
}

export interface RunningChip extends ChipSource {
  pinned: boolean;
  /** When it was seen to finish (epoch ms), if it was. */
  endedAt?: number;
}

function subagentStatus(item: ToolItem): ChipStatus {
  if (isSubagentRunning(item)) return "running";
  if (item.status === "done") return "done";
  return item.status === "denied" ? "stopped" : "failed";
}

function shellStatus(item: ToolItem): ChipStatus {
  switch (item.backgroundStatus) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

/**
 * Every subagent call (nested ones too) and every background command in
 * the transcript, in the order they started.
 */
export function chipSources(items: readonly TranscriptItem[]): ChipSource[] {
  const nested = new Map<string, TranscriptItem[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    let list = nested.get(item.parentId);
    if (!list) nested.set(item.parentId, (list = []));
    list.push(item);
  }
  const out: ChipSource[] = [];
  for (const item of items) {
    if (item.kind !== "tool") continue;
    if (item.subagent) {
      const description = item.subagent.description.trim() || item.title.replace(/^Running a subagent:\s*/, "");
      out.push({
        kind: "subagent",
        id: item.id,
        label: description,
        startedAt: item.ts,
        status: subagentStatus(item),
        steps: subagentSteps(item, nested.get(item.id)),
        ...(item.subagent.type ? { agentType: item.subagent.type } : {}),
      });
    } else if (item.background && item.backgroundStatus) {
      out.push({ kind: "shell", id: item.id, label: commandOf(item), startedAt: item.ts, status: shellStatus(item), steps: 0 });
    }
  }
  return out;
}

/**
 * What the strip has seen: the chips it saw running, and when each of
 * those was seen to finish. A chip that was already over when first seen
 * (a reload, a long-gone command) never lingers.
 */
export interface EndTracker {
  running: ReadonlySet<string>;
  ended: ReadonlyMap<string, number>;
}

export const NO_ENDS: EndTracker = { running: new Set(), ended: new Map() };

/** Note the chips that finished since `prev`. Returns `prev` when nothing did. */
export function noteEnds(prev: EndTracker, sources: readonly ChipSource[], now: number): EndTracker {
  let running: Set<string> | null = null;
  let ended: Map<string, number> | null = null;
  for (const s of sources) {
    if (s.status === "running") {
      if (!prev.running.has(s.id)) (running ??= new Set(prev.running)).add(s.id);
    } else if (prev.running.has(s.id) && !prev.ended.has(s.id)) {
      (ended ??= new Map(prev.ended)).set(s.id, now);
    }
  }
  if (!running && !ended) return prev;
  return { running: running ?? prev.running, ended: ended ?? prev.ended };
}

/** A chip finished within the last `LINGER_MS`. */
export function isLingering(endedAt: number | undefined, now: number): boolean {
  return endedAt !== undefined && now - endedAt < LINGER_MS;
}

/**
 * The strip's chips: everything running, a finished chip for `LINGER_MS`
 * after it was seen to finish, and pinned chips until they're unpinned or
 * dismissed. A dismissed chip never comes back (ids are unique).
 */
export function deriveRunningChips(
  sources: readonly ChipSource[],
  opts: { now: number; ended: ReadonlyMap<string, number>; pinned: ReadonlySet<string>; dismissed: ReadonlySet<string> },
): RunningChip[] {
  const out: RunningChip[] = [];
  for (const s of sources) {
    const pinned = opts.pinned.has(s.id);
    const endedAt = opts.ended.get(s.id);
    const show =
      s.status === "running" ||
      (!opts.dismissed.has(s.id) && (pinned || isLingering(endedAt, opts.now)));
    if (!show) continue;
    out.push({ ...s, pinned, ...(endedAt !== undefined ? { endedAt } : {}) });
  }
  return out;
}

/**
 * How many chips fit in `available` px, each `widths[i]` wide with `gap`
 * between them. When not all fit, room is kept for the "+N" button
 * (`more` px, its gap included). Unmeasured (`available <= 0`, e.g. not
 * laid out yet) shows them all.
 */
export function fitCount(widths: readonly number[], available: number, gap: number, more: number): number {
  if (available <= 0) return widths.length;
  const total = widths.reduce((sum, w) => sum + w, 0) + Math.max(0, widths.length - 1) * gap;
  if (total <= available) return widths.length;
  let used = 0;
  let n = 0;
  for (const w of widths) {
    const next = used + (n > 0 ? gap : 0) + w;
    if (next + more > available) break;
    used = next;
    n++;
  }
  return n;
}
