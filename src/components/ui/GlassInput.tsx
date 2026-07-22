import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
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
  "focus:border-[var(--color-accent-500)]",
  "focus:shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-accent-500)_12%,transparent)]",
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

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /**
   * Grow the field to fit its content (up to any `max-height` set via
   * `className`, after which it scrolls internally). `rows` still sets the
   * MINIMUM height. Opt-in so existing fixed-height callers are unchanged.
   */
  autoGrow?: boolean;
}

export const GlassTextarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, rows = 3, autoGrow = false, value, ...props }, ref) => {
    const innerRef = useRef<HTMLTextAreaElement | null>(null);

    // Merge the forwarded ref with our own so auto-grow can measure the node.
    const setRef = useCallback(
      (node: HTMLTextAreaElement | null) => {
        innerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    // Reset to `auto` then snap to scrollHeight so the field both grows AND
    // shrinks with its content. Runs before paint (no visible reflow jump).
    useLayoutEffect(() => {
      if (!autoGrow) return;
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }, [autoGrow, value]);

    return (
      <textarea
        ref={setRef}
        rows={rows}
        value={value}
        className={cn(
          inputBaseClasses,
          "py-2 px-3 text-[13px] resize-none leading-relaxed",
          autoGrow && "overflow-y-auto",
          className,
        )}
        {...props}
      />
    );
  },
);
GlassTextarea.displayName = "GlassTextarea";
