import { forwardRef } from "react";
import { Button, type ButtonProps } from "@/components/ui/Button";

/**
 * Compatibility shim: the pre-redesign button API, now rendering the A-System
 * <Button>. `outline` maps to `secondary`. New code should import Button.
 */
type LegacyVariant = "primary" | "ghost" | "outline" | "danger" | "danger-solid";
type LegacySize = "sm" | "md" | "lg" | "icon";

type GlassButtonProps = Omit<ButtonProps, "variant" | "size"> & {
  variant?: LegacyVariant | null;
  size?: LegacySize | null;
};

export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(
  ({ variant, size, ...props }, ref) => (
    <Button
      ref={ref}
      variant={
        variant === "outline" ? "secondary" : variant === "danger-solid" ? "danger-solid" : (variant ?? "ghost")
      }
      size={size === "icon" ? "icon" : size === "lg" ? "lg" : size === "sm" ? "sm" : "md"}
      {...props}
    />
  ),
);
GlassButton.displayName = "GlassButton";
