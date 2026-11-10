import { ArrowDown, ArrowLeft, ChevronRight } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { formatTokens } from "@/lib/formatTokens";
import { useNow } from "@/lib/hooks/useNow";
import { inEditable, inTerminalSurface, isOverlayOpen } from "@/lib/keyboardGuards";
import { useUiStore } from "@/lib/store";
import type { ToolItem, TranscriptItem } from "@/lib/transcript/contract";
import { useTranscriptFocus } from "@/lib/transcript/focus";
import { formatDuration } from "@/lib/transcript/format";
import { useSubagentStore } from "@/lib/transcript/subagentStore";
import {
  descendantsOf,
  formatElapsed,
  isSubagentRunning,
  subagentSteps,
  subagentTree,
} from "@/lib/transcript/tree";
import { useTranscript } from "@/lib/transcript/useTranscript";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import {
  CompactTranscript,
  TranscriptActionsContext,
  TranscriptChildrenContext,
  TranscriptItemView,
  type TranscriptActions,
} from "./TranscriptItem";

const NO_ITEMS: readonly TranscriptItem[] = [];
/** Within this many px of the end counts as "at the bottom". */
const PIN_SLOP = 24;

/**
 * The subagent panel: one subagent, in the inspector column (which keeps
 * its SlidePanel; only its contents swap). A header (Back, what it was
 * asked, its type, status, elapsed time, steps and tokens), its own
 * transcript (nested subagents included) drawn by the transcript's
 * renderers in their compact variant and kept live, and a footer with
 * its report once it's done and a way back to its row in the transcript.
 *
 * Back, or Esc from the panel or the page, returns to the inspector. If
 * the subagent's call leaves the transcript, the panel closes itself.
 */
export function SubagentPanel({ taskId, callId }: { taskId: string; callId: string }) {
  const query = useTranscript(taskId);
  const all = query.data ?? NO_ITEMS;
  const call = useMemo(
    () => all.find((i): i is ToolItem => i.id === callId && i.kind === "tool"),
    [all, callId],
  );
  const tree = useMemo(() => subagentTree(all, callId), [all, callId]);
  const clear = useSubagentStore((s) => s.clearSubagent);
  const select = useSubagentStore((s) => s.selectSubagent);
  const back = useCallback(() => clear(taskId), [clear, taskId]);
  const rootRef = useRef<HTMLElement>(null);

  // Its call is gone from the transcript: nothing to show.
  const gone = query.isSuccess && !call;
  useEffect(() => {
    if (gone) clear(taskId, callId);
  }, [gone, clear, taskId, callId]);

  // Esc goes back: from the panel, or from the page — not from a text
  // field, a terminal or a menu, which have their own Esc.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isOverlayOpen()) return;
      const target = e.target as Element | null;
      const inPanel = !!target && !!rootRef.current?.contains(target);
      if (!inPanel && (inEditable(target) || inTerminalSurface(target))) return;
      if (target?.closest?.("[role='menu'], [role='listbox']")) return;
      e.preventDefault();
      back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  // Nested subagents open here too (switching the panel to them).
  const childrenRef = useRef(tree.children);
  childrenRef.current = tree.children;
  const childrenOf = useCallback((id: string) => childrenRef.current.get(id), []);
  const actions = useMemo<TranscriptActions>(
    () => ({ openSubagent: (id) => select(taskId, id), selectedSubagent: callId }),
    [select, taskId, callId],
  );

  if (!call) return null;
  const description = call.subagent?.description || call.title.replace(/^Running a subagent:\s*/, "");
  return (
    <section
      ref={rootRef}
      aria-label={`Subagent: ${description}`}
      data-testid="subagent-panel"
      data-subagent-id={callId}
      className="flex min-h-0 flex-1 flex-col text-[12.5px] leading-[1.45]"
    >
      <Header call={call} description={description} items={all} steps={subagentSteps(call, tree.top)} onBack={back} />
      <TranscriptChildrenContext.Provider value={childrenOf}>
        <TranscriptActionsContext.Provider value={actions}>
          <Body callId={callId} items={tree.top} nestedOf={tree.children} />
        </TranscriptActionsContext.Provider>
      </TranscriptChildrenContext.Provider>
      <Footer taskId={taskId} call={call} />
    </section>
  );
}

const STATUS: Record<ToolItem["status"], { word: string; tone: string }> = {
  running: { word: "running", tone: "text-(--color-text-secondary)" },
  done: { word: "done", tone: "text-(--color-success)" },
  error: { word: "failed", tone: "text-(--color-danger)" },
  denied: { word: "denied", tone: "text-(--color-warning)" },
};

/** How long it ran: live while it runs; its end when it has one, else its last step. */
function elapsedOf(call: ToolItem, items: readonly TranscriptItem[], running: boolean, now: number): string {
  if (running) return formatElapsed(call.ts, now);
  const start = Date.parse(call.ts);
  let end = Date.parse(call.subagent?.finishedAt ?? "");
  if (Number.isNaN(end)) {
    const under = descendantsOf(items, call.id);
    end = under.length > 0 ? Date.parse(under[under.length - 1]!.ts) : Number.NaN;
  }
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "";
  return formatDuration(end - start);
}

function Header({
  call,
  description,
  items,
  steps,
  onBack,
}: {
  call: ToolItem;
  description: string;
  items: readonly TranscriptItem[];
  steps: number;
  onBack: () => void;
}) {
  const running = isSubagentRunning(call);
  const now = useNow(running);
  const status = running ? STATUS.running : STATUS[call.status];
  const elapsed = elapsedOf(call, items, running, now);
  const tokens = call.subagent?.tokens;
  const meta: ReactNode[] = [];
  if (call.subagent?.type) meta.push(<span key="type">{call.subagent.type}</span>);
  meta.push(
    <span key="status" data-subagent-status={running ? "running" : call.status} className={status.tone}>
      {status.word}
    </span>,
  );
  if (elapsed) meta.push(<span key="elapsed" data-subagent-elapsed>{elapsed}</span>);
  meta.push(
    <span key="steps" data-subagent-steps={steps}>
      {steps} step{steps === 1 ? "" : "s"}
    </span>,
  );
  if (typeof tokens === "number") meta.push(<span key="tokens">{formatTokens(tokens)} tokens</span>);
  return (
    <header className="flex shrink-0 flex-col gap-[6px] px-[20px] pb-[14px] pt-[12px]">
      <button
        type="button"
        onClick={onBack}
        aria-keyshortcuts="Escape"
        title="Back to the inspector (Esc)"
        className="-ml-[6px] flex h-[24px] items-center gap-[4px] self-start rounded-(--radius-control) px-[6px] text-(--color-text-muted) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-surface) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
      >
        <ArrowLeft className="size-[12px]" aria-hidden />
        Back
      </button>
      <h2 className="m-0 truncate text-[13px] font-medium text-(--color-text-primary)" title={description}>
        {description}
      </h2>
      <p data-subagent-meta className="m-0 flex flex-wrap items-center gap-x-[6px] tabular-nums text-(--color-text-muted)">
        {meta.flatMap((m, i) => (i === 0 ? [m] : [<span key={`dot-${i}`} aria-hidden>·</span>, m]))}
      </p>
    </header>
  );
}

/**
 * Its own transcript, live: follows the end while you're there; scrolled
 * up, it stays put and "Jump to latest" brings you back.
 */
function Body({
  callId,
  items,
  nestedOf,
}: {
  callId: string;
  items: readonly TranscriptItem[];
  nestedOf: ReadonlyMap<string, readonly TranscriptItem[]>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const setPin = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinned(next);
  }, []);
  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setPin(el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLOP);
  };
  // New items while at the end: follow them, before paint.
  useLayoutEffect(() => {
    if (pinnedRef.current) toBottom();
  }, [items, toBottom]);
  // Growth that isn't a new item (an expanded block, wrapping) too.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) toBottom();
    });
    ro.observe(el);
    ro.observe(content);
    return () => ro.disconnect();
  }, [toBottom]);

  const jump = () => {
    setPin(true);
    toBottom();
    requestAnimationFrame(toBottom);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Subagent transcript"
        aria-live="off"
        tabIndex={0}
        data-subagent-body={callId}
        className="h-full overflow-y-auto overflow-x-hidden px-[20px] font-mono text-[12px] leading-[1.65] text-(--color-text-transcript) focus-visible:outline-none"
      >
        <div ref={contentRef} className="flex flex-col gap-[3px] pb-[12px]">
          {items.length === 0 ? (
            <p className="m-0 font-sans text-[12.5px] text-(--color-text-muted)">No steps yet.</p>
          ) : (
            <CompactTranscript>
              {items.map((item) => (
                <TranscriptItemView key={item.id} item={item} nested={nestedOf.get(item.id)} />
              ))}
            </CompactTranscript>
          )}
        </div>
      </div>
      {!pinned && items.length > 0 ? (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-[10px] left-1/2 z-10 flex h-[26px] -translate-x-1/2 items-center gap-[6px] rounded-full bg-(--color-bg-elevated) px-[10px] font-sans text-[12px] text-(--color-text-secondary) shadow-(--shadow-floating) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          <ArrowDown className="size-[12px]" aria-hidden />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

/** Its report once it's done (collapsible), and the way to its row in the transcript. */
function Footer({ taskId, call }: { taskId: string; call: ToolItem }) {
  const [reportOpen, setReportOpen] = useState(true);
  const focus = useTranscriptFocus((s) => s.focus);
  const report = !isSubagentRunning(call) && call.output?.trim() ? call.output : null;
  const showInTranscript = () => {
    // The transcript lives on the agent pane's main tab: bring it forward.
    const ui = useUiStore.getState();
    if (ui.sessionPane[taskId] && ui.sessionPane[taskId] !== "tabs") ui.setSessionPane(taskId, "tabs");
    const main = ui.innerTabs[taskId]?.tabs.find((t) => t.kind === "main");
    if (main && ui.innerTabs[taskId]?.activeTabId !== main.id) ui.setActiveInnerTab(taskId, main.id);
    focus(taskId, call.id, { expand: false });
  };
  return (
    <footer className="flex shrink-0 flex-col gap-[8px] px-[20px] pb-[16px] pt-[10px]">
      {report ? (
        <section aria-label="Report" className="flex min-h-0 flex-col gap-[6px]">
          <button
            type="button"
            onClick={() => setReportOpen((o) => !o)}
            aria-expanded={reportOpen}
            className="flex items-center gap-[4px] self-start rounded-(--radius-chip) font-medium text-(--color-text-secondary) transition-colors duration-(--dur-1) ease-(--ease-out) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            <ChevronRight className={cn("size-[11px] transition-transform duration-(--dur-1)", reportOpen && "rotate-90")} aria-hidden />
            Report
          </button>
          {reportOpen ? (
            <div
              data-subagent-final-report
              className="max-h-[38vh] overflow-y-auto rounded-(--radius-control) bg-(--color-bg-surface) px-[12px] py-[8px] text-(--color-text-secondary)"
            >
              <Markdown text={report} />
            </div>
          ) : null}
        </section>
      ) : null}
      <button
        type="button"
        onClick={showInTranscript}
        className="self-start rounded-(--radius-chip) text-left text-(--color-text-muted) transition-colors duration-(--dur-1) ease-(--ease-out) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
      >
        Show in transcript →
      </button>
    </footer>
  );
}
