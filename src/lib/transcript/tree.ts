import type { BackgroundStatus } from "@/lib/types";
import type { ToolItem, TranscriptItem } from "./contract";

/**
 * The transcript as the UI lays it out: the main conversation in order,
 * and each subagent call's own items under it (by `parentId`, which is the
 * call's tool_use id). Subagents can nest, so a child can itself be a call
 * with children.
 */
export interface TranscriptTree {
  /** The main conversation, in order. */
  top: TranscriptItem[];
  /** A subagent call's own items, in order, by the call's id. */
  children: ReadonlyMap<string, readonly TranscriptItem[]>;
}

const NO_CHILDREN: ReadonlyMap<string, readonly TranscriptItem[]> = new Map();

/**
 * Group `items` by `parentId`. An item whose parent isn't in the list (cut
 * off by the backend's newest-5000 window) stays in the main conversation
 * rather than vanish. A transcript with no subagents returns `items` itself
 * as `top`.
 */
export function groupTranscript(items: readonly TranscriptItem[]): TranscriptTree {
  if (!items.some((i) => i.parentId)) return { top: items as TranscriptItem[], children: NO_CHILDREN };
  const ids = new Set(items.map((i) => i.id));
  const top: TranscriptItem[] = [];
  const children = new Map<string, TranscriptItem[]>();
  for (const item of items) {
    const parent = item.parentId;
    if (!parent || parent === item.id || !ids.has(parent)) {
      top.push(item);
      continue;
    }
    let list = children.get(parent);
    if (!list) children.set(parent, (list = []));
    list.push(item);
  }
  return { top, children };
}

/**
 * The ids from `id`'s top-level ancestor down to `id`'s parent (empty for a
 * top-level item): the subagent groups to open to show it. Stops on a
 * cycle or a missing parent.
 */
export function ancestorsOf(items: readonly TranscriptItem[], id: string): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const chain: string[] = [];
  const seen = new Set<string>([id]);
  let parent = byId.get(id)?.parentId;
  while (parent && byId.has(parent) && !seen.has(parent)) {
    chain.unshift(parent);
    seen.add(parent);
    parent = byId.get(parent)?.parentId;
  }
  return chain;
}

export function isBackgroundRunning(item: TranscriptItem): item is ToolItem {
  return item.kind === "tool" && item.background === true && item.backgroundStatus === "running";
}

/** One chip of the Background strip. */
export interface BackgroundShell {
  /** The Bash tool item's id (its tool_use id). */
  id: string;
  command: string;
  /** When the call started (the item's `ts`). */
  startedAt: string;
  status: BackgroundStatus;
}

function commandOf(item: ToolItem): string {
  const input = item.input as { command?: unknown } | null | undefined;
  const command = typeof input?.command === "string" ? input.command.trim() : "";
  if (command) return command.split("\n")[0]!;
  return item.title.replace(/^Running /, "");
}

/** Background commands still running, in the order they started. */
export function runningBackgroundShells(items: readonly TranscriptItem[]): BackgroundShell[] {
  const out: BackgroundShell[] = [];
  for (const item of items) {
    if (!isBackgroundRunning(item)) continue;
    out.push({ id: item.id, command: commandOf(item), startedAt: item.ts, status: "running" });
  }
  return out;
}

/** "12s" / "4m 3s" / "1h 2m" since `startedAt`; empty for a bad timestamp. */
export function formatElapsed(startedAt: string, now: number): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "";
  const s = Math.max(0, Math.floor((now - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
