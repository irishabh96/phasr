import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { LEVEL_HISTORY, type Dictation } from "@/lib/voice/useDictation";
import { formatElapsed } from "@/lib/voice/insert";
import { cn } from "@/lib/utils";

const ROUND =
  "grid size-[26px] shrink-0 place-items-center rounded-(--radius-control) transition-colors duration-(--dur-1) ease-(--ease-out) focus-visible:outline-none focus-visible:shadow-(--ring-focus) disabled:opacity-40";

/**
 * The dictation strip that stands in for a box's controls row while you
 * talk: a live waveform (newest on the right), the elapsed time, cancel
 * (Esc) and done (↵). Same 26px height as the row it replaces, so the box
 * never changes size.
 */
export function DictationBar({ dictation, className }: { dictation: Dictation; className?: string }) {
  const { phase, levels, startedAt, cancel, stop } = dictation;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (phase !== "recording") return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [phase]);

  return (
    <div
      role="group"
      aria-label="Dictation"
      data-dictation={phase}
      className={cn("flex h-[26px] min-w-0 flex-1 items-center gap-[10px]", className)}
    >
      {phase === "transcribing" || phase === "polishing" ? (
        <span role="status" className="flex min-w-0 flex-1 items-center gap-[8px] text-[12.5px] text-(--color-text-secondary)">
          <Loader2 aria-hidden className="size-[13px] shrink-0 animate-spin text-(--color-text-muted)" />
          <span className="truncate">
            {phase === "polishing" ? `Cleaning up with ${dictation.polisher?.label ?? "a fast model"}…` : "Transcribing…"}
          </span>
        </span>
      ) : phase === "starting" ? (
        <span role="status" className="flex min-w-0 flex-1 items-center gap-[8px] text-[12.5px] text-(--color-text-muted)">
          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-(--color-text-faint)" />
          Opening the microphone…
        </span>
      ) : (
        <>
          <span
            aria-hidden
            className="size-[7px] shrink-0 rounded-full bg-(--color-danger) animate-[pulse-skeleton_1.4s_ease-in-out_infinite]"
          />
          <Waveform levels={levels} />
          <span
            role="timer"
            aria-label="Recording time"
            className="shrink-0 font-mono text-[11.5px] tabular-nums text-(--color-text-secondary)"
          >
            {formatElapsed(startedAt ? now - startedAt : 0)}
          </span>
        </>
      )}
      <button
        type="button"
        aria-label={phase === "polishing" ? "Skip cleanup" : "Cancel dictation"}
        aria-keyshortcuts="Escape"
        title={phase === "polishing" ? "Keep the transcript as heard (Esc)" : "Cancel (Esc)"}
        onClick={cancel}
        className={cn(ROUND, "text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)")}
      >
        <X aria-hidden className="size-[14px]" strokeWidth={2.25} />
      </button>
      <button
        type="button"
        aria-label="Finish dictation"
        aria-keyshortcuts="Enter"
        title="Insert the text (↵)"
        disabled={phase !== "recording"}
        onClick={stop}
        className={cn(
          ROUND,
          "bg-(--color-accent-500) text-(--color-accent-onfill) hover:bg-(--color-accent-400)",
        )}
      >
        <Check aria-hidden className="size-[14px]" strokeWidth={2.5} />
      </button>
    </div>
  );
}

/**
 * One 2px bar per 50ms reading, newest at the right edge. The track is
 * always full: slots not yet recorded are faint baseline dots, and the
 * oldest readings slide off the left.
 */
function Waveform({ levels }: { levels: number[] }) {
  const pad = LEVEL_HISTORY - levels.length;
  return (
    <div
      aria-hidden
      data-testid="dictation-waveform"
      data-readings={levels.length}
      className="flex h-full min-w-0 flex-1 items-center justify-end gap-[2px] overflow-hidden"
    >
      {Array.from({ length: LEVEL_HISTORY }, (_, i) => {
        const l = i < pad ? null : levels[i - pad]!;
        const quiet = l === null || l < 0.03;
        return (
          <span
            key={i}
            className={cn(
              "w-[2px] shrink-0 rounded-full",
              quiet ? "bg-(--color-text-faint)" : "bg-(--color-accent-500)",
            )}
            style={{ height: quiet ? "2px" : `${Math.round(3 + Math.min(1, l!) * 15)}px` }}
          />
        );
      })}
    </div>
  );
}
