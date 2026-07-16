import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { inputBaseClasses } from "./GlassInput";

interface GlassSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /**
   * Options may be passed as data OR as <option>/<optgroup> children.
   * When both are given, `options` renders first.
   */
  options?: Array<{
    label: string;
    value: string;
    disabled?: boolean;
  }>;
  /** Optional leading placeholder rendered as a disabled first <option>. */
  placeholder?: string;
}

/**
 * Styled native <select> that shares GlassInput's field chrome so a select and
 * an input read as a matched set. A right-aligned chevron sits over the control
 * (pointer-events-none) with `appearance-none` + right padding to clear it.
 */
export const GlassSelect = forwardRef<HTMLSelectElement, GlassSelectProps>(
  ({ className, options, placeholder, children, ...props }, ref) => {
    // When the disabled placeholder option is the current value, dim the value
    // color so it reads as a prompt rather than a real selection.
    const isPlaceholder = props.value === "" || props.value === undefined;

    return (
      <div className="relative">
        <select
          ref={ref}
          className={cn(
            inputBaseClasses,
            "h-9 cursor-pointer appearance-none pl-3 pr-9 text-[13px]",
            placeholder != null && isPlaceholder && "text-(--color-text-muted)",
            className,
          )}
          {...props}
        >
          {placeholder != null && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options?.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-(--color-text-muted)"
          aria-hidden="true"
        />
      </div>
    );
  },
);
GlassSelect.displayName = "GlassSelect";
