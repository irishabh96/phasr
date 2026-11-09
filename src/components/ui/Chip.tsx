import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "success" | "warning" | "danger" | "outline";

const TONES: Record<Tone, string> = {
  neutral: "bg-(--color-bg-elevated) text-(--color-text-muted)",
  success: "bg-(--color-success-tint) text-(--color-success)",
  warning: "bg-(--color-warning-tint) text-(--color-warning)",
  danger: "bg-(--color-danger-tint) text-(--color-danger-text)",
  outline:
    "border border-(--color-border-default) bg-(--color-bg-surface) text-(--color-text-secondary)",
};

/** Radius-4 chip: "tests ✓", "approval", "7 files", `phasr/branch`. */
export function Chip({
  tone = "neutral",
  mono = false,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; mono?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-(--radius-chip) px-1.5 py-0.5 text-[11px] leading-[1.3]",
        mono && "font-mono",
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

/**
 * Property chip (A-Polish): 26px, radius 6, 12px, a 1px --color-border-default
 * border. It is the one bordered element in the app: the border signals
 * "editable value". Icon · value · caret; it opens a popover, so it forwards
 * its ref and props for use as a Radix `asChild` trigger. `mono` is for
 * branch and path values only.
 */
export const PropertyChip = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon?: ReactNode;
    mono?: boolean;
    /** Trailing caret; on by default since the chip opens a popover. */
    caret?: boolean;
  }
>(({ icon, mono = false, caret = true, className, children, type = "button", ...rest }, ref) => (
  <button
    ref={ref}
    type={type}
    className={cn(
      "inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-(--radius-control) px-2",
      "border border-(--color-border-default) bg-transparent text-[12px] leading-none text-(--color-text-primary)",
      "transition-[background-color,scale] duration-(--dur-1) ease-(--ease-out) motion-safe:active:scale-[.98]",
      "hover:bg-(--color-bg-elevated) data-[state=open]:bg-(--color-bg-elevated)",
      "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
      "disabled:pointer-events-none disabled:text-(--color-text-faint)",
      className,
    )}
    {...rest}
  >
    {icon ? (
      <span aria-hidden className="grid shrink-0 place-items-center text-(--color-text-muted) [&_svg]:size-3.5">
        {icon}
      </span>
    ) : null}
    <span className={cn("min-w-0 truncate", mono && "font-mono")}>{children}</span>
    {caret ? (
      <ChevronDown aria-hidden className="size-3 shrink-0 text-(--color-text-muted)" strokeWidth={2} />
    ) : null}
  </button>
));
PropertyChip.displayName = "PropertyChip";

/**
 * `+212 −48` in mono, green/red. It stays mono: the design treats the diff
 * stat as a code-ish value (A-Polish rule 6). Zero sides still render.
 */
export function DiffCount({
  adds,
  removes,
  className,
  hideRemovesWhenZero = false,
}: {
  adds: number;
  removes?: number;
  className?: string;
  hideRemovesWhenZero?: boolean;
}) {
  return (
    <span className={cn("whitespace-nowrap font-mono text-[11px]", className)}>
      <span className="text-(--diff-add-fg)">+{adds}</span>
      {removes !== undefined && !(hideRemovesWhenZero && removes === 0) ? (
        <>
          {" "}
          <span className="text-(--diff-remove-fg)">−{removes}</span>
        </>
      ) : null}
    </span>
  );
}
