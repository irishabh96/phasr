/**
 * Shared styling + helpers for command-palette-style modals (CommandPalette,
 * RepoFileSearchModal, and any future cmdk-based overlays). Both modals
 * consume these so the visual surface stays in sync — a tweak here flows
 * to every palette.
 */

export const GROUP_CLS =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-normal [&_[cmdk-group-heading]]:text-(--color-text-muted)";

export const ITEM_CLS = [
  "flex cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2.5",
  "scroll-my-2",
  "text-(--color-text-primary)",
  "transition-colors duration-100",
  "aria-selected:bg-(--color-bg-hover)",
].join(" ");

export const KBD_CLS =
  "inline-flex h-5 min-w-[20px] items-center justify-center rounded-[5px] bg-(--color-bg-hover) px-1 text-[10.5px] font-medium text-(--color-text-secondary)";

/**
 * Shell sizing/colors. The CommandPalette and RepoFileSearchModal both
 * spread these onto their Command.Dialog and input rows so widths and
 * paddings match exactly.
 */
export const PALETTE_DIALOG_CLS =
  "fixed inset-0 z-[200] flex items-start justify-center bg-(--color-bg-overlay) p-0 pt-[14vh] backdrop-blur-md";

export const PALETTE_SHELL_CLS =
  "overflow-hidden rounded-[var(--radius-modal)] bg-(--glass-modal) backdrop-blur-xl animate-[modal-in_200ms_var(--ease-glass)]";

export const PALETTE_INPUT_ROW_CLS =
  "flex items-center gap-3 px-5 pt-5 pb-2";

export const PALETTE_INPUT_CLS =
  "h-10 w-full border-0 bg-transparent text-[17px] placeholder:text-(--color-text-muted) shadow-none! outline-none focus:border-transparent! focus:shadow-none! focus:outline-none";

export const PALETTE_LIST_CLS =
  "max-h-[60vh] overflow-y-auto px-3 pb-2";

export const PALETTE_FOOTER_CLS =
  "flex items-center gap-4 border-t border-(--glass-border-hairline) px-4 py-2.5 text-[11.5px] text-(--color-text-muted)";
