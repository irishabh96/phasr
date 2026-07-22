import { useId, type CSSProperties } from "react";
import { Navigation } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The driving-chip dot reuses the system `pulse-dot` glow keyframe (index.css) —
 * the SAME idiom as the working-status dot — instead of Tailwind's opacity-based
 * `animate-pulse`, so the app has one pulse language (L3). Muted, never coral;
 * reduced-motion is handled globally in index.css.
 */
const DRIVING_DOT_STYLE: CSSProperties = {
  ["--pulse-color" as string]: "var(--color-text-muted)",
  animation: "pulse-dot 2s ease-in-out infinite",
};

/**
 * The per-epic Autopilot toggle (Phase 5a, Stage A, §7). A NEUTRAL affordance —
 * never coral, and NOT a status color: autopilot is a MODE, not a status. On =
 * "the driver advances this epic's gate ladder"; off = manual. When on AND
 * actively advancing a ticket, a calm ambient "Autopilot driving" chip sits
 * beside it (also neutral).
 *
 * Presentational + pure: the connected header owns `useSetAutopilot`, and
 * `/design-test` renders it directly with fixtures (no IPC).
 */
export function AutopilotToggle({
  enabled,
  driving = false,
  pending = false,
  onToggle,
}: {
  enabled: boolean;
  /** Any ticket in this epic is currently autopilot-owned (an AUTO next-gate). */
  driving?: boolean;
  pending?: boolean;
  onToggle: (next: boolean) => void;
}) {
  const labelId = useId();

  return (
    <div className="inline-flex items-center gap-2" data-testid="autopilot">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-labelledby={labelId}
        disabled={pending}
        data-testid="autopilot-toggle"
        data-autopilot-enabled={enabled}
        onClick={() => onToggle(!enabled)}
        className={cn(
          "group inline-flex items-center gap-2 rounded-full border px-2.5 py-1",
          "transition-colors duration-150 focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
          "disabled:opacity-50",
          enabled
            ? "border-(--color-border-strong) bg-(--color-bg-selected)"
            : "border-(--color-border-default) bg-(--color-bg-surface) hover:bg-(--color-bg-hover)",
        )}
      >
        <Navigation
          className={cn(
            "size-[13px]",
            enabled
              ? "text-(--color-text-primary)"
              : "text-(--color-text-muted)",
          )}
          aria-hidden="true"
        />
        <span
          id={labelId}
          className="text-[12px] font-medium text-(--color-text-primary)"
        >
          Autopilot
        </span>
        {/* The switch track — neutral, never a status/accent color. */}
        <span
          aria-hidden="true"
          className={cn(
            "relative inline-flex h-[16px] w-[28px] shrink-0 items-center rounded-full transition-colors duration-150",
            enabled ? "bg-(--color-text-secondary)" : "bg-(--color-border-strong)",
          )}
        >
          <span
            className={cn(
              "inline-block size-[12px] rounded-full bg-(--color-bg-base) shadow-sm transition-transform duration-150",
              enabled ? "translate-x-[14px]" : "translate-x-[2px]",
            )}
          />
        </span>
      </button>

      {enabled && driving ? <AutopilotDrivingChip /> : null}
    </div>
  );
}

/**
 * The calm ambient "Autopilot driving" chip (§7) — neutral, never coral. A soft
 * pulsing dot signals the driver is actively advancing a ticket without shouting
 * for attention.
 */
export function AutopilotDrivingChip() {
  return (
    <span
      role="status"
      data-testid="autopilot-driving-chip"
      className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full border border-(--color-border-default) bg-(--color-bg-surface) px-2 text-[11.5px] font-medium leading-none text-(--color-text-secondary)"
    >
      <span
        aria-hidden="true"
        className="inline-block size-[7px] rounded-full bg-(--color-text-muted)"
        style={DRIVING_DOT_STYLE}
      />
      Autopilot driving
    </span>
  );
}
