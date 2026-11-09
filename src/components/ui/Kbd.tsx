import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Keyboard hint chip: mono 10px on a filled step, radius 4. No border
 * (A-Polish: the property chip is the only bordered element).
 */
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
          "rounded-(--radius-chip) bg-(--color-bg-hover) px-[5px] py-[3px] text-(--color-text-secondary)",
        tone === "onfill" && "opacity-70",
        tone === "bare" && "text-(--color-text-muted)",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
