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

/**
 * One subagent's own transcript, as its panel lays it out: the call's
 * direct items in order, and every nested subagent's items by call id (the
 * same `children` the main transcript nests with).
 */
export function subagentTree(items: readonly TranscriptItem[], callId: string): TranscriptTree {
  const { children } = groupTranscript(items);
  return { top: (children.get(callId) ?? []) as TranscriptItem[], children };
}

/**
 * Everything under a subagent call, in transcript order: its own items and,
 * recursively, those of the subagents it ran. Guards against a cycle.
 */
export function descendantsOf(items: readonly TranscriptItem[], callId: string): TranscriptItem[] {
  const under = new Set<string>([callId]);
  const out: TranscriptItem[] = [];
  // Children follow their parent in the transcript, so one pass in order
  // catches nested subagents whose call is itself a descendant.
  let grew = true;
  const taken = new Set<string>();
  while (grew) {
    grew = false;
    for (const item of items) {
      if (taken.has(item.id) || item.id === callId || !item.parentId || !under.has(item.parentId)) continue;
      taken.add(item.id);
      under.add(item.id);
      grew = true;
    }
  }
  for (const item of items) if (taken.has(item.id)) out.push(item);
  return out;
}

/** A subagent call is at work: its call runs, or it runs on in the background. */
export function isSubagentRunning(item: ToolItem): boolean {
  return item.status === "running" || item.backgroundStatus === "running";
}

/** Its steps: the larger of the CLI's count and the calls seen nested under it. */
export function subagentSteps(item: ToolItem, nested: readonly TranscriptItem[] | undefined): number {
  const own = nested ? nested.filter((c) => c.kind === "tool").length : 0;
  return Math.max(item.subagent?.steps ?? 0, own);
}

/** A background command's command line (its first line), else its title. */
export function commandOf(item: ToolItem): string {
  const input = item.input as { command?: unknown } | null | undefined;
  const command = typeof input?.command === "string" ? input.command.trim() : "";
  if (command) return command.split("\n")[0]!;
  return item.title.replace(/^Running /, "");
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
