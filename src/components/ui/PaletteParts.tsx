import { Command } from "cmdk";
import { ChevronsUpDown, CornerDownLeft } from "lucide-react";
import { type ReactNode } from "react";
import {
  GROUP_CLS,
  KBD_CLS,
  PALETTE_FOOTER_CLS,
} from "@/components/ui/palette";

/**
 * cmdk's internal `scrollIntoView` calls `scrollIntoView({ block: "nearest" })`
 * on the group HEADING — but only when the selected item is the very first
 * child of its group's items container. That heading-scroll drags the new
 * item up toward the top of the viewport, producing the "jump back to top"
 * flicker when arrow-keying across group boundaries.
 *
 * `<PaletteGroup>` wraps `<Command.Group>` and prepends a hidden dummy
 * element as the first child of the items container. Because cmdk's check
 * (`e.parentElement?.firstChild === e`) sees the dummy as the firstChild
 * instead of the actual first item, the heading-scroll branch is always
 * skipped. cmdk falls through to plain `item.scrollIntoView({ block: "nearest" })`,
 * which keeps the highlight at the edge as the list scrolls.
 */
export function PaletteGroup({
  heading,
  children,
}: {
  heading: string;
  children: ReactNode;
}) {
  return (
    <Command.Group heading={heading} className={GROUP_CLS}>
      <span hidden aria-hidden="true" />
      {children}
    </Command.Group>
  );
}

export function PaletteShortcut({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((k) => (
        <kbd key={k} className={KBD_CLS}>
          {k}
        </kbd>
      ))}
    </span>
  );
}

export function PaletteFooter() {
  return (
    <div className={PALETTE_FOOTER_CLS}>
      <FooterHint icon={<ChevronsUpDown size={11} />} label="Navigate" />
      <FooterHint icon={<CornerDownLeft size={11} />} label="Select" />
      <FooterHint icon={<span className="text-[10px]">esc</span>} label="Close" boxed />
    </div>
  );
}

function FooterHint({
  icon,
  label,
  boxed = false,
}: {
  icon: ReactNode;
  label: string;
  boxed?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={
          boxed
            ? "inline-flex h-5 items-center rounded-[5px] bg-(--color-bg-hover) px-1.5 text-(--color-text-secondary)"
            : "inline-flex h-5 w-5 items-center justify-center rounded-[5px] bg-(--color-bg-hover) text-(--color-text-secondary)"
        }
      >
        {icon}
      </span>
      {label}
    </span>
  );
}
