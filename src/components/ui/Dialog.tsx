import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, type RefObject } from "react";
import { GlassButton } from "@/components/ui/GlassButton";
import { humanizeError } from "@/lib/humanizeError";
import { cn } from "@/lib/utils";

const SIZE_MAP: Record<string, string> = {
  sm: "380px",
  md: "460px",
  lg: "560px",
};

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible title. Rendered in the h-11 header, wired to aria-labelledby. */
  title: React.ReactNode;
  /**
   * REQUIRED. Rendered in a Dialog.Description slot (wired to aria-describedby).
   * Pass a node for rich copy; pass a `<span className="sr-only">` when the body
   * is self-describing but a11y still needs a description.
   */
  description: React.ReactNode;
  /** Body content (form, message, strategy rows, …). Optional. */
  children?: React.ReactNode;
  /** Footer actions, right-aligned (Cancel + primary/danger). Optional. */
  footer?: React.ReactNode;
  /** Content max-width. Default "md" (≈460px); accepts a px/clamp string. */
  size?: "sm" | "md" | "lg" | string;
  /**
   * Element to focus on open, overriding the default (primary footer action).
   * Radix onOpenAutoFocus target.
   */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * The one Radix dialog shell. Fixes the drift across the app's hand-rolled and
 * ad-hoc Radix dialogs: a single z-tier (`--z-overlay` / `--z-modal`), one top
 * offset, an h-11 header, a real 32px Dialog.Close, a required Description, a
 * fade-only overlay, and initial focus on the primary action (not the close X).
 *
 * ConfirmDialog / ErrorDialog below COMPOSE this shell — they never re-implement
 * the surface.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  initialFocusRef,
}: DialogProps) {
  const maxWidth = SIZE_MAP[size] ?? size;

  // Initial focus: explicit ref → primary footer action → first field.
  // Never the close X (Radix's default would grab it, since it's first in DOM).
  const handleOpenAutoFocus = (event: Event) => {
    const content = event.currentTarget as HTMLElement | null;
    if (!content) return;

    const explicit = initialFocusRef?.current;
    if (explicit) {
      event.preventDefault();
      explicit.focus();
      return;
    }

    const footerEl = content.querySelector<HTMLElement>("[data-dialog-footer]");
    const primary = footerEl
      ? [
          ...footerEl.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        ].pop()
      : undefined;
    if (primary) {
      event.preventDefault();
      primary.focus();
      return;
    }

    const field = content.querySelector<HTMLElement>(
      "input:not([type=hidden]), textarea, select",
    );
    if (field) {
      event.preventDefault();
      field.focus();
    }
    // else: fall through to Radix's default focus handling.
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-(--z-overlay) bg-(--color-bg-overlay) backdrop-blur-md data-[state=open]:animate-[overlay-in_180ms_var(--ease-glass)] data-[state=closed]:animate-[overlay-out_140ms_var(--ease-glass)]" />
        <RadixDialog.Content
          onOpenAutoFocus={handleOpenAutoFocus}
          style={{ width: `min(${maxWidth}, calc(100vw - 32px))` }}
          className="glass-modal fixed left-1/2 top-[12vh] z-(--z-modal) max-h-[80vh] -translate-x-1/2 overflow-hidden outline-none data-[state=open]:animate-[modal-in_180ms_var(--ease-glass)] data-[state=closed]:animate-[modal-out_140ms_var(--ease-glass)]"
        >
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-(--glass-border-hairline) px-4">
            <RadixDialog.Title asChild>
              <h2 className="text-[13.5px] font-semibold leading-none">
                {title}
              </h2>
            </RadixDialog.Title>
            <RadixDialog.Close asChild>
              <button
                type="button"
                aria-label="Close dialog"
                data-dialog-close
                className="ml-auto grid size-8 shrink-0 place-items-center rounded-(--radius-control) text-(--color-text-muted) transition-colors duration-100 hover:bg-(--color-bg-hover) hover:text-(--color-text-primary) focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </RadixDialog.Close>
          </header>

          <div className="max-h-[calc(80vh-2.75rem)] overflow-y-auto px-5 py-4">
            <RadixDialog.Description asChild>
              <div className="text-[12.5px] leading-relaxed text-(--color-text-secondary) [&:empty]:hidden">
                {description}
              </div>
            </RadixDialog.Description>
            {children != null ? (
              <div className="[&:not(:first-child)]:mt-3">{children}</div>
            ) : null}
          </div>

          {footer != null ? (
            <footer
              data-dialog-footer
              className="flex shrink-0 items-center justify-end gap-2 border-t border-(--glass-border-hairline) px-4 py-3"
            >
              {footer}
            </footer>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  /** The confirm body copy — also the a11y description. */
  description: React.ReactNode;
  onConfirm: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger styling + red confirm button for destructive actions. */
  destructive?: boolean;
  /** Disables both buttons and swaps the confirm label to `pendingLabel`. */
  pending?: boolean;
  pendingLabel?: string;
  size?: DialogProps["size"];
}

/** Preset shell: Cancel + a primary/danger confirm. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  pendingLabel,
  size,
}: ConfirmDialogProps) {
  // Destructive dialogs focus Cancel, not the danger action — otherwise
  // an Enter-through on open performs the irreversible thing.
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={<span className="whitespace-pre-line">{description}</span>}
      {...(size ? { size } : {})}
      {...(destructive ? { initialFocusRef: cancelRef } : {})}
      footer={
        <>
          <GlassButton
            ref={cancelRef}
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </GlassButton>
          <GlassButton
            variant={destructive ? "danger" : "primary"}
            size="sm"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending && pendingLabel ? pendingLabel : confirmLabel}
          </GlassButton>
        </>
      }
    />
  );
}

export interface ErrorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: React.ReactNode;
  /** Raw error — humanized for the body via humanizeError(). */
  error?: unknown;
  /** Explicit body copy; overrides the humanized error when provided. */
  description?: React.ReactNode;
  closeLabel?: string;
}

/** Preset shell: humanized error body + a single primary Close. */
export function ErrorDialog({
  open,
  onOpenChange,
  title = "Something went wrong",
  error,
  description,
  closeLabel = "Close",
}: ErrorDialogProps) {
  const body = description ?? humanizeError(error);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={
        <span className={cn(!description && "text-(--color-danger)")}>
          {body}
        </span>
      }
      footer={
        <GlassButton
          variant="primary"
          size="sm"
          onClick={() => onOpenChange(false)}
        >
          {closeLabel}
        </GlassButton>
      }
    />
  );
}
