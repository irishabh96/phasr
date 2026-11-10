import { ChevronRight, Loader2, Paperclip } from "lucide-react";
import { memo, useState, type ReactNode } from "react";
import type { ToolItem, TranscriptItem } from "@/lib/transcript/contract";
import {
  COMPACT_TOOLS,
  diffFromToolInput,
  formatClock,
  formatResult,
  formatThought,
  outputLines,
  splitTitle,
  type InlineDiffLine,
} from "@/lib/transcript/format";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";

/** Lines an inline diff shows before "Show N more lines". */
export const DIFF_PREVIEW_LINES = 12;
/** A new file is all additions: a short head says enough. */
export const WRITE_PREVIEW_LINES = 6;
/** Lines of a command's output shown by default: its tail. */
export const OUTPUT_TAIL_LINES = 12;

/**
 * A-Workspace transcript row: the muted 56px time column, a 14px gap, then
 * the content. Blocks under a line (diffs, output) sit in the content
 * column, i.e. at the design's 70px indent.
 */
function Row({ ts, kind, children, ...data }: { ts: string; kind: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="flex gap-[14px]" data-transcript-item={kind} {...data}>
      <time dateTime={ts} className="w-[56px] shrink-0 select-none tabular-nums text-(--color-text-faint)">
        {formatClock(ts)}
      </time>
      <div className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{children}</div>
    </div>
  );
}

/** Quiet text toggle under a block. */
function Toggle({ onClick, children, expanded }: { onClick: () => void; children: ReactNode; expanded?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      className="rounded-(--radius-chip) text-(--color-text-muted) transition-colors duration-(--dur-1) ease-(--ease-out) hover:text-(--color-text-secondary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
    >
      {children}
    </button>
  );
}

function StreamingCaret() {
  return (
    <span
      aria-hidden
      data-streaming-caret
      className="ml-[1px] inline-block h-[1.1em] w-[0.55em] translate-y-[0.2em] animate-[caret-blink_1s_steps(1)_infinite] bg-(--color-accent-500)"
    />
  );
}

/** "Attached files:" block the composer appends, split back off the text. */
function splitAttachments(text: string): { body: string; files: string[] } {
  const at = text.lastIndexOf("Attached files:\n");
  if (at === -1 || (at > 0 && !text.slice(0, at).endsWith("\n\n"))) return { body: text, files: [] };
  const files = text
    .slice(at + "Attached files:\n".length)
    .split("\n")
    .map((l) => l.replace(/^- /, "").trim())
    .filter(Boolean);
  return { body: text.slice(0, at).trimEnd(), files };
}

function UserItem({ item }: { item: Extract<TranscriptItem, { kind: "user" }> }) {
  const { body, files } = splitAttachments(item.text);
  return (
    <Row ts={item.ts} kind="user">
      <div className="my-[4px] flex flex-col gap-[4px] rounded-(--radius-control) bg-(--color-bg-surface) px-[12px] py-[6px]">
        {body ? <p className="m-0 whitespace-pre-wrap text-(--color-text-primary)">{body}</p> : null}
        {files.length > 0 ? (
          <ul aria-label="Attached files" className="m-0 flex list-none flex-wrap gap-x-[12px] p-0 text-(--color-text-muted)">
            {files.map((f) => (
              <li key={f} className="inline-flex items-center gap-[4px]">
                <Paperclip className="size-[11px]" aria-hidden />
                {f}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Row>
  );
}

function AssistantItem({ item }: { item: Extract<TranscriptItem, { kind: "assistant" }> }) {
  return (
    <Row ts={item.ts} kind="assistant" data-streaming={item.streaming ? "true" : undefined}>
      <Markdown text={item.text} trailing={item.streaming ? <StreamingCaret /> : undefined} />
    </Row>
  );
}

function ThinkingItem({ item }: { item: Extract<TranscriptItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <Row ts={item.ts} kind="thinking">
      <Toggle onClick={() => setOpen((o) => !o)} expanded={open}>
        <span className="inline-flex items-center gap-[4px]">
          <ChevronRight className={cn("size-[11px] transition-transform duration-(--dur-1)", open && "rotate-90")} aria-hidden />
          {formatThought(item.durationMs)}
        </span>
      </Toggle>
      {open ? (
        <p className="m-0 mt-[2px] whitespace-pre-wrap border-l-2 border-(--color-border-default) pl-[10px] text-(--color-text-muted)">
          {item.text}
        </p>
      ) : null}
    </Row>
  );
}

function StatusMark({ status }: { status: ToolItem["status"] }) {
  switch (status) {
    case "running":
      return (
        <Loader2
          role="img"
          aria-label="running"
          className="ml-[8px] inline size-[11px] -translate-y-px animate-spin text-(--color-text-muted)"
        />
      );
    case "done":
      return (
        <span role="img" aria-label="done" className="ml-[8px] text-(--color-success)">
          ✓
        </span>
      );
    case "error":
      return (
        <span role="img" aria-label="failed" className="ml-[8px] text-(--color-danger)">
          ✗
        </span>
      );
    case "denied":
      return <span className="ml-[8px] text-(--color-warning)">denied</span>;
  }
}

const LINE_TONE: Record<InlineDiffLine["kind"], string> = {
  add: "text-(--diff-add-fg)",
  remove: "text-(--diff-remove-fg)",
  context: "text-(--color-text-muted)",
  gap: "text-(--color-text-faint)",
};
const LINE_SIGN: Record<InlineDiffLine["kind"], string> = { add: "+", remove: "-", context: " ", gap: "⋯" };

/** The design's inline −/+ block: inset, radius 6, capped and expandable. */
export function InlineDiffBlock({ lines, preview = DIFF_PREVIEW_LINES }: { lines: InlineDiffLine[]; preview?: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? lines : lines.slice(0, preview);
  const more = lines.length - shown.length;
  return (
    <div data-inline-diff className="my-[4px] rounded-(--radius-control) bg-(--color-bg-input) px-[12px] py-[8px]">
      <div className="overflow-x-auto">
        {shown.map((l, i) => (
          // The sign then the line, as git prints it (and A-Workspace draws it).
          <div key={i} data-diff-line={l.kind} className={cn("whitespace-pre", LINE_TONE[l.kind])}>
            {LINE_SIGN[l.kind]}
            {l.kind === "gap" ? "" : l.text}
          </div>
        ))}
      </div>
      {more > 0 || open ? (
        <div className="mt-[2px]">
          <Toggle onClick={() => setOpen((o) => !o)} expanded={open}>
            {open ? "Show less" : `Show ${more} more line${more === 1 ? "" : "s"}`}
          </Toggle>
        </div>
      ) : null}
    </div>
  );
}

/** A command's output: its tail by default, all of it on request. */
export function OutputTail({ output, truncated, tone = "muted" }: { output: string; truncated?: boolean | undefined; tone?: "muted" | "danger" }) {
  const [open, setOpen] = useState(false);
  const all = outputLines(output);
  if (all.length === 0) return null;
  const shown = open ? all : all.slice(-OUTPUT_TAIL_LINES);
  const hidden = all.length - shown.length;
  return (
    <div data-output-tail className={cn(tone === "danger" ? "text-(--color-danger)" : "text-(--color-text-muted)")}>
      {hidden > 0 || open || truncated ? (
        <div>
          {all.length > OUTPUT_TAIL_LINES ? (
            <Toggle onClick={() => setOpen((o) => !o)} expanded={open}>
              {open ? "Show last 12 lines" : `Show all ${all.length} lines`}
            </Toggle>
          ) : null}
          {truncated ? <span className="text-(--color-text-faint)">{all.length > OUTPUT_TAIL_LINES ? " · " : ""}output truncated</span> : null}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        {shown.map((l, i) => (
          <div key={i} className="min-h-[1.7em] whitespace-pre">
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolItemView({ item }: { item: ToolItem }) {
  const { verb, object } = splitTitle(item.title || item.tool);
  const diff = diffFromToolInput(item.tool, item.input);
  const isBash = item.tool === "Bash";
  const compact = COMPACT_TOOLS.has(item.tool);
  const [genericOpen, setGenericOpen] = useState(false);
  const failed = item.status === "error";
  return (
    <Row ts={item.ts} kind="tool" data-tool={item.tool} data-status={item.status}>
      <div>
        {verb}
        {object ? <span className="text-(--color-text-primary)"> {object}</span> : null}
        {diff && (diff.adds > 0 || diff.removes > 0) ? (
          <span className="ml-[8px]">
            {diff.adds > 0 ? <span className="text-(--diff-add-fg)">+{diff.adds}</span> : null}
            {diff.adds > 0 && diff.removes > 0 ? " " : null}
            {diff.removes > 0 ? <span className="text-(--diff-remove-fg)">−{diff.removes}</span> : null}
          </span>
        ) : null}
        <StatusMark status={item.status} />
        {!isBash && !diff && !compact && item.output && !failed ? (
          <span className="ml-[8px]">
            <Toggle onClick={() => setGenericOpen((o) => !o)} expanded={genericOpen}>
              {genericOpen ? "hide output" : "output"}
            </Toggle>
          </span>
        ) : null}
      </div>
      {diff && diff.lines.length > 0 ? (
        <InlineDiffBlock lines={diff.lines} preview={item.tool === "Write" ? WRITE_PREVIEW_LINES : DIFF_PREVIEW_LINES} />
      ) : null}
      {isBash && item.output ? <OutputTail output={item.output} truncated={item.outputTruncated} tone={failed ? "danger" : "muted"} /> : null}
      {/* Other tools: their output only when it explains a failure, or asked for. */}
      {!isBash && item.output && (failed || genericOpen) ? (
        <OutputTail output={item.output} truncated={item.outputTruncated} tone={failed ? "danger" : "muted"} />
      ) : null}
    </Row>
  );
}

function ResultItem({ item }: { item: Extract<TranscriptItem, { kind: "result" }> }) {
  return (
    <Row ts={item.ts} kind="result">
      <span className={item.isError ? "text-(--color-danger)" : "text-(--color-text-muted)"}>{formatResult(item)}</span>
    </Row>
  );
}

function SystemItem({ item }: { item: Extract<TranscriptItem, { kind: "system" }> }) {
  return (
    <Row ts={item.ts} kind="system" data-level={item.level}>
      <span role={item.level === "error" ? "alert" : undefined} className={cn("whitespace-pre-wrap", item.level === "error" ? "text-(--color-danger)" : "text-(--color-text-muted)")}>
        {item.text}
      </span>
    </Row>
  );
}

/** One transcript item. Memoised: items are replaced, never mutated. */
export const TranscriptItemView = memo(function TranscriptItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case "user":
      return <UserItem item={item} />;
    case "assistant":
      return <AssistantItem item={item} />;
    case "thinking":
      return <ThinkingItem item={item} />;
    case "tool":
      return <ToolItemView item={item} />;
    case "result":
      return <ResultItem item={item} />;
    case "system":
      return <SystemItem item={item} />;
    default:
      return null;
  }
});
