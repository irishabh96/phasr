import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Menu surface (A-Polish): raised fill, no border; the floating ring +
 * shadow separates it. Popover motion (opacity + 4px slide from the trigger,
 * 160ms in / 80ms out). Radix DropdownMenu underneath for focus + keyboard.
 */
export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export const MenuContent = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DropdownMenu.Content> & { width?: number }
>(({ className, width, style, sideOffset = 6, align = "start", ...rest }, ref) => (
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      ref={ref}
      sideOffset={sideOffset}
      align={align}
      style={{ ...(width ? { width } : {}), ...style }}
      className={cn(
        "surface-floating z-(--z-dropdown) min-w-44 overflow-hidden p-1 text-[12px]",
        "data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out",
        className,
      )}
      {...rest}
    />
  </DropdownMenu.Portal>
));
MenuContent.displayName = "MenuContent";

export const MenuItem = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<typeof DropdownMenu.Item> & {
    icon?: ReactNode;
    trailing?: ReactNode;
    tone?: "default" | "danger";
  }
>(({ className, icon, trailing, tone = "default", children, ...rest }, ref) => (
  <DropdownMenu.Item
    ref={ref}
    className={cn(
      "flex h-8 cursor-pointer select-none items-center gap-2 rounded-(--radius-control) px-2 outline-none",
      "data-[highlighted]:bg-(--color-bg-hover) data-[disabled]:pointer-events-none data-[disabled]:opacity-40",
      tone === "danger" ? "text-(--color-danger-text)" : "text-(--color-text-primary)",
      className,
    )}
    {...rest}
  >
    {icon ? <span className="grid size-4 shrink-0 place-items-center text-(--color-text-muted)">{icon}</span> : null}
    <span className="min-w-0 flex-1 truncate">{children}</span>
    {trailing}
  </DropdownMenu.Item>
));
MenuItem.displayName = "MenuItem";

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-(--color-border-subtle)" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="group-header px-2 pb-1 pt-1.5">{children}</DropdownMenu.Label>;
}
