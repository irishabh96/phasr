import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The section shell for the Brief (mockup Page 04). Two presentations, one API:
 *
 *  - `variant="card"` (default) — a calm bordered surface for object galleries
 *    (Assets / Figma): an uppercase section eyebrow, a right-aligned meta/action
 *    slot, and a body. No hard header divider — the label sits *above* the
 *    content on air, so it reads like a titled block, not a form field.
 *  - `variant="bare"` — a borderless *document* section for the reading prose
 *    (Description / PRD / TRD). At rest it's just an eyebrow + content with
 *    generous rhythm; while `editing` it lifts into a tinted framed card so the
 *    section you're touching is unmistakable (mockup `.editing`).
 *
 * Pure & prop-driven so both `SectionEditor` (IPC-backed) and `/design-test`
 * (fixtures) render the exact same chrome.
 */
export function SectionCard({
  title,
  editing = false,
  meta,
  action,
  children,
  testId,
  variant = "card",
}: {
  title: string;
  editing?: boolean;
  /** Muted "last edited by you · Ns ago" line, left of the action. */
  meta?: ReactNode;
  /** The Edit affordance (read) or a "Markdown" hint (edit). */
  action?: ReactNode;
  children: ReactNode;
  testId?: string;
  variant?: "card" | "bare";
}) {
  // A bare section stays frameless at rest but adopts the framed+tinted shell
  // the moment it's edited, so the active section visibly lifts off the page.
  const framed = variant === "card" || editing;
  return (
    <section
      data-testid={testId}
      data-editing={editing}
      className={cn(
        "rounded-(--radius-panel) transition-colors duration-(--duration-glass) ease-(--ease-glass)",
        framed && "overflow-hidden border bg-(--color-bg-surface)",
        framed && !editing && "border-(--color-border-subtle)",
        editing &&
          "border-[color-mix(in_oklab,var(--color-accent-500)_26%,var(--color-border-subtle))] bg-[color-mix(in_oklab,var(--color-accent-500)_5%,var(--color-bg-surface))]",
      )}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2.5",
          framed ? "px-4 pt-3 pb-1" : "pb-2",
        )}
      >
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-(--color-text-muted)">
          {title}
        </span>
        <div className="flex items-center gap-2.5">
          {meta ? (
            <span className="text-[11px] text-(--color-text-muted)">{meta}</span>
          ) : null}
          {action}
        </div>
      </div>
      <div className={framed ? "px-4 pb-3.5 pt-1" : ""}>{children}</div>
    </section>
  );
}
