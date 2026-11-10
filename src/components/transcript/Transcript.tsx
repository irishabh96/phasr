import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Loader2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PanelState } from "@/components/ui/PanelState";
import { useTranscriptFocus } from "@/lib/transcript/focus";
import { ancestorsOf, groupTranscript } from "@/lib/transcript/tree";
import { useTranscript } from "@/lib/transcript/useTranscript";
import { cn } from "@/lib/utils";
import {
  TranscriptChildrenContext,
  TranscriptFocusContext,
  TranscriptItemView,
  type TranscriptFocus,
} from "./TranscriptItem";

/** Past this many items only the visible ones render (A-Polish "Lists"). */
export const VIRTUALIZE_ABOVE = 200;
/** Within this many px of the end counts as "at the bottom". */
const PIN_SLOP = 24;
/** The design's 3px between rows. */
const ROW_GAP = 3;
const PAD_TOP = 20;
const PAD_BOTTOM = 16;

/**
 * The agent pane in transcript view (spec §3, A-Workspace "Transcript"):
 * JetBrains Mono 12.5/1.7 on the pane background, a muted time column,
 * inline blocks for diffs and output.
 *
 * Follows the end while you're at it: new items and a streaming reply
 * keep it pinned to the bottom. Scrolled up, it stays put and a "Jump to
 * latest" pill brings you back.
 *
 * Stays mounted behind other tabs like the terminal does (`visible`), so
 * its scroll position survives.
 *
 * A subagent's items render inside its call (by `parentId`); only the main
 * conversation's rows are listed (and virtualised) here.
 */
export function Transcript({ taskId, visible }: { taskId: string; visible: boolean }) {
  const query = useTranscript(taskId);
  const all = query.data ?? [];
  const tree = useMemo(() => groupTranscript(all), [all]);
  const items = tree.top;
  // A stable getter over the latest grouping: nested groups read their
  // children through it without every row re-rendering on each change.
  const childrenRef = useRef(tree.children);
  childrenRef.current = tree.children;
  const childrenOf = useCallback((id: string) => childrenRef.current.get(id), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [focus, setFocus] = useState<TranscriptFocus | null>(null);
  const virtual = items.length > VIRTUALIZE_ABOVE;
  const hasContent = items.length > 0;

  const v = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 24,
    overscan: 12,
    paddingStart: PAD_TOP,
    paddingEnd: PAD_BOTTOM,
    getItemKey: (i) => items[i]?.id ?? i,
  });

  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const setPin = useCallback((next: boolean) => {
    if (pinnedRef.current === next) return;
    pinnedRef.current = next;
    setPinned(next);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setPin(el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLOP);
  }, [setPin]);

  // New or changed items while pinned: follow them, before paint.
  useLayoutEffect(() => {
    if (pinnedRef.current) toBottom();
  }, [items, toBottom]);

  // Growth that isn't a new item (a measured virtual row, an expanded
  // block, wrapping after a resize) also keeps a pinned view at the end.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) toBottom();
    });
    ro.observe(content);
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom, virtual, hasContent]);

  // Shown again: a pinned view catches up on what arrived meanwhile.
  useLayoutEffect(() => {
    if (visible && pinnedRef.current) toBottom();
  }, [visible, toBottom]);

  // Virtual rows measure after paint; land on the real end once they have.
  useEffect(() => {
    if (!virtual || !pinnedRef.current) return;
    const id = requestAnimationFrame(toBottom);
    return () => cancelAnimationFrame(id);
  }, [virtual, items.length, toBottom]);

  const jump = () => {
    setPin(true);
    if (virtual) v.scrollToIndex(items.length - 1, { align: "end" });
    toBottom();
    requestAnimationFrame(toBottom);
  };

  // A Background chip asked for an item: open the subagent groups around
  // it, bring its row into view (unpinned, so new items don't pull the
  // view away), and let the item expand itself.
  const request = useTranscriptFocus((s) => s.request);
  const allRef = useRef(all);
  allRef.current = all;
  useEffect(() => {
    if (!request || request.taskId !== taskId) return;
    const list = allRef.current;
    if (!list.some((i) => i.id === request.itemId)) return;
    const ancestors = ancestorsOf(list, request.itemId);
    setFocus({ itemId: request.itemId, open: new Set(ancestors), nonce: request.nonce });
    const topId = ancestors[0] ?? request.itemId;
    if (virtual) {
      const index = items.findIndex((i) => i.id === topId);
      if (index >= 0) {
        setPin(false);
        v.scrollToIndex(index, { align: "center" });
      }
    }
    // Groups open and outputs expand on the next render; land on the row
    // once they have.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const el = scrollRef.current;
        const row = el?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(request.itemId)}"]`);
        if (!el || !row) return;
        // Unpinned here, not earlier: a scroll event while still at the
        // end (the expanding output) would pin it again.
        setPin(false);
        // This list's own scroll only: `scrollIntoView` would also scroll
        // the pane's overflow-hidden ancestors and shift the layout.
        const offset = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
        el.scrollTop = Math.max(0, el.scrollTop + offset - (el.clientHeight - Math.min(row.offsetHeight, el.clientHeight)) / 2);
      });
    });
    return () => cancelAnimationFrame(frame);
    // Only a new request moves the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.nonce]);

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <div className="flex h-full items-center justify-center gap-[8px] font-sans text-[13px] text-(--color-text-muted)">
        <Loader2 className="size-[14px] animate-spin" aria-hidden />
        Loading transcript…
      </div>
    );
  } else if (query.isError) {
    body = (
      <div className="flex h-full items-center justify-center p-6 font-sans">
        <PanelState kind="error" title="Couldn't load the transcript" error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  } else if (items.length === 0) {
    body = (
      <div className="flex h-full items-center justify-center font-sans text-[13px] text-(--color-text-muted)">
        Nothing yet. Messages and tool calls appear here.
      </div>
    );
  } else if (virtual) {
    body = (
      <div ref={contentRef} className="relative w-full" style={{ height: v.getTotalSize() }}>
        {v.getVirtualItems().map((row) => {
          const item = items[row.index]!;
          return (
            <div
              key={row.key}
              ref={v.measureElement}
              data-index={row.index}
              className="absolute inset-x-[24px] top-0"
              style={{ transform: `translateY(${row.start}px)`, paddingBottom: ROW_GAP }}
            >
              <TranscriptItemView item={item} nested={tree.children.get(item.id)} />
            </div>
          );
        })}
      </div>
    );
  } else {
    body = (
      <div ref={contentRef} className="flex flex-col px-[24px]" style={{ gap: ROW_GAP, paddingTop: PAD_TOP, paddingBottom: PAD_BOTTOM }}>
        {items.map((item) => (
          <TranscriptItemView key={item.id} item={item} nested={tree.children.get(item.id)} />
        ))}
      </div>
    );
  }
  body = (
    <TranscriptChildrenContext.Provider value={childrenOf}>
      <TranscriptFocusContext.Provider value={focus}>{body}</TranscriptFocusContext.Provider>
    </TranscriptChildrenContext.Provider>
  );

  return (
    <div
      data-testid="transcript"
      data-task-id={taskId}
      className={cn("absolute inset-0 bg-(--color-bg-base)", !visible && "invisible")}
      aria-hidden={!visible || undefined}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Transcript"
        // A streaming reply would read out token by token.
        aria-live="off"
        tabIndex={visible ? 0 : -1}
        className="h-full overflow-y-auto overflow-x-hidden font-mono text-[12.5px] leading-[1.7] text-(--color-text-transcript) focus-visible:outline-none"
      >
        {body}
      </div>
      {!pinned && items.length > 0 ? (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-[12px] left-1/2 z-10 flex h-[28px] -translate-x-1/2 items-center gap-[6px] rounded-full bg-(--color-bg-elevated) px-[12px] font-sans text-[12px] text-(--color-text-secondary) shadow-(--shadow-floating) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
        >
          <ArrowDown className="size-[12px]" aria-hidden />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
