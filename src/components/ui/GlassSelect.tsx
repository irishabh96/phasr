import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type SelectHTMLAttributes,
} from "react";
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
 * an input read as a matched set.
 *
 * WHY the value is rendered as an overlay <span> instead of the native text:
 * a WebKit/Blink `<select>` with `appearance: none` does NOT reliably paint its
 * CLOSED selected value with the CSS `color` (nor `-webkit-text-fill-color`, nor
 * the selected option's color — all verified via Playwright screenshots). On
 * phasr's dark surface the value fell back to a near-black system color →
 * "dark-on-dark", the unreadable dropdowns users reported. So we hide the native
 * value paint (`text-transparent`) and render the selected label as a normal DOM
 * span (fully CSS-controllable, legible in every engine). The native <select>
 * stays fully functional — click-to-open popup, keyboard, a11y, and Playwright
 * `selectOption` all operate on the real control underneath. The popup <option>s
 * are colored explicitly so the open menu stays readable too.
 */
export const GlassSelect = forwardRef<HTMLSelectElement, GlassSelectProps>(
  (
    { className, options, placeholder, children, onChange, ...props },
    forwardedRef,
  ) => {
    const innerRef = useRef<HTMLSelectElement | null>(null);
    const setRef = useCallback(
      (el: HTMLSelectElement | null) => {
        innerRef.current = el;
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      },
      [forwardedRef],
    );

    // The label + placeholder-ness of the currently-selected option, read from
    // the live DOM so it works whether options come from the `options` prop OR
    // <option> children, controlled or uncontrolled.
    const [display, setDisplay] = useState<{ label: string; muted: boolean }>({
      label: "",
      muted: false,
    });
    const sync = useCallback(() => {
      const el = innerRef.current;
      if (!el) return;
      const opt = el.selectedOptions[0];
      setDisplay({
        label: opt?.textContent ?? "",
        muted: opt?.disabled === true || el.value === "",
      });
    }, []);
    // Re-sync on mount and whenever the value/option set changes.
    useLayoutEffect(sync, [sync, props.value, props.defaultValue, options, children]);

    const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
      onChange?.(e);
      sync();
    };

    return (
      <div className="relative">
        <select
          ref={setRef}
          onChange={handleChange}
          className={cn(
            inputBaseClasses,
            "h-9 cursor-pointer appearance-none pl-3 pr-9 text-[13px]",
            // Hide the (unreliable) native value paint; the overlay span renders
            // it. Keep the popup <option>s explicitly readable in both engines.
            "text-transparent [&>option]:bg-(--color-bg-dropdown) [&>option]:text-(--color-text-primary)",
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
        {/* The engine-proof value display (see the note above). Inherits the
            field's left padding + vertical centring; `right-9` clears the
            chevron; `truncate` handles long labels. */}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 left-3 right-9 flex items-center truncate text-[13px]",
            display.muted
              ? "text-(--color-text-muted)"
              : "text-(--color-text-primary)",
          )}
        >
          {display.label}
        </span>
        <ChevronDown
          className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-(--color-text-muted)"
          aria-hidden="true"
        />
      </div>
    );
  },
);
GlassSelect.displayName = "GlassSelect";
