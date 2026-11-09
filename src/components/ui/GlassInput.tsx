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
  "bg-(--color-bg-input)",
  "text-(--color-text-primary) placeholder:text-(--color-text-muted)",
  "border border-(--color-border-default)",
  "rounded-(--radius-control)",
  "transition-[border-color,box-shadow] duration-100",
  "outline-none",
  "hover:border-(--color-border-strong)",
  "focus:border-(--color-focus-ring)",
  "focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-focus-ring)_22%,transparent)]",
  "aria-[invalid=true]:border-(--color-danger)",
  "disabled:opacity-50 disabled:cursor-not-allowed",
].join(" ");

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const GlassInput = forwardRef<HTMLInputElement, InputProps>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(inputBaseClasses, "h-8 px-2.5 text-[13px]", className)}
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
          "py-2.5 px-3 text-[13px] resize-none leading-[1.55]",
          className,
        )}
        {...props}
      />
    );
  },
);
GlassTextarea.displayName = "GlassTextarea";
