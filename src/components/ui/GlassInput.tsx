import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Shared field chrome (A-Polish "Inputs"): inset background, no border, a
 * 1px hairline ring; focus is an accent ring + a 4px accent glow at 14%.
 * Exported so `GlassSelect` and `BaseBranchField` render as a matched set.
 */
export const inputBaseClasses = [
  "block w-full",
  "bg-(--color-bg-input)",
  "text-(--color-text-primary) placeholder:text-(--color-text-muted)",
  "border-0 shadow-(--ring-input)",
  "rounded-(--radius-control)",
  "transition-[box-shadow] duration-(--dur-1) ease-(--ease-out)",
  "outline-none",
  "hover:shadow-(--ring-input-hover)",
  "focus:shadow-(--ring-input-focus)",
  "aria-[invalid=true]:shadow-(--ring-input-invalid)",
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
