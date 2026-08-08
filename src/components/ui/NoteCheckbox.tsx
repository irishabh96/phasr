import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The done-checkbox for a note row.
 *
 * Drawn in `--color-text-muted`, NOT a border token: the border tokens
 * measure 1.42–2.28:1 against the panel surface, below WCAG's 3:1 for a
 * control identified by its boundary. Text-muted is 6.15:1 dark /
 * 6.08:1 light.
 *
 * GEOMETRY IS IN EXPLICIT PX ON PURPOSE. `html { font-size: 13px }`
 * (index.css) makes Tailwind's rem spacing scale render at 0.8125× —
 * `h-7` is 22.75px, not 28. This button previously used `h-7` and
 * claimed a 28px hit area in a comment; it was 22.75px and failed WCAG
 * 2.2 SC 2.5.8's 24×24 minimum. Negative margins keep the 24px target
 * while the button occupies exactly the 14px grid column and the 20px
 * first line box, so it never changes row height.
 *
 * No accent colour: done is history, and a wall of coral ticks would
 * invert the panel's hierarchy. Checking reads as subtraction.
 *
 * `tabIndex={-1}` because the list runs a roving tabindex — the ROW is
 * the tab stop and Space toggles from there.
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
        // The row handles double-click to edit; a tick is its own action.
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(
        "grid h-[24px] w-[24px] -mx-[5px] -my-[2px] shrink-0 place-items-center rounded-[5px]",
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
            className="text-(--color-bg-surface)"
          />
        )}
      </span>
    </button>
  );
}
