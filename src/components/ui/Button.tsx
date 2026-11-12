import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/Kbd";

/**
 * A-Polish buttons: 28px, radius 6, 13px. No boxed buttons for secondary
 * actions; one filled accent primary per screen.
 * - primary: accent fill + a 1px inset top highlight.
 * - secondary: raised fill, no border.
 * - ghost: text-2 on transparent; hover raises.
 * - danger: red text, ghost-style (Stop, Discard). The solid red
 *   `danger-solid` is reserved for the confirm step of a destructive dialog.
 * - dashed: legacy "add" affordance; screen agents are replacing it with
 *   ghost text rows.
 * Hover is +1 surface step; press is scale(.98) over --dur-1 (skipped under
 * reduced motion); focus keeps the standard --ring-focus.
 */
export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 select-none whitespace-nowrap",
    "rounded-(--radius-control) border border-transparent text-[13px] leading-none",
    "transition-[color,background-color,box-shadow,scale] duration-(--dur-1) ease-(--ease-out)",
    "motion-safe:active:scale-[.98]",
    "disabled:pointer-events-none disabled:text-(--color-text-faint)",
    "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: [
          "bg-(--color-accent-500) font-medium text-(--color-accent-onfill) shadow-(--shadow-button-primary)",
          "hover:bg-(--color-accent-400) active:bg-(--color-accent-600)",
          "disabled:text-(--color-accent-onfill) disabled:opacity-40",
        ].join(" "),
        secondary: [
          "bg-(--color-bg-elevated) text-(--color-text-primary)",
          "hover:bg-(--color-bg-hover) active:bg-(--color-bg-active)",
          "disabled:bg-(--color-bg-surface)",
        ].join(" "),
        ghost: [
          "bg-transparent text-(--color-text-secondary)",
          "hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
          "active:bg-(--color-bg-hover)",
        ].join(" "),
        danger: [
          "bg-transparent text-(--color-danger-text)",
          "hover:bg-(--color-danger-tint) active:bg-(--color-danger-tint)",
        ].join(" "),
        "danger-solid": [
          "bg-(--color-danger-solid) font-medium text-white",
          "hover:brightness-110 active:brightness-90",
          "disabled:text-white disabled:opacity-40",
        ].join(" "),
        dashed: [
          "border-dashed border-(--color-border-default) bg-transparent text-(--color-text-muted)",
          "hover:border-(--color-border-strong) hover:text-(--color-text-secondary)",
        ].join(" "),
      },
      size: {
        sm: "h-7 px-2.5",
        md: "h-8 px-3",
        lg: "h-9 px-4",
        icon: "size-7 px-0",
        "icon-md": "size-8 px-0",
      },
    },
    compoundVariants: [
      // The single filled action is a touch wider (A-Polish: 0 12px).
      { variant: "primary", size: "sm", className: "px-3" },
    ],
    defaultVariants: { variant: "secondary", size: "sm" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    /** Key labels rendered as a trailing <Kbd>, e.g. ["⌘", "N"]. */
    shortcut?: string;
    /** Trailing caret for buttons that open a menu. */
    menu?: boolean;
    icon?: ReactNode;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, type = "button", shortcut, menu, icon, children, ...props },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {icon}
      {children}
      {shortcut ? (
        <Kbd decorative tone={variant === "primary" ? "onfill" : "default"}>
          {shortcut}
        </Kbd>
      ) : null}
      {menu ? (
        <ChevronDown aria-hidden className="size-3 text-(--color-text-muted)" strokeWidth={2} />
      ) : null}
    </button>
  ),
);
Button.displayName = "Button";
