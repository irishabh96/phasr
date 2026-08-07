import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The done-checkbox for a note row.
 *
 * Drawn in `--color-text-muted`, NOT a border token: the border tokens
 * measure 1.42–2.28:1 against the panel surface, below WCAG's 3:1 for a
 * control identified by its boundary. Text-muted is 6.15:1 dark /
 * 6.08:1 light, so the box is unambiguously visible in both themes.
 *
 * No accent colour, deliberately. Done is history — the least important
 * content in the panel — and a coral wall of completed items would
 * invert the hierarchy. Checking reads as subtraction: the box fills,
 * the body steps back a tone, the row goes quiet.
 *
 * `tabIndex={-1}` because the list runs a roving tabindex: the ROW is
 * the tab stop and Space toggles from there. The box stays clickable
 * and keeps its own accessible name for screen readers.
 */
export function NoteCheckbox({
  checked,
  onToggle,
  className,
}: {
  checked: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={checked ? "Mark as not done" : "Mark as done"}
      tabIndex={-1}
      onClick={(e) => {
        // The row also handles clicks (double-click edits); a tick is
        // its own action and must not start an edit.
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        // 28px hit area around a 14px glyph — matches the ⋯ button, and
        // the row rhythm can't carry a 32px target in a 300px rail.
        "grid h-7 w-7 shrink-0 place-items-center rounded-[6px]",
        "hover:bg-(--color-bg-elevated)",
        "focus-visible:outline-none focus-visible:shadow-[var(--ring-focus)]",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid h-[14px] w-[14px] place-items-center rounded-[4px] border",
          "transition-colors duration-100 motion-reduce:transition-none",
          checked
            ? "border-(--color-text-muted) bg-(--color-text-muted)"
            : "border-(--color-text-muted) bg-transparent group-hover:border-(--color-text-secondary)",
        )}
      >
        {checked && (
          <Check
            size={10}
            strokeWidth={3}
            // Knocked out of the fill, so it inherits the surface colour.
            className="text-(--color-bg-surface)"
          />
        )}
      </span>
    </button>
  );
}
