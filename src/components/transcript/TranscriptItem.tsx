import { ChevronRight, Loader2, Paperclip } from "lucide-react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
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
import { formatElapsed, isSubagentRunning, subagentSteps } from "@/lib/transcript/tree";
import { useNow } from "@/lib/hooks/useNow";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";

/** Lines an inline diff shows before "Show N more lines". */
export const DIFF_PREVIEW_LINES = 12;
/** A new file is all additions: a short head says enough. */
export const WRITE_PREVIEW_LINES = 6;
/** Lines of a command's output shown by default: its tail. */
export const OUTPUT_TAIL_LINES = 12;

const NONE: readonly TranscriptItem[] = [];

/**
 * A subagent call's own items, by the call's id. A stable getter (the
 * transcript swaps what it reads), so a change deep in one subagent only
 * re-renders the groups whose `nested` prop changed.
 */
export const TranscriptChildrenContext = createContext<(id: string) => readonly TranscriptItem[] | undefined>(
  () => undefined,
);

/**
 * A Background chip's "show me this": the item to reveal, the subagent
 * groups to open on the way, and a nonce so a repeat click counts again.
 */
export interface TranscriptFocus {
  itemId: string;
  open: ReadonlySet<string>;
  nonce: number;
  /** Open the item itself too (its output, its group), not just reveal it. */
  expand: boolean;
}
export const TranscriptFocusContext = createContext<TranscriptFocus | null>(null);

/**
 * What a transcript lets its rows do beyond themselves. With
 * `openSubagent`, a subagent row (its title, the row) opens the subagent
 * panel and only its "N steps" chevron expands it inline; without, the
 * row only expands inline.
 */
export interface TranscriptActions {
  openSubagent?: (callId: string) => void;
  /** The subagent the panel shows: its row reads as selected. */
  selectedSubagent?: string | null;
}
export const TranscriptActionsContext = createContext<TranscriptActions>({});

/** How deep in subagents a row sits (0 = the main conversation). */
const DepthContext = createContext(0);

/**
 * The compact variant for a narrow column (the subagent panel, ~280px):
 * rows drop the time column, as they do inside a subagent group.
 */
export function CompactTranscript({ children }: { children: ReactNode }) {
  return <DepthContext.Provider value={1}>{children}</DepthContext.Provider>;
}

/**
 * A-Workspace transcript row: the muted 56px time column, a 14px gap, then
 * the content. Blocks under a line (diffs, output) sit in the content
 * column, i.e. at the design's 70px indent. Inside a subagent group the
 * time column goes: the group is already indented under its call.
 */
function Row({
  ts,
  kind,
  itemId,
  className,
  children,
  onClick,
  ...data
}: {
  ts: string;
  kind: string;
  itemId: string;
  className?: string | undefined;
  children: ReactNode;
  onClick?: ((e: ReactMouseEvent<HTMLDivElement>) => void) | undefined;
} & Record<`data-${string}`, string | undefined>) {
  const depth = useContext(DepthContext);
  return (
    <div
      className={cn("flex gap-[14px]", className)}
      data-transcript-item={kind}
      data-item-id={itemId}
      onClick={onClick}
      {...data}
    >
      {depth === 0 ? (
        <time dateTime={ts} className="w-[56px] shrink-0 select-none tabular-nums text-(--color-text-faint)">
          {formatClock(ts)}
        </time>
      ) : null}
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
    <Row ts={item.ts} kind="user" itemId={item.id}>
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
    <Row ts={item.ts} kind="assistant" itemId={item.id} data-streaming={item.streaming ? "true" : undefined}>
      <Markdown text={item.text} trailing={item.streaming ? <StreamingCaret /> : undefined} />
    </Row>
  );
}

function ThinkingItem({ item }: { item: Extract<TranscriptItem, { kind: "thinking" }> }) {
  const [open, setOpen] = useState(false);
  // Nothing to show (the CLI sent no summary): a plain line, not a
  // control that opens onto nothing.
  if (!item.text.trim()) {
    return (
      <Row ts={item.ts} kind="thinking" itemId={item.id} data-thinking-empty="true">
        <span className="text-(--color-text-muted)">{formatThought(item.durationMs)}</span>
      </Row>
    );
  }
  return (
    <Row ts={item.ts} kind="thinking" itemId={item.id}>
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

/**
 * A Background chip asked to show this item: open it (and say so with a
 * brief highlight). Returns whether it's the focused item right now.
 */
function useFocusedOpen(id: string, open: (yes: boolean) => void): boolean {
  const focus = useContext(TranscriptFocusContext);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!focus) return;
    if (focus.open.has(id)) open(true);
    if (focus.itemId !== id) return;
    if (focus.expand) open(true);
    setFlash(true);
    const t = window.setTimeout(() => setFlash(false), 1600);
    return () => window.clearTimeout(t);
    // Only a new request (nonce) re-opens: closing it again must stick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);
  return flash;
}

const FLASH = "rounded-(--radius-chip) bg-(--color-bg-hover) transition-colors duration-(--dur-2)";

const BACKGROUND_WORD: Record<NonNullable<ToolItem["backgroundStatus"]>, string> = {
  running: "in background",
  done: "finished in background",
  killed: "stopped",
  failed: "failed in background",
};

/** A background command's own status: live while it runs. */
function BackgroundMark({ status, startedAt }: { status: NonNullable<ToolItem["backgroundStatus"]>; startedAt: string }) {
  const running = status === "running";
  const now = useNow(running);
  return (
    <span data-background-mark={status} className="ml-[8px] inline-flex items-center gap-[4px]">
      {running ? (
        <Loader2 role="img" aria-label="running in background" className="size-[11px] animate-spin text-(--color-status-running)" />
      ) : status === "done" ? (
        <span role="img" aria-label="done" className="text-(--color-success)">
          ✓
        </span>
      ) : status === "failed" ? (
        <span role="img" aria-label="failed" className="text-(--color-danger)">
          ✗
        </span>
      ) : null}
      <span className={status === "killed" ? "text-(--color-warning)" : "text-(--color-text-muted)"}>
        {BACKGROUND_WORD[status]}
        {running ? <span className="tabular-nums"> · {formatElapsed(startedAt, now)}</span> : null}
      </span>
    </span>
  );
}

/**
 * Bash with `run_in_background`: the call returns at once, the command runs
 * on. Its status is the command's; its output (tailed live, plus whatever
 * the model reads) is collapsed under a toggle until asked for.
 */
function BackgroundToolItem({ item }: { item: ToolItem }) {
  const { verb, object } = splitTitle(item.title || item.tool);
  const [open, setOpen] = useState(false);
  const flash = useFocusedOpen(item.id, setOpen);
  const status = item.backgroundStatus ?? "running";
  const lines = outputLines(item.output).length;
  return (
    <Row
      ts={item.ts}
      kind="tool"
      itemId={item.id}
      className={cn(flash && FLASH)}
      data-flash={flash ? "true" : undefined}
      data-tool={item.tool}
      data-status={item.status}
      data-background-status={status}
    >
      <div>
        {verb}
        {object ? <span className="text-(--color-text-primary)"> {object}</span> : null}
        <BackgroundMark status={status} startedAt={item.ts} />
        {lines > 0 ? (
          <span className="ml-[8px]">
            <Toggle onClick={() => setOpen((o) => !o)} expanded={open}>
              {open ? "hide output" : `output · ${lines} line${lines === 1 ? "" : "s"}`}
            </Toggle>
          </span>
        ) : null}
      </div>
      {open && item.output ? (
        <OutputTail output={item.output} truncated={item.outputTruncated} tone={status === "failed" ? "danger" : "muted"} />
      ) : null}
    </Row>
  );
}

/** Clicks on these, inside a subagent row, are theirs: they don't open the panel. */
const OWN_CLICKS = "button, a, input, textarea, [data-subagent-transcript], [data-subagent-report]";

/**
 * A subagent call (Agent / Task): what it was asked, its type and status,
 * a live line of what it's doing and how many steps it took. Its title
 * (or anywhere on the row) opens the subagent panel when the transcript
 * offers one; the "N steps" chevron expands its own transcript inline,
 * indented, drawn by the same renderers. Collapsed by default; parallel
 * subagents are sibling calls.
 */
function SubagentToolItem({ item, nested }: { item: ToolItem; nested: readonly TranscriptItem[] }) {
  const [open, setOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const flash = useFocusedOpen(item.id, setOpen);
  const depth = useContext(DepthContext);
  const children = useContext(TranscriptChildrenContext);
  const { openSubagent, selectedSubagent } = useContext(TranscriptActionsContext);
  const info = item.subagent;
  const description = info?.description || splitTitle(item.title || item.tool).object || item.title;
  const steps = subagentSteps(item, nested);
  const running = isSubagentRunning(item);
  const latest = info?.latest?.trim();
  const groupId = `subagent-${item.id}`;
  const selected = !!openSubagent && selectedSubagent === item.id;
  const title = (
    <>
      Subagent
      <span className="text-(--color-text-primary)"> {description}</span>
      {info?.type ? <span className="text-(--color-text-faint)"> · {info.type}</span> : null}
      <StatusMark status={item.status} />
    </>
  );
  // The row itself (its latest line, the space around) opens the panel
  // too; its own controls, a nested group and a text selection don't.
  const onRowClick = openSubagent
    ? (e: ReactMouseEvent<HTMLDivElement>) => {
        const hit = (e.target as Element).closest?.(OWN_CLICKS);
        if (hit && e.currentTarget.contains(hit)) return;
        if (window.getSelection()?.toString()) return;
        e.stopPropagation();
        openSubagent(item.id);
      }
    : undefined;
  return (
    <Row
      ts={item.ts}
      kind="tool"
      itemId={item.id}
      className={cn(
        openSubagent && "cursor-pointer",
        selected && "rounded-(--radius-chip) bg-(--color-bg-surface)",
        flash && FLASH,
      )}
      onClick={onRowClick}
      data-tool={item.tool}
      data-status={item.status}
      data-subagent={info?.type ?? "subagent"}
      data-selected={selected ? "true" : undefined}
      data-flash={flash ? "true" : undefined}
    >
      <div>
        {openSubagent ? (
          <button
            type="button"
            onClick={() => openSubagent(item.id)}
            aria-current={selected || undefined}
            title="Open in the inspector"
            data-subagent-open
            className="rounded-(--radius-chip) text-left transition-colors duration-(--dur-1) ease-(--ease-out) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            {title}
          </button>
        ) : (
          title
        )}
        {item.output && !running ? (
          <span className="ml-[8px]">
            <Toggle onClick={() => setReportOpen((o) => !o)} expanded={reportOpen}>
              {reportOpen ? "hide report" : "report"}
            </Toggle>
          </span>
        ) : null}
      </div>
      {steps > 0 || nested.length > 0 || (running && latest) ? (
        <div className="flex min-w-0 items-center gap-[8px] text-(--color-text-muted)">
          {nested.length > 0 ? (
            <Toggle onClick={() => setOpen((o) => !o)} expanded={open}>
              <span className="inline-flex items-center gap-[4px]" data-subagent-steps={steps} aria-controls={groupId}>
                <ChevronRight className={cn("size-[11px] transition-transform duration-(--dur-1)", open && "rotate-90")} aria-hidden />
                {steps} step{steps === 1 ? "" : "s"}
              </span>
            </Toggle>
          ) : steps > 0 ? (
            <span data-subagent-steps={steps}>
              {steps} step{steps === 1 ? "" : "s"}
            </span>
          ) : null}
          {running && latest ? (
            <span data-subagent-latest className="min-w-0 truncate">
              {latest.endsWith("…") ? latest : `${latest}…`}
            </span>
          ) : null}
        </div>
      ) : null}
      {reportOpen && item.output ? (
        <div data-subagent-report className="my-[4px] rounded-(--radius-control) bg-(--color-bg-input) px-[12px] py-[8px] text-(--color-text-secondary)">
          <Markdown text={item.output} />
        </div>
      ) : null}
      {open && nested.length > 0 ? (
        <div
          id={groupId}
          role="group"
          aria-label={`Subagent: ${description}`}
          data-subagent-transcript
          className="mt-[2px] flex flex-col gap-[3px] border-l-2 border-(--color-border-default) pl-[12px]"
        >
          <DepthContext.Provider value={depth + 1}>
            {nested.map((child) => (
              <TranscriptItemView key={child.id} item={child} nested={children(child.id)} />
            ))}
          </DepthContext.Provider>
        </div>
      ) : null}
    </Row>
  );
}

function ToolItemView({ item, nested }: { item: ToolItem; nested?: readonly TranscriptItem[] | undefined }) {
  if (item.subagent || (nested && nested.length > 0)) return <SubagentToolItem item={item} nested={nested ?? NONE} />;
  if (item.backgroundStatus) return <BackgroundToolItem item={item} />;
  return <PlainToolItem item={item} />;
}

function PlainToolItem({ item }: { item: ToolItem }) {
  const { verb, object } = splitTitle(item.title || item.tool);
  const diff = diffFromToolInput(item.tool, item.input);
  const isBash = item.tool === "Bash";
  const compact = COMPACT_TOOLS.has(item.tool);
  const [genericOpen, setGenericOpen] = useState(false);
  const failed = item.status === "error";
  return (
    <Row ts={item.ts} kind="tool" itemId={item.id} data-tool={item.tool} data-status={item.status}>
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
    <Row ts={item.ts} kind="result" itemId={item.id}>
      <span className={item.isError ? "text-(--color-danger)" : "text-(--color-text-muted)"}>{formatResult(item)}</span>
    </Row>
  );
}

function SystemItem({ item }: { item: Extract<TranscriptItem, { kind: "system" }> }) {
  return (
    <Row ts={item.ts} kind="system" itemId={item.id} data-level={item.level}>
      <span role={item.level === "error" ? "alert" : undefined} className={cn("whitespace-pre-wrap", item.level === "error" ? "text-(--color-danger)" : "text-(--color-text-muted)")}>
        {item.text}
      </span>
    </Row>
  );
}

/**
 * One transcript item. Memoised: items are replaced, never mutated. A
 * subagent call gets its own items as `nested` (from `groupTranscript`).
 */
export const TranscriptItemView = memo(function TranscriptItemView({
  item,
  nested,
}: {
  item: TranscriptItem;
  nested?: readonly TranscriptItem[] | undefined;
}) {
  switch (item.kind) {
    case "user":
      return <UserItem item={item} />;
    case "assistant":
      return <AssistantItem item={item} />;
    case "thinking":
      return <ThinkingItem item={item} />;
    case "tool":
      return <ToolItemView item={item} nested={nested} />;
    case "result":
      return <ResultItem item={item} />;
    case "system":
      return <SystemItem item={item} />;
    default:
      return null;
  }
});
