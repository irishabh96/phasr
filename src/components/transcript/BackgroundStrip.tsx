import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { useNow } from "@/lib/hooks/useNow";
import { humanizeError } from "@/lib/humanizeError";
import { showToast } from "@/lib/toast";
import { transcriptApi } from "@/lib/transcript/contract";
import { useTranscriptFocus } from "@/lib/transcript/focus";
import { formatElapsed, runningBackgroundShells, type BackgroundShell } from "@/lib/transcript/tree";
import { useTranscript } from "@/lib/transcript/useTranscript";
import { cn } from "@/lib/utils";

/**
 * "Background": the commands Claude left running (Bash with
 * `run_in_background`), docked just above the composer in the agent pane.
 * One chip per command — a status dot, the command, how long it's run.
 * A chip shows its item in the transcript (scrolled to, output expanded);
 * its × stops the command (the CLI's `stop_task`; the turn goes on).
 * Nothing renders while none are running.
 */
export function BackgroundStrip({ taskId }: { taskId: string }) {
  const query = useTranscript(taskId);
  const shells = useMemo(() => runningBackgroundShells(query.data ?? []), [query.data]);
  if (shells.length === 0) return null;
  return (
    <div
      role="group"
      aria-label="Background commands"
      data-testid="background-strip"
      className="flex shrink-0 items-center gap-[8px] overflow-x-auto bg-(--color-bg-base) px-[24px] pt-[8px] font-mono text-[12px]"
    >
      <span className="shrink-0 font-sans text-[11px] font-medium tracking-[0.02em] text-(--color-text-muted)">Background</span>
      {shells.map((shell) => (
        <BackgroundChip key={shell.id} taskId={taskId} shell={shell} />
      ))}
    </div>
  );
}

function BackgroundChip({ taskId, shell }: { taskId: string; shell: BackgroundShell }) {
  const now = useNow(true);
  const focus = useTranscriptFocus((s) => s.focus);
  const [stopping, setStopping] = useState(false);
  const elapsed = formatElapsed(shell.startedAt, now);
  const stop = () => {
    setStopping(true);
    transcriptApi.stopBackgroundShell(taskId, shell.id).catch((err) => {
      setStopping(false);
      // Already over: the strip drops it on the next update anyway.
      if (String(err).includes("isn't running")) return;
      showToast({ intent: "error", title: "Couldn't stop the command", message: humanizeError(err) });
    });
  };
  return (
    <div
      data-background-chip={shell.id}
      className={cn(
        "flex h-[26px] max-w-[320px] shrink-0 items-center rounded-(--radius-chip) bg-(--color-bg-elevated) text-(--color-text-secondary)",
        stopping && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={() => focus(taskId, shell.id)}
        title={shell.command}
        aria-label={`Show background command ${shell.command}, running for ${elapsed}`}
        className="flex h-full min-w-0 items-center gap-[6px] rounded-(--radius-chip) pl-[8px] pr-[6px] transition-colors duration-(--dur-1) ease-(--ease-out) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
      >
        <span aria-hidden className="size-[6px] shrink-0 animate-pulse rounded-full bg-(--color-status-running)" />
        <span className="min-w-0 truncate">{shell.command}</span>
        <span className="shrink-0 tabular-nums text-(--color-text-muted)">{elapsed}</span>
      </button>
      <button
        type="button"
        onClick={stop}
        disabled={stopping}
        aria-label={`Stop ${shell.command}`}
        title="Stop this command"
        className="mr-[2px] flex size-[22px] shrink-0 items-center justify-center rounded-(--radius-chip) text-(--color-text-muted) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus) disabled:pointer-events-none"
      >
        <X className="size-[12px]" aria-hidden />
      </button>
    </div>
  );
}
