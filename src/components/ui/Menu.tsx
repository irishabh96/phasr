import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Menu surface (A-System elevation 1): raised fill, strong hairline, small
 * shadow. Radix DropdownMenu underneath for focus + keyboard handling.
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
        "z-(--z-dropdown) min-w-44 overflow-hidden rounded-(--radius-card) border border-(--color-border-strong)",
        "bg-(--color-bg-dropdown) p-1 text-[12px] shadow-(--shadow-dropdown)",
        "data-[state=open]:animate-[modal-in_120ms_var(--ease-glass)]",
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
