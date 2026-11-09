import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Settings row (A-SettingsPages): label + help on the left, one control on
 * the right, 1px dividers between rows inside a bordered card.
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
        "overflow-hidden rounded-(--radius-card) border border-(--color-border-subtle)",
        "[&>[data-settings-row]+[data-settings-row]]:border-t [&>[data-settings-row]+[data-settings-row]]:border-(--color-border-subtle)",
        className,
      )}
    >
      {title ? (
        <div className="group-header border-b border-(--color-border-subtle) bg-(--color-bg-sidebar) px-3.5 py-2.5">
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
        "flex items-center gap-3 px-3.5 py-3 transition-colors duration-700 data-[flash=true]:bg-(--color-accent-50)",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Label {...(htmlFor ? { htmlFor } : {})} className="text-[12px] font-medium text-(--color-text-primary)">
          {label}
        </Label>
        {help ? <span className="text-[11px] text-(--color-text-muted)">{help}</span> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-3">{children}</div> : null}
    </div>
  );
}
