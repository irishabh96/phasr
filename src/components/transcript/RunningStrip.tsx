import { Loader2, Pin, Square, X } from "lucide-react";
import { useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { AgentMark } from "@/components/ui/AgentMark";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";
import { useNow } from "@/lib/hooks/useNow";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { transcriptApi } from "@/lib/transcript/contract";
import { useTranscriptFocus } from "@/lib/transcript/focus";
import {
  chipSources,
  deriveRunningChips,
  fitCount,
  isLingering,
  NO_ENDS,
  noteEnds,
  type ChipStatus,
  type EndTracker,
  type RunningChip,
} from "@/lib/transcript/running";
import { EMPTY_IDS, useSelectedSubagent, useSubagentStore } from "@/lib/transcript/subagentStore";
import { formatElapsed } from "@/lib/transcript/tree";
import { useTranscript } from "@/lib/transcript/useTranscript";
import type { TranscriptItem } from "@/lib/types";
import { cn } from "@/lib/utils";

const NO_ITEMS: readonly TranscriptItem[] = [];
/** The gap between chips, and the "+N" button's width with its gap. */
const GAP = 8;
const MORE = 36 + GAP;

const STATUS_WORD: Record<ChipStatus, string> = {
  running: "running",
  done: "done",
  failed: "failed",
  stopped: "stopped",
};

const stepsLabel = (n: number) => `${n} step${n === 1 ? "" : "s"}`;

/**
 * "Running": what the agent has going besides its turn, docked just above
 * the composer in transcript view. One chip per subagent at work (its
 * mark, what it was asked, its live step count, a spinner) and per
 * background command (its command, how long it's run, × to stop it).
 *
 *  - A subagent chip opens the subagent in the inspector column; a command
 *    chip shows its item in the transcript.
 *  - A finished chip shows ✓ / ✗ for a few seconds, then drops off,
 *    unless pinned (the pin toggle on hover or focus); a pinned one stays
 *    until unpinned or dismissed (×).
 *  - More chips than fit: "+N" lists the rest.
 *
 * Nothing renders while there's no chip; while there is, the strip's
 * height is fixed.
 */
export function RunningStrip({ taskId }: { taskId: string }) {
  const query = useTranscript(taskId);
  const items = query.data ?? NO_ITEMS;
  const sources = useMemo(() => chipSources(items), [items]);
  // When each chip was seen to finish: drives the linger.
  const tracker = useRef<EndTracker>(NO_ENDS);
  const ended = useMemo(() => (tracker.current = noteEnds(tracker.current, sources, Date.now())).ended, [sources]);
  const pinnedIds = useSubagentStore((s) => s.pinned[taskId] ?? EMPTY_IDS);
  const dismissedIds = useSubagentStore((s) => s.dismissed[taskId] ?? EMPTY_IDS);
  const pinned = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const dismissed = useMemo(() => new Set(dismissedIds), [dismissedIds]);
  // The clock only re-renders: every second while anything runs or
  // lingers (elapsed times, the linger running out), else every minute.
  // The time itself is read fresh, so a coarse clock's older value can't
  // bring back a chip whose linger is over.
  const wall = Date.now();
  useNow(sources.some((s) => s.status === "running") || [...ended.values()].some((t) => isLingering(t, wall)));
  const chips = deriveRunningChips(sources, { now: wall, ended, pinned, dismissed });
  if (chips.length === 0) return null;
  return <Strip taskId={taskId} chips={chips} now={wall} />;
}

function Strip({ taskId, chips, now }: { taskId: string; chips: RunningChip[]; now: number }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(chips.length);
  const [, relayout] = useReducer((n: number) => n + 1, 0);

  // Measure every chip (overflowed ones too: they're laid out, invisibly,
  // out of the flow) and show as many as fit.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const widths = chips.map(
      (c) => row.querySelector<HTMLElement>(`[data-running-chip="${CSS.escape(c.id)}"]`)?.offsetWidth ?? 0,
    );
    const fit = fitCount(widths, row.clientWidth, GAP, MORE);
    if (fit !== shown) setShown(fit);
  });
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => relayout());
    ro.observe(row);
    return () => ro.disconnect();
  }, []);

  const visible = Math.min(shown, chips.length);
  const rest = chips.slice(visible);
  return (
    <div
      role="group"
      aria-label="Running"
      data-testid="running-strip"
      className="flex h-[34px] shrink-0 items-center gap-[10px] bg-(--color-bg-base) px-[24px] pt-[8px] font-sans text-[12px]"
    >
      <span className="shrink-0 text-[11px] font-medium text-(--color-text-muted)">Running</span>
      {/* Room around the chips for their focus rings, inside the clip. */}
      <div ref={rowRef} className="relative -m-[3px] flex min-w-0 flex-1 items-center overflow-hidden p-[3px]" style={{ gap: GAP }}>
        {chips.map((chip, i) => (
          <ChipFrame key={chip.id} chip={chip} hidden={i >= visible}>
            {chip.kind === "subagent" ? (
              <SubagentChip taskId={taskId} chip={chip} />
            ) : (
              <ShellChip taskId={taskId} chip={chip} now={now} />
            )}
          </ChipFrame>
        ))}
        {rest.length > 0 ? <MoreMenu taskId={taskId} chips={rest} /> : null}
      </div>
    </div>
  );
}

/**
 * A chip's slot. One that doesn't fit stays laid out (to be measured) but
 * out of the flow, invisible, and out of reach of focus and assistive tech.
 */
function ChipFrame({ chip, hidden, children }: { chip: RunningChip; hidden: boolean; children: ReactNode }) {
  return (
    <div
      data-running-chip={chip.id}
      data-chip-kind={chip.kind}
      data-status={chip.status}
      data-pinned={chip.pinned ? "true" : undefined}
      inert={hidden || undefined}
      aria-hidden={hidden || undefined}
      className={cn("shrink-0", hidden && "invisible absolute left-0 top-0")}
    >
      {children}
    </div>
  );
}

const chipShell =
  "group/chip flex h-[26px] items-center rounded-(--radius-chip) text-(--color-text-secondary) transition-colors duration-(--dur-1) ease-(--ease-out)";
const chipMain =
  "flex h-full min-w-0 items-center gap-[6px] rounded-(--radius-chip) pl-[8px] pr-[4px] hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)";
const iconButton =
  "flex size-[20px] shrink-0 items-center justify-center rounded-(--radius-chip) text-(--color-text-muted) transition-[color,background-color,opacity] duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus) disabled:pointer-events-none";

/** ✓ / ✗ / ■ once over; a spinner (or a pulsing dot for a command) while running. */
function StatusGlyph({ status, kind }: { status: ChipStatus; kind: RunningChip["kind"] }) {
  switch (status) {
    case "running":
      return kind === "shell" ? (
        <span aria-hidden className="size-[6px] shrink-0 animate-pulse rounded-full bg-(--color-status-running)" />
      ) : (
        <Loader2 aria-hidden className="size-[11px] shrink-0 animate-spin text-(--color-text-muted)" />
      );
    case "done":
      return (
        <span aria-hidden className="shrink-0 text-(--color-success)">
          ✓
        </span>
      );
    case "failed":
      return (
        <span aria-hidden className="shrink-0 text-(--color-danger)">
          ✗
        </span>
      );
    case "stopped":
      return <Square aria-hidden className="size-[8px] shrink-0 text-(--color-text-muted)" fill="currentColor" />;
  }
}

function PinToggle({ taskId, chip }: { taskId: string; chip: RunningChip }) {
  const togglePin = useSubagentStore((s) => s.togglePin);
  return (
    <button
      type="button"
      onClick={() => togglePin(taskId, chip.id)}
      aria-pressed={chip.pinned}
      aria-label={chip.pinned ? `Unpin ${chip.label}` : `Pin ${chip.label}`}
      title={chip.pinned ? "Unpin" : "Pin: keep it here after it finishes"}
      data-pin
      className={cn(
        iconButton,
        chip.pinned
          ? "text-(--color-accent-500) hover:text-(--color-accent-400)"
          : "opacity-0 group-hover/chip:opacity-100 group-focus-within/chip:opacity-100 focus-visible:opacity-100",
      )}
    >
      <Pin className="size-[11px]" aria-hidden fill={chip.pinned ? "currentColor" : "none"} />
    </button>
  );
}

function DismissButton({ taskId, chip }: { taskId: string; chip: RunningChip }) {
  const dismiss = useSubagentStore((s) => s.dismissChip);
  return (
    <button
      type="button"
      onClick={() => dismiss(taskId, chip.id)}
      aria-label={`Dismiss ${chip.label}`}
      title="Dismiss"
      className={cn(iconButton, "mr-[3px]")}
    >
      <X className="size-[12px]" aria-hidden />
    </button>
  );
}

function SubagentChip({ taskId, chip }: { taskId: string; chip: RunningChip }) {
  const select = useSubagentStore((s) => s.selectSubagent);
  const selected = useSelectedSubagent(taskId) === chip.id;
  const running = chip.status === "running";
  return (
    <div className={cn(chipShell, selected ? "bg-(--color-bg-hover) text-(--color-text-primary)" : "bg-(--color-bg-elevated)")}>
      <button
        type="button"
        onClick={() => select(taskId, chip.id)}
        aria-current={selected || undefined}
        aria-label={`Open subagent ${chip.label}, ${STATUS_WORD[chip.status]}, ${stepsLabel(chip.steps)}`}
        title={chip.agentType ? `${chip.label} · ${chip.agentType}` : chip.label}
        className={cn(chipMain, "max-w-[240px] pl-[6px]")}
      >
        <AgentMark agent="claude" size="xs" className="opacity-90" />
        <span className="min-w-0 truncate">{chip.label}</span>
        <span className="shrink-0 tabular-nums text-(--color-text-muted)" data-chip-steps={chip.steps}>
          {stepsLabel(chip.steps)}
        </span>
        <StatusGlyph status={chip.status} kind="subagent" />
      </button>
      <span className={cn("flex items-center", running && "mr-[3px]")}>
        <PinToggle taskId={taskId} chip={chip} />
      </span>
      {!running ? <DismissButton taskId={taskId} chip={chip} /> : null}
    </div>
  );
}

function ShellChip({ taskId, chip, now }: { taskId: string; chip: RunningChip; now: number }) {
  const focus = useTranscriptFocus((s) => s.focus);
  const [stopping, setStopping] = useState(false);
  const running = chip.status === "running";
  const elapsed = formatElapsed(chip.startedAt, running || chip.endedAt === undefined ? now : chip.endedAt);
  const stop = () => {
    setStopping(true);
    transcriptApi.stopBackgroundShell(taskId, chip.id).catch((err) => {
      setStopping(false);
      // Already over: the chip shows its end on the next update anyway.
      if (String(err).includes("isn't running")) return;
      showToast({ intent: "error", title: "Couldn't stop the command", message: humanizeError(err) });
    });
  };
  return (
    <div className={cn(chipShell, "bg-(--color-bg-elevated)", stopping && running && "opacity-60")}>
      <button
        type="button"
        onClick={() => focus(taskId, chip.id)}
        title={chip.label}
        aria-label={`Show background command ${chip.label}, ${running ? `running for ${elapsed}` : STATUS_WORD[chip.status]}`}
        className={cn(chipMain, "max-w-[280px]")}
      >
        <StatusGlyph status={chip.status} kind="shell" />
        <span className="min-w-0 truncate font-mono text-[11.5px]">{chip.label}</span>
        {elapsed && (running || chip.endedAt !== undefined) ? (
          <span className="shrink-0 tabular-nums text-(--color-text-muted)">{elapsed}</span>
        ) : null}
      </button>
      <PinToggle taskId={taskId} chip={chip} />
      {running ? (
        <button
          type="button"
          onClick={stop}
          disabled={stopping}
          aria-label={`Stop ${chip.label}`}
          title="Stop this command"
          className={cn(iconButton, "mr-[3px]")}
        >
          <X className="size-[12px]" aria-hidden />
        </button>
      ) : (
        <DismissButton taskId={taskId} chip={chip} />
      )}
    </div>
  );
}

/** "+N": the chips that don't fit, as a menu. */
function MoreMenu({ taskId, chips }: { taskId: string; chips: RunningChip[] }) {
  const select = useSubagentStore((s) => s.selectSubagent);
  const focus = useTranscriptFocus((s) => s.focus);
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`${chips.length} more`}
          data-running-more
          className="flex h-[26px] w-[36px] shrink-0 items-center justify-center rounded-(--radius-chip) bg-(--color-bg-elevated) tabular-nums text-(--color-text-secondary) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus) data-[state=open]:bg-(--color-bg-hover)"
        >
          +{chips.length}
        </button>
      </MenuTrigger>
      <MenuContent align="end" side="top" width={280}>
        {chips.map((chip) => (
          <MenuItem
            key={chip.id}
            onSelect={() => (chip.kind === "subagent" ? select(taskId, chip.id) : focus(taskId, chip.id))}
            icon={chip.kind === "subagent" ? <AgentMark agent="claude" size="xs" /> : <StatusGlyph status={chip.status} kind="shell" />}
            trailing={
              <span className="flex shrink-0 items-center gap-[6px] tabular-nums text-(--color-text-muted)">
                {chip.kind === "subagent" ? stepsLabel(chip.steps) : null}
                {chip.kind === "subagent" ? <StatusGlyph status={chip.status} kind="subagent" /> : null}
                {chip.pinned ? <Pin className="size-[10px] text-(--color-accent-500)" fill="currentColor" aria-label="pinned" /> : null}
              </span>
            }
          >
            <span className={chip.kind === "shell" ? "font-mono text-[11.5px]" : undefined}>{chip.label}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
