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
        // Filled accent. The "primary call to action" — soft glow on hover,
        // lifts on hover and depresses on active per spec.
        primary: [
          "bg-[var(--color-accent-500)] text-[var(--color-text-inverse)]",
          "border border-[color-mix(in_oklab,white_18%,transparent)]",
          "shadow-[var(--shadow-button-primary)]",
          "hover:bg-[var(--color-accent-400)] hover:shadow-[var(--shadow-button-primary-hover)] hover:-translate-y-px",
          "active:bg-[var(--color-accent-600)] active:translate-y-0 active:scale-[0.98]",
          "focus-visible:shadow-[var(--shadow-button-primary-hover),0_0_0_2px_var(--color-accent-300)]",
        ].join(" "),
        // Transparent. Hovers to a subtle white-tinted glass.
        ghost: [
          "bg-transparent text-[var(--color-text-primary)]",
          "border border-transparent",
          "hover:bg-[color-mix(in_oklab,white_6%,transparent)]",
          "hover:border-[var(--glass-border-hairline)]",
          "active:bg-[color-mix(in_oklab,white_10%,transparent)]",
          "focus-visible:border-[var(--color-accent-500)]",
        ].join(" "),
        // Outlined glass — soft pill, used in dialogs and toolbars.
        outline: [
          "bg-[var(--glass-panel)] backdrop-blur-md text-[var(--color-text-primary)]",
          "border border-[var(--glass-border-hairline)]",
          "shadow-[inset_0_1px_0_0_var(--glass-highlight-top)]",
          "hover:border-[var(--glass-border-strong)]",
          "hover:bg-[color-mix(in_oklab,white_8%,transparent)]",
          "focus-visible:border-[var(--color-accent-500)]",
        ].join(" "),
        // Destructive. Red-tinted with red glow on hover.
        danger: [
          "bg-[var(--color-danger)] text-white",
          "border border-[color-mix(in_oklab,white_15%,transparent)]",
          "shadow-[inset_0_1px_0_0_color-mix(in_oklab,white_18%,transparent)]",
          "hover:shadow-[var(--shadow-glow-danger)]",
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
