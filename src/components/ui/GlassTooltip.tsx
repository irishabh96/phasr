import * as Tooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type GlassTooltipProps = {
  children: ReactNode;
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  /** Hide the tooltip entirely (e.g. when a parent collapsed state is expanded). */
  disabled?: boolean;
  delayDuration?: number;
};

export function GlassTooltip({
  children,
  content,
  side = "right",
  align = "center",
  disabled = false,
  delayDuration = 300,
}: GlassTooltipProps) {
  if (disabled) return <>{children}</>;
  return (
    <Tooltip.Provider delayDuration={delayDuration}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side={side}
            align={align}
            sideOffset={6}
            className={cn(
              "z-50 px-2 py-1 text-[12px] font-medium",
              "bg-(--color-bg-tooltip) text-(--color-text-primary)",
              "border border-(--color-border-default) rounded-[8px]",
              "data-[state=delayed-open]:animate-[modal-in_180ms_cubic-bezier(0.16,1,0.3,1)]",
            )}
          >
            {content}
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
