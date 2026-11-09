import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd } from "@/components/ui/Kbd";

/**
 * A-System buttons: 28 / 32 px, radius 6, one accent fill for the primary
 * action, everything else neutral. Danger is a tint (Stop, Discard); the
 * solid red is reserved for the confirm step of a destructive dialog.
 */
export const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-1.5 select-none whitespace-nowrap",
    "rounded-(--radius-control) border text-[12px] leading-none",
    "transition-colors duration-100",
    "disabled:pointer-events-none disabled:border-(--color-border-subtle) disabled:bg-(--color-bg-sheet) disabled:text-(--color-text-faint)",
    "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
  ].join(" "),
  {
    variants: {
      variant: {
        primary: [
          "border-transparent bg-(--color-accent-500) font-semibold text-(--color-accent-onfill)",
          "hover:bg-(--color-accent-400) active:bg-(--color-accent-600)",
          "disabled:border-transparent disabled:bg-(--color-accent-500) disabled:text-(--color-accent-onfill) disabled:opacity-40",
        ].join(" "),
        secondary: [
          "border-(--color-border-default) bg-(--color-bg-surface) text-(--color-text-primary)",
          "hover:border-(--color-border-strong) hover:bg-(--color-bg-elevated)",
          "active:bg-(--color-bg-active)",
        ].join(" "),
        ghost: [
          "border-transparent bg-transparent text-(--color-text-secondary)",
          "hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
          "active:bg-(--color-bg-active)",
          "disabled:border-transparent disabled:bg-transparent",
        ].join(" "),
        danger: [
          "border-(--color-danger-border) bg-(--color-danger-tint) text-(--color-danger-text)",
          "hover:border-(--color-danger) active:brightness-95",
        ].join(" "),
        "danger-solid": [
          "border-transparent bg-(--color-danger-solid) font-semibold text-white",
          "hover:brightness-110 active:brightness-90",
        ].join(" "),
        dashed: [
          "border-dashed border-(--color-border-strong) bg-transparent text-(--color-text-muted)",
          "hover:border-(--color-text-faint) hover:text-(--color-text-secondary)",
        ].join(" "),
      },
      size: {
        sm: "h-7 px-2.5",
        md: "h-8 px-3",
        lg: "h-9 px-4 text-[13px]",
        icon: "size-7 px-0",
        "icon-md": "size-8 px-0",
      },
    },
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
