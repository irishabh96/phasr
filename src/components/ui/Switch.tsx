import { cn } from "@/lib/utils";

/** 28×16 switch (A-System "Switch"): accent track when on. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
  id,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Accessible name when no visible <label for> points at it. */
  label?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors duration-100",
        "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
        "disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "bg-(--color-accent-500)" : "bg-(--color-border-strong)",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute top-0.5 size-3 rounded-full transition-[left] duration-100",
          checked ? "left-[14px] bg-(--color-accent-onfill)" : "left-0.5 bg-(--color-text-secondary)",
        )}
      />
    </button>
  );
}
