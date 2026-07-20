import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The `.sec` card shell from mockup Page 04 — a bordered surface with an
 * uppercase section key, a right-aligned meta/action slot, and a body. Pure &
 * prop-driven so both `SectionEditor` (IPC-backed) and `/design-test` (fixtures)
 * render the exact same chrome. `editing` tints the card (mockup `.editing`).
 */
export function SectionCard({
  title,
  editing = false,
  meta,
  action,
  children,
  testId,
}: {
  title: string;
  editing?: boolean;
  /** Muted "last edited by you · Ns ago" line, left of the action. */
  meta?: ReactNode;
  /** The Edit affordance (read) or a "Markdown" hint (edit). */
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      data-editing={editing}
      className={cn(
        "overflow-hidden rounded-(--radius-panel) border border-(--color-border-subtle) bg-(--color-bg-surface)",
        editing &&
          "bg-[color-mix(in_oklab,var(--color-accent-500)_5%,var(--color-bg-surface))]",
      )}
    >
      <div className="flex items-center justify-between gap-2.5 border-b border-(--color-border-subtle) px-3.5 py-2.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.11em] text-(--color-text-muted)">
          {title}
        </span>
        <div className="flex items-center gap-2.5">
          {meta ? (
            <span className="text-[11px] text-(--color-text-muted)">{meta}</span>
          ) : null}
          {action}
        </div>
      </div>
      <div className="px-3.5 py-3">{children}</div>
    </section>
  );
}
