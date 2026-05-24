import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const button = cva(
  // base
  [
    "inline-flex items-center justify-center gap-1.5 select-none whitespace-nowrap",
    "font-medium",
    "transition-all duration-[180ms] ease-[cubic-bezier(0.16,1,0.3,1)]",
    "disabled:opacity-40 disabled:pointer-events-none",
    "focus-visible:outline-none",
  ].join(" "),
  {
    variants: {
      variant: {
        // Filled accent. The "primary call to action" — flat coral that
        // lifts on hover and depresses on active. The border is the
        // same strong-hairline used by the outline variant so the button
        // has a clear edge even when the accent fill renders dim on a
        // particular theme — the affordance is unambiguous.
        primary: [
          "bg-[var(--color-accent-500)] text-[var(--color-text-inverse)]",
          "border border-[var(--glass-border-strong)]",
          "hover:bg-[var(--color-accent-400)] hover:-translate-y-px",
          "active:bg-[var(--color-accent-600)] active:translate-y-0 active:scale-[0.98]",
          "focus-visible:shadow-[0_0_0_2px_var(--color-accent-300)]",
        ].join(" "),
        // Transparent. Hovers to the elevated surface tone.
        ghost: [
          "bg-transparent text-[var(--color-text-primary)]",
          "border border-transparent",
          "hover:bg-[var(--color-bg-hover)]",
          "hover:border-[var(--glass-border-hairline)]",
          "active:bg-[var(--color-bg-active)]",
          "focus-visible:border-[var(--color-accent-500)]",
        ].join(" "),
        // Outlined glass — soft pill, used in dialogs and toolbars.
        outline: [
          "bg-[var(--glass-panel)] backdrop-blur-md text-[var(--color-text-primary)]",
          "border border-[var(--glass-border-hairline)]",
          "hover:border-[var(--glass-border-strong)]",
          "hover:bg-[var(--color-bg-hover)]",
          "focus-visible:border-[var(--color-accent-500)]",
        ].join(" "),
        // Destructive. Flat red.
        danger: [
          "bg-[var(--color-danger)] text-white",
          "border border-[color-mix(in_oklab,var(--color-text-primary)_15%,transparent)]",
          "hover:brightness-110",
          "active:brightness-90",
        ].join(" "),
      },
      size: {
        sm: "h-8 px-3 text-[13px] rounded-[8px]",
        md: "h-[38px] px-4 text-[14px] rounded-[10px]",
        lg: "h-11 px-5 text-[14px] rounded-[12px]",
        icon: "h-8 w-8 rounded-[10px]",
      },
    },
    defaultVariants: {
      variant: "ghost",
      size: "md",
    },
  },
);

type GlassButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button>;

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(button({ variant, size }), className)}
        {...props}
      />
    );
  },
);
GlassButton.displayName = "GlassButton";
