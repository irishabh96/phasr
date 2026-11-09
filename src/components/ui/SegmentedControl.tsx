import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Colour the label (e.g. "Skip all" in attention amber). */
  tone?: "default" | "warning";
  disabled?: boolean;
  title?: string;
}

/**
 * Joined toggle group (Board/List, Unified/Split, Worktree/In place).
 * A radiogroup: arrow keys move, the selected segment is the tab stop.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "sm",
  fill = false,
  className,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  label: string;
  size?: "sm" | "md";
  /** Stretch segments to fill the container (form fields). */
  fill?: boolean;
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((o) => !o.disabled);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const dir = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const idx = enabled.findIndex((o) => o.value === value);
    const next = enabled[(idx + dir + enabled.length) % enabled.length];
    if (!next) return;
    onChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "inline-flex overflow-hidden rounded-(--radius-control) border border-(--color-border-default)",
        fill && "flex w-full",
        className,
      )}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "whitespace-nowrap px-2.5 text-[12px] transition-colors duration-100",
              size === "sm" ? "h-7" : "h-[30px]",
              fill && "flex-1 px-1.5",
              "focus-visible:relative focus-visible:outline-none focus-visible:shadow-(--ring-focus-inset)",
              "disabled:cursor-not-allowed disabled:opacity-40",
              selected
                ? "bg-(--color-bg-elevated) text-(--color-text-primary)"
                : o.tone === "warning"
                  ? "text-(--color-warning) hover:bg-(--color-bg-hover)"
                  : "text-(--color-text-muted) hover:bg-(--color-bg-hover) hover:text-(--color-text-secondary)",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
