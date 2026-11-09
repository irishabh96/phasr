import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keyboard hint chip: mono 10px, 1px strong border, radius 4 (A-System). */
export function Kbd({
  children,
  tone = "default",
  className,
  decorative = false,
}: {
  children: ReactNode;
  /** `onfill` sits inside a primary (accent) button: no border, 70% ink. */
  tone?: "default" | "onfill" | "bare";
  className?: string;
  /** Decorative inside a labelled control (keeps "Start task" its name). */
  decorative?: boolean;
}) {
  return (
    <kbd
      aria-hidden={decorative || undefined}
      className={cn(
        "inline-flex items-center font-mono text-[10px] font-medium leading-none",
        tone === "default" &&
          "rounded-(--radius-chip) border border-(--color-border-strong) px-[5px] py-[2px] text-(--color-text-muted)",
        tone === "onfill" && "opacity-70",
        tone === "bare" && "text-(--color-text-muted)",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
