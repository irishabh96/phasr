/**
 * Reply suggestions for transcript view: the chips under the composer once
 * a turn ends. Pure: what the conversation itself suggests, instantly (the
 * heuristics below), and the guards for what the backend sends
 * (`suggest_replies`, `phasr://suggestions`: native or generated), which
 * replace them when they land.
 *
 * Static filler is worse than nothing: no rule matches → no chips.
 */
import type { Suggestion, TranscriptItem } from "@/lib/types";

export type ReplySource = Suggestion["source"] | "heuristic";

/** One chip: `label` on the chip, `text` into the composer when clicked. */
export interface ReplyChip {
  label: string;
  text: string;
  source: ReplySource;
}

export const MAX_CHIPS = 3;
export const MAX_LABEL = 40;
export const MAX_TEXT = 500;

/** The turn that ended last: everything between the previous result and its own. */
export interface EndedTurn {
  /** Its `result` item's id (the backend's `turnId`). */
  turnId: string;
  items: TranscriptItem[];
  /** Its last assistant text in the main conversation. */
  lastText: string | null;
  isError: boolean;
  interrupted: boolean;
}

const isTopResult = (i: TranscriptItem) => i.kind === "result" && !i.parentId;

/**
 * The turn that ended last, or `null` while one runs (a message was sent
 * after the last result) or before any ended. Mirrors the backend's
 * `suggest::turn_context`.
 */
export function endedTurn(items: readonly TranscriptItem[]): EndedTurn | null {
  const end = lastIndex(items, isTopResult);
  const result = items[end];
  if (result?.kind !== "result") return null;
  if (items.slice(end + 1).some((i) => i.kind === "user" && !i.parentId)) return null;
  const turn = items.slice(lastIndex(items.slice(0, end), isTopResult) + 1, end);
  const last = turn[lastIndex(turn, (i) => i.kind === "assistant" && !i.parentId && !!i.text.trim())];
  return {
    turnId: result.id,
    items: turn,
    lastText: last?.kind === "assistant" ? last.text : null,
    isError: result.isError,
    interrupted: turn.some((i) => i.kind === "system" && i.level === "info" && i.text === "Interrupted"),
  };
}

function lastIndex<T>(list: readonly T[], match: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (match(list[i] as T)) return i;
  return -1;
}

// ── text helpers ────────────────────────────────────────────────────────

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Markdown off: bold/italic markers, inline code ticks, links to their text. */
function plain(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** One line, no wrapping quotes or trailing punctuation, ≤ `MAX_LABEL` (cut on a word, ellipsised). */
export function clampLabel(label: string): string {
  const one = label.replace(/\s+/g, " ").replace(/^["'`\s]+/, "").replace(/["'`\s.,;:!?]+$/, "");
  if (one.length <= MAX_LABEL) return one;
  const cut = one.slice(0, MAX_LABEL - 1);
  const space = cut.lastIndexOf(" ");
  const head = space >= MAX_LABEL / 2 ? cut.slice(0, space) : cut;
  return `${head.replace(/[,;:\s]+$/, "")}…`;
}

function chip(text: string, label = text): ReplyChip {
  return { label: clampLabel(capitalize(label)), text: capitalize(text.trim()), source: "heuristic" };
}

// ── options the agent offered ───────────────────────────────────────────

/** "Want me to …" / "Should I …": what follows is already an imperative. */
const OFFER =
  /^(?:(?:so|ok(?:ay)?|alternatively),?\s+)?(?:do you want me to|would you like me to|would you prefer (?:that )?i|want me to|should i|shall i|should we|shall we|i can either|i can|or should i|let me know if you(?:'d like| want) me to)\s+(.+)$/i;
const DETERMINER = /^(?:the|a|an|this|that|these|those|my|your|our)\s/i;

/** The last sentence of `paragraph` (its question, if it ends with one). */
function lastSentence(paragraph: string): string {
  const sentences = paragraph.split(/(?<=[.!?])\s+(?=\S)/);
  return sentences[sentences.length - 1] ?? "";
}

/**
 * Two alternatives where the second is only a noun phrase ("tests for
 * login or signup", "update the README or the changelog") become two full
 * clauses ("add tests for signup", "update the changelog").
 */
function expandAlternative(left: string, right: string): string {
  const det = right.match(DETERMINER)?.[0].trim().toLowerCase();
  if (det) {
    const at = left.toLowerCase().lastIndexOf(` ${det} `);
    if (at !== -1) return `${left.slice(0, at)} ${right}`;
  }
  if (!/\s/.test(right)) {
    const at = left.lastIndexOf(" ");
    if (at !== -1) return `${left.slice(0, at)} ${right}`;
  }
  return right;
}

/** The clauses of an offer's body: "A, B, or C" / "A or B" / just "A". */
function splitOptions(body: string): string[] {
  const parts = body.split(/,\s*or\s+|,\s+(?=\S)/);
  if (parts.length > 1 && /,\s*or\s+/.test(body)) return parts;
  const or = body.lastIndexOf(" or ");
  if (or === -1) return [body];
  const left = body.slice(0, or);
  const right = body.slice(or + 4);
  // "… or not" / "… or anything else": a yes/no question, not two options.
  if (/^(?:not|something else|anything else|both)\b/i.test(right)) return [left];
  const isClause = right.trim().split(/\s+/).length >= 2 && !DETERMINER.test(right);
  return [left, isClause ? right : expandAlternative(left, right)];
}

function questionOptions(text: string): string[] {
  const paragraphs = text.trim().split(/\n\s*\n/);
  const last = (paragraphs[paragraphs.length - 1] ?? "").replace(/\s+/g, " ").trim();
  const sentence = plain(lastSentence(last));
  const isQuestion = sentence.endsWith("?");
  const isLetMeKnow = /^let me know if you/i.test(sentence);
  if (!isQuestion && !isLetMeKnow) return [];
  const body = sentence.replace(/[?.!]+$/, "").match(OFFER)?.[1];
  if (!body) return [];
  return (
    splitOptions(body)
      .map((o) => o.trim().replace(/^(?:to|i)\s+/i, ""))
      // "…, or is this good to go?": the other branch is a question back, not a reply.
      .filter((o) => o.length > 1 && !/^(?:is|are|does|do|did|was|were|will|would|anything)\b/i.test(o))
  );
}

const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+(.+)$/;

/**
 * A numbered or bulleted list at the end, asked about: the line before it
 * or the line after it is a question ("Which would you prefer?").
 */
function listOptions(text: string): ReplyChip[] {
  const lines = text.trim().split("\n");
  const line = (i: number) => lines[i] ?? "";
  let end = lines.length - 1;
  let trailing = "";
  // One short paragraph after the list may hold the question.
  if (!LIST_ITEM.test(line(end))) {
    while (end >= 0 && line(end).trim() && !LIST_ITEM.test(line(end))) end--;
    trailing = lines.slice(end + 1).join(" ");
    while (end >= 0 && !line(end).trim()) end--;
  }
  let start = end;
  while (start >= 0 && LIST_ITEM.test(line(start))) start--;
  const items = lines.slice(start + 1, end + 1).map((l) => l.match(LIST_ITEM)?.[1] ?? "");
  if (items.length < 2) return [];
  if (!line(start).trim().endsWith("?") && !trailing.trim().endsWith("?")) return [];
  return items.slice(0, MAX_CHIPS).map((raw) => {
    const full = plain(raw);
    // "**Title** – detail": the title is the label.
    const title = raw.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)/)?.[1];
    const head = title ?? full.split(/\s+[–—-]\s+|:\s+/)[0] ?? full;
    return chip(full.replace(/[.;]$/, ""), plain(head));
  });
}

// ── what happened in the turn ───────────────────────────────────────────

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** A test run, by its command line (`pnpm test`, `cargo test`, `pytest`, `npx vitest`, `rspec`). */
export function isTestCommand(command: string): boolean {
  return /test|jest|rspec|mocha|playwright/i.test(command);
}

function bashCommand(item: TranscriptItem): string | null {
  if (item.kind !== "tool" || item.tool !== "Bash") return null;
  const command = (item.input as { command?: unknown } | null)?.command;
  return typeof command === "string" ? command : null;
}

/**
 * What the conversation itself suggests next, in priority order:
 * - the options the agent's closing question offered;
 * - "Fix the failing tests" when a test run failed and none passed since;
 * - "Run the tests" when files changed and no test ran after the last edit;
 * - "Continue" after an interrupt, "Try again" after a failed turn.
 */
export function heuristicSuggestions(turn: EndedTurn | null): ReplyChip[] {
  if (!turn) return [];
  const out: ReplyChip[] = [];
  const add = (c: ReplyChip) => {
    if (!c.label || out.length >= MAX_CHIPS) return;
    if (out.some((o) => o.label.toLowerCase() === c.label.toLowerCase())) return;
    out.push(c);
  };

  if (turn.lastText && !turn.interrupted) {
    const listed = listOptions(turn.lastText);
    if (listed.length) listed.forEach(add);
    else questionOptions(turn.lastText).forEach((o) => add(chip(o)));
  }

  let lastEdit = -1;
  let test: { at: number; failed: boolean } | null = null;
  for (const [at, item] of turn.items.entries()) {
    if (item.kind !== "tool") continue;
    if (EDIT_TOOLS.has(item.tool) && item.status === "done") lastEdit = at;
    const command = bashCommand(item);
    if (command && isTestCommand(command) && (item.status === "done" || item.status === "error")) {
      test = { at, failed: item.status === "error" };
    }
  }
  if (test?.failed) add(chip("Fix the failing tests"));
  else if (lastEdit !== -1 && (!test || test.at < lastEdit)) add(chip("Run the tests"));

  if (turn.interrupted) add(chip("Continue where you left off", "Continue"));
  else if (turn.isError) add(chip("Try that again", "Try again"));
  return out;
}

// ── what the backend sends ──────────────────────────────────────────────

/**
 * A `suggest_replies` answer or `phasr://suggestions` payload, defended:
 * anything malformed is dropped, labels and texts are clamped, at most
 * `MAX_CHIPS`, no duplicates.
 */
export function sanitizeSuggestions(raw: unknown): ReplyChip[] {
  if (!Array.isArray(raw)) return [];
  const out: ReplyChip[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const { label, text, source } = s as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) continue;
    const l = clampLabel(typeof label === "string" && label.trim() ? label : text);
    if (!l) continue;
    if (out.some((o) => o.label.toLowerCase() === l.toLowerCase())) continue;
    out.push({
      label: l,
      text: text.trim().slice(0, MAX_TEXT),
      source: source === "native" ? "native" : "generated",
    });
    if (out.length === MAX_CHIPS) break;
  }
  return out;
}
