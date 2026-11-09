import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Settings row (A-SettingsPages): label + help on the left, one control on
 * the right. Under A-Polish the card rings instead of bordering, rows
 * separate by spacing (no 1px dividers), and the title is a plain
 * sentence-case label (12px, muted, 500) with no tinted strip.
 */
export function SettingsCard({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-(--radius-card) py-1 shadow-(--shadow-card)",
        className,
      )}
    >
      {title ? (
        <div className="group-header px-3.5 pb-1 pt-2.5">
          {title}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function SettingsRow({
  label,
  help,
  htmlFor,
  children,
  id,
  className,
}: {
  label: ReactNode;
  help?: ReactNode;
  /** Point the visible label at the control when it is a native field. */
  htmlFor?: string;
  children?: ReactNode;
  /** Deep-link anchor (`?settingsRow=`). */
  id?: string;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "span";
  return (
    <div
      data-settings-row
      id={id}
      className={cn(
        "flex items-center gap-3 px-3.5 py-3 transition-colors duration-(--dur-3) ease-(--ease-out) data-[flash=true]:bg-(--color-accent-50)",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Label {...(htmlFor ? { htmlFor } : {})} className="text-[12px] font-medium text-(--color-text-primary)">
          {label}
        </Label>
        {help ? <span className="text-[12px] text-(--color-text-muted)">{help}</span> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-3">{children}</div> : null}
    </div>
  );
}
