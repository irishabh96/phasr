import type { HTMLAttributes, ReactNode } from "react";
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

/** `+212 −48` in mono, green/red (A-System). Zero sides still render. */
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
