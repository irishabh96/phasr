import { useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "@/lib/utils";

export interface StrategyOption<V extends string> {
  value: V;
  label: string;
  hint: string;
}

/**
 * The shared strategy radio group (Merge-to-main / Ship / Sync). A REAL
 * radiogroup, not a stack of buttons: one tab stop (roving tabindex on the
 * selected row), Arrow/Home/End move BOTH focus and selection (the standard
 * radio pattern), `role=radio` + `aria-checked` on every row. Extracted from
 * MergeToMainDialog's hand-rolled rows, which had the ARIA roles but no
 * keyboard model; SyncButton's rows had neither.
 *
 * Visuals are the established row treatment: calm rest, `--color-bg-hover`
 * hover, `--color-bg-active` + coral dot when selected, focus ring via
 * `--color-accent-300`. Disabled dims the whole group (in-flight merge).
 */
export function StrategyRadioGroup<V extends string>({
  legend,
  options,
  value,
  onChange,
  disabled,
}: {
  /** Visible group label (uppercase micro-legend). */
  legend: string;
  options: readonly StrategyOption<V>[];
  value: V;
  onChange: (next: V) => void;
  disabled?: boolean;
}) {
  const rowRefs = useRef<Map<V, HTMLButtonElement>>(new Map());

  const move = (from: V, delta: number) => {
    const idx = options.findIndex((o) => o.value === from);
    if (idx === -1) return;
    const next =
      options[(idx + delta + options.length) % options.length]!.value;
    onChange(next);
    rowRefs.current.get(next)?.focus();
  };

  const jump = (to: V) => {
    onChange(to);
    rowRefs.current.get(to)?.focus();
  };

  const onKeyDown = (e: ReactKeyboardEvent, current: V) => {
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        move(current, 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        move(current, -1);
        break;
      case "Home":
        e.preventDefault();
        jump(options[0]!.value);
        break;
      case "End":
        e.preventDefault();
        jump(options[options.length - 1]!.value);
        break;
    }
  };

  return (
    <fieldset role="radiogroup" aria-label={legend} className="space-y-1">
      <legend className="mb-1 text-[11px] uppercase tracking-[0.12em] text-(--color-text-muted)">
        {legend}
      </legend>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              if (el) rowRefs.current.set(option.value, el);
              else rowRefs.current.delete(option.value);
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex: the group is ONE tab stop, on the selection.
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => onKeyDown(e, option.value)}
            className={cn(
              "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-100",
              "hover:bg-(--color-bg-hover)",
              "focus-visible:bg-(--color-bg-hover) focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--color-accent-300)]",
              "disabled:opacity-40 disabled:pointer-events-none",
              selected && "bg-(--color-bg-active)",
            )}
          >
            <span
              className={cn(
                "mt-[3px] inline-block h-3 w-3 shrink-0 rounded-full border",
                selected
                  ? "border-(--color-accent-500) bg-(--color-accent-500)"
                  : "border-(--glass-border-hairline)",
              )}
              aria-hidden
            />
            <span className="flex flex-1 flex-col gap-0.5">
              <span className="text-[12.5px] leading-none text-(--color-text-primary)">
                {option.label}
              </span>
              <span className="text-[11px] text-(--color-text-secondary)">
                {option.hint}
              </span>
            </span>
          </button>
        );
      })}
    </fieldset>
  );
}
