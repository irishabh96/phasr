import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type GlassPanelProps = HTMLAttributes<HTMLDivElement> & {
  /** Material layer. `panel` (default) for floating cards, `rail` for header/sidebar, `modal` for overlays. */
  layer?: "rail" | "panel" | "modal";
};

export const GlassPanel = forwardRef<HTMLDivElement, GlassPanelProps>(
  ({ className, layer = "panel", ...props }, ref) => {
    const layerClass =
      layer === "rail" ? "glass-rail" : layer === "modal" ? "glass-modal" : "glass-panel";
    return <div ref={ref} className={cn(layerClass, className)} {...props} />;
  },
);
GlassPanel.displayName = "GlassPanel";
