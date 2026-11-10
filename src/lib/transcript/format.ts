/**
 * Pure helpers behind the transcript's item renderers: the inline −/+ diff
 * an edit tool's input describes, a command's output tail, and the quiet
 * formatting of times, durations and cost.
 */

export type InlineDiffLine =
  | { kind: "add" | "remove" | "context"; text: string }
  /** Between two edits of a MultiEdit. */
  | { kind: "gap"; text: "" };

export interface InlineDiff {
  lines: InlineDiffLine[];
  adds: number;
  removes: number;
}

/** Tools whose input carries the edit itself. */
export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write"]);
/** Tools shown as one compact line (their output stays out of the way). */
export const COMPACT_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "LS", "NotebookRead", "TodoWrite"]);

/** Above this many cells the line diff falls back to "all removed, all added". */
const LCS_CELL_LIMIT = 250_000;

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.replace(/\r\n?/g, "\n").split("\n");
  // A trailing newline isn't a line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A line diff of `before` → `after`: shared leading/trailing lines are
 * context, the middle is diffed by LCS (small inputs; edits are snippets).
 */
export function lineDiff(before: string, after: string): InlineDiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: InlineDiffLine[] = a.slice(0, start).map((text) => ({ kind: "context", text }));
  const tail: InlineDiffLine[] = a.slice(endA).map((text) => ({ kind: "context", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...diffMiddle(midA, midB), ...tail];
}

function diffMiddle(a: string[], b: string[]): InlineDiffLine[] {
  if (a.length === 0) return b.map((text) => ({ kind: "add", text }));
  if (b.length === 0) return a.map((text) => ({ kind: "remove", text }));
  if (a.length * b.length > LCS_CELL_LIMIT) {
    return [...a.map((text) => ({ kind: "remove" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  // LCS table, then walk it; removals print before additions in a run.
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
    }
  }
  const out: InlineDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "context", text: a[i]! });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
      out.push({ kind: "remove", text: a[i++]! });
    } else {
      out.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < n) out.push({ kind: "remove", text: a[i++]! });
  while (j < m) out.push({ kind: "add", text: b[j++]! });
  return out;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function count(lines: InlineDiffLine[]): InlineDiff {
  let adds = 0;
  let removes = 0;
  for (const l of lines) {
    if (l.kind === "add") adds++;
    else if (l.kind === "remove") removes++;
  }
  return { lines, adds, removes };
}

/**
 * The diff an Edit / MultiEdit / Write call describes, from its `input`
 * (Claude Code's tool schemas: `old_string`/`new_string`, `edits[]`,
 * `content`). `null` for any other tool or an input that doesn't parse.
 */
export function diffFromToolInput(tool: string, input: unknown): InlineDiff | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (tool === "Edit") {
    const before = str(o.old_string);
    const after = str(o.new_string);
    if (before === null || after === null) return null;
    return count(lineDiff(before, after));
  }
  if (tool === "MultiEdit") {
    if (!Array.isArray(o.edits)) return null;
    const lines: InlineDiffLine[] = [];
    for (const e of o.edits) {
      if (!e || typeof e !== "object") continue;
      const before = str((e as Record<string, unknown>).old_string);
      const after = str((e as Record<string, unknown>).new_string);
      if (before === null || after === null) continue;
      if (lines.length > 0) lines.push({ kind: "gap", text: "" });
      lines.push(...lineDiff(before, after));
    }
    return lines.length > 0 ? count(lines) : null;
  }
  if (tool === "Write") {
    const content = str(o.content);
    if (content === null) return null;
    return count(splitLines(content).map((text) => ({ kind: "add", text })));
  }
  return null;
}

/** ESC sequences (colour, cursor) a command may print. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Output lines with ANSI stripped, carriage-return overwrites resolved
 *  and trailing blank lines dropped. */
export function outputLines(output: string | null | undefined): string[] {
  if (!output) return [];
  const lines = stripAnsi(output)
    .replace(/\r\n/g, "\n")
    .split("\n")
    // A progress bar redraws with \r: keep what was left on screen.
    .map((l) => (l.includes("\r") ? (l.split("\r").filter(Boolean).pop() ?? "") : l));
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}

/** The last `n` lines, and how many were left out above them. */
export function outputTail(output: string | null | undefined, n = 12): { lines: string[]; hidden: number; total: number } {
  const all = outputLines(output);
  const lines = all.length > n ? all.slice(all.length - n) : all;
  return { lines, hidden: all.length - lines.length, total: all.length };
}

/** "Editing src/a.ts" → the verb and what it acts on (drawn brighter). */
export function splitTitle(title: string): { verb: string; object: string } {
  const t = title.trim();
  const i = t.indexOf(" ");
  if (i === -1) return { verb: t, object: "" };
  return { verb: t.slice(0, i), object: t.slice(i + 1) };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local `HH:MM:SS`; empty for an unreadable timestamp. */
export function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 0.4s · 23s · 4m 12s · 1h 3m. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** $0.04; `null` hides the cost (agents that don't report it). */
export function formatCost(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** "Done in 23s · $0.04". */
export function formatResult(r: { durationMs: number; costUsd: number | null; isError: boolean }): string {
  const cost = formatCost(r.costUsd);
  const head = `${r.isError ? "Stopped after" : "Done in"} ${formatDuration(r.durationMs)}`;
  return cost ? `${head} · ${cost}` : head;
}

/** "Thought for 4s"; "Thought" when the backend had no duration. */
export function formatThought(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return "Thought";
  return `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s`;
}
