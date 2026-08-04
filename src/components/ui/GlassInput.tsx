import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Shared field chrome — border/hover/focus/disabled tokens. Exported so
 * `GlassSelect` renders as a visually matched set with the input/textarea.
 */
export const inputBaseClasses = [
  "block w-full",
  "bg-[color-mix(in_oklab,var(--color-bg-input)_70%,transparent)]",
  "backdrop-blur-md",
  "text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)]",
  "border border-[var(--glass-border-hairline)]",
  "rounded-[10px]",
  "transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
  "outline-none",
  "hover:border-[var(--color-border-strong)]",
  "focus:border-[var(--color-focus-ring)]",
  "focus:shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-focus-ring)_22%,transparent)]",
  "disabled:opacity-50 disabled:cursor-not-allowed",
].join(" ");

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const GlassInput = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(inputBaseClasses, "h-9 px-3 text-[13px]", className)}
        {...props}
      />
    );
  },
);
GlassInput.displayName = "GlassInput";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const GlassTextarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, rows = 3, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        rows={rows}
        className={cn(
          inputBaseClasses,
          "py-2 px-3 text-[13px] resize-none leading-relaxed",
          className,
        )}
        {...props}
      />
    );
  },
);
GlassTextarea.displayName = "GlassTextarea";
