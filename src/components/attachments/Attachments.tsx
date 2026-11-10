import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { FileText, Image as ImageIcon, Paperclip, X } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import type { Attachment } from "@/lib/attachments";
import { cn } from "@/lib/utils";

/**
 * A-NewTask "Attach": the property-chip metrics (26px, radius 6, 0 8px,
 * 6px gap, 12px text and icon) with a dashed border and muted text — it adds
 * a value rather than editing one.
 */
export const AttachChip = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  ({ className, type = "button", ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-label="Attach files"
      className={cn(
        "inline-flex h-[26px] shrink-0 items-center gap-[6px] whitespace-nowrap rounded-(--radius-control) px-[8px]",
        "border border-dashed border-(--color-border-default) bg-transparent text-[12px] leading-none text-(--color-text-muted)",
        "transition-[background-color,color,scale] duration-(--dur-1) ease-(--ease-out) motion-safe:active:scale-[.98]",
        "hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
        "focus-visible:outline-none focus-visible:shadow-(--ring-focus)",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <Paperclip aria-hidden className="size-[12px] shrink-0" strokeWidth={2} />
      Attach
    </button>
  ),
);
AttachChip.displayName = "AttachChip";

/** The composer's 26px ghost paperclip. */
export function AttachIconButton({ className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label="Attach files"
      title="Attach files"
      className={cn(
        "grid size-[26px] shrink-0 place-items-center rounded-(--radius-control) text-(--color-text-muted)",
        "transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary)",
        "focus-visible:outline-none focus-visible:shadow-(--ring-focus) disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      <Paperclip aria-hidden className="size-[14px]" strokeWidth={2} />
    </button>
  );
}

/**
 * Removable attachment chips. Each is the property-chip look split into
 * two real buttons: the file (shows it in Finder) and its ×.
 */
export function AttachmentChips({
  items,
  onRemove,
  className,
}: {
  items: readonly Attachment[];
  onRemove: (path: string) => void;
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="Attachments" className={cn("m-0 flex list-none flex-wrap items-center gap-[6px] p-0", className)}>
      {items.map((a) => (
        <li
          key={a.path}
          className="inline-flex h-[26px] min-w-0 max-w-full items-center rounded-(--radius-control) border border-(--color-border-default) text-[12px] leading-none text-(--color-text-primary)"
        >
          <button
            type="button"
            title={a.path}
            onClick={() => void revealItemInDir(a.path).catch(() => {})}
            className="inline-flex h-full min-w-0 items-center gap-[6px] rounded-l-(--radius-control) pl-[8px] pr-[4px] transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-elevated) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            {a.kind === "image" && a.previewUrl ? (
              <img
                src={a.previewUrl}
                alt=""
                aria-hidden
                className="size-[20px] shrink-0 rounded-[3px] object-cover"
              />
            ) : a.kind === "image" ? (
              <ImageIcon aria-hidden className="size-[12px] shrink-0 text-(--color-text-muted)" strokeWidth={2} />
            ) : (
              <FileText aria-hidden className="size-[12px] shrink-0 text-(--color-text-muted)" strokeWidth={2} />
            )}
            <span className="min-w-0 max-w-[24ch] truncate">{a.name}</span>
          </button>
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            onClick={() => onRemove(a.path)}
            className="grid h-full w-[22px] shrink-0 place-items-center rounded-r-(--radius-control) text-(--color-text-muted) transition-colors duration-(--dur-1) ease-(--ease-out) hover:bg-(--color-bg-elevated) hover:text-(--color-text-primary) focus-visible:outline-none focus-visible:shadow-(--ring-focus)"
          >
            <X aria-hidden className="size-[11px]" strokeWidth={2.25} />
          </button>
        </li>
      ))}
    </ul>
  );
}
