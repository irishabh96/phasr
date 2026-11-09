/**
 * Central keymap. The single source of truth for every keyboard binding
 * that the app reacts to AND every binding that we render to the user
 * (tooltips, palette chips, the action list on the empty-repo screen).
 *
 * Handlers use `matchShortcut(e, SHORTCUTS.foo)` instead of comparing
 * `e.key` themselves. UI sites use `SHORTCUTS.foo.display` for the
 * `<kbd>` chips and `SHORTCUTS.foo.label` for tooltips. A future
 * "Keyboard" settings page (task #12) can write user overrides on top
 * of this same registry.
 *
 * Conventions:
 *  - `key` is lowercased KeyboardEvent.key (e.g. "t", "\\", "k").
 *  - `meta: true` means ⌘ on macOS / Ctrl on Windows + Linux. Always
 *    compare with `(e.metaKey || e.ctrlKey)`.
 *  - `metaOnly: true` narrows that to ⌘ alone on macOS, so the Ctrl chord
 *    still reaches the terminal (Ctrl+I is Tab, Ctrl+Shift+R is an app
 *    binding in many TUIs, Ctrl+Y is readline yank).
 *  - `shift` matters: `meta` alone won't match a meta+shift press, and
 *    vice-versa. Add an explicit entry for both if both should bind.
 *  - Keys whose glyph changes under Shift (=/+, -/_) use `aliases` +
 *    `ignoreShift` instead, because `e.key` for those is not portable.
 */

export interface Shortcut {
  /** KeyboardEvent.key, lowercased. */
  key: string;
  /**
   * Other `e.key` values produced by the SAME physical key. `=` reports as
   * "+" under Shift on macOS but as "=" in Chromium, and the numpad "+"
   * reports "+" with no Shift at all — matching one spelling silently
   * misses the others.
   */
  aliases?: readonly string[];
  /** ⌘ on mac / Ctrl on Windows + Linux. */
  meta?: boolean;
  /**
   * On macOS, ⌘ only: a Ctrl press (with or without ⌘) does not match.
   * Elsewhere `meta` keeps meaning Ctrl. For bindings whose Ctrl chord
   * means something inside a terminal.
   */
  metaOnly?: boolean;
  /** Requires Shift in addition to meta (or alone). */
  shift?: boolean;
  /** Bind with or without Shift (for `aliases` keys whose glyph shifts). */
  ignoreShift?: boolean;
  /** Chip segments for `<kbd>` rendering. Mac glyphs; we don't currently swap on platform. */
  display: string[];
  /** Human description used in tooltips, palettes, the settings table. */
  label: string;
}

export const SHORTCUTS = {
  // App
  openSettings: {
    key: ",",
    meta: true,
    metaOnly: true,
    display: ["⌘", ","],
    label: "Open settings",
  },
  togglePalette: {
    key: "k",
    meta: true,
    metaOnly: true,
    display: ["⌘", "K"],
    label: "Command palette",
  },
  toggleSidebarPin: {
    key: "b",
    meta: true,
    metaOnly: true,
    display: ["⌘", "B"],
    label: "Collapse task list",
  },
  toggleSidebarHide: {
    key: "b",
    meta: true,
    metaOnly: true,
    shift: true,
    display: ["⌘", "⇧", "B"],
    label: "Hide task list",
  },
  toggleRightPanel: {
    key: "i",
    meta: true,
    metaOnly: true,
    display: ["⌘", "I"],
    label: "Toggle inspector",
  },
  reviewChanges: {
    key: "r",
    meta: true,
    metaOnly: true,
    shift: true,
    display: ["⌘", "⇧", "R"],
    label: "Review changes",
  },
  // Approval card (agent paused on a permission prompt). ⌘ only: Ctrl+Y is
  // readline yank and Ctrl+⌫ deletes a word.
  approveAgent: {
    key: "y",
    meta: true,
    metaOnly: true,
    display: ["⌘", "Y"],
    label: "Allow once",
  },
  denyAgent: {
    key: "backspace",
    meta: true,
    metaOnly: true,
    display: ["⌘", "⌫"],
    label: "Deny",
  },
  stopAgent: {
    key: ".",
    meta: true,
    metaOnly: true,
    display: ["⌘", "."],
    label: "Stop agent",
  },

  // Terminal font size. "+" and "-" live on shifted keys, and the glyph the
  // browser reports is not portable: macOS gives "+" for ⌘⇧=, Chromium gives
  // "=" with shiftKey set, and the numpad gives "+" with no Shift. Match the
  // physical key (every spelling, either Shift state) rather than one glyph.
  increaseFontSize: {
    key: "=",
    aliases: ["+"],
    meta: true,
    ignoreShift: true,
    display: ["⌘", "+"],
    label: "Increase terminal font size",
  },
  decreaseFontSize: {
    key: "-",
    aliases: ["_"],
    meta: true,
    ignoreShift: true,
    display: ["⌘", "-"],
    label: "Decrease terminal font size",
  },
  resetFontSize: {
    key: "0",
    meta: true,
    display: ["⌘", "0"],
    label: "Reset terminal font size",
  },

  // Workspace / repo
  newWorkspace: {
    key: "n",
    meta: true,
    metaOnly: true,
    display: ["⌘", "N"],
    label: "New task",
  },
  newTerminal: {
    key: "t",
    meta: true,
    metaOnly: true,
    display: ["⌘", "T"],
    label: "New terminal",
  },
  closeActiveTab: {
    key: "w",
    meta: true,
    metaOnly: true,
    display: ["⌘", "W"],
    label: "Close tab",
  },
  searchFiles: {
    key: "p",
    meta: true,
    metaOnly: true,
    display: ["⌘", "P"],
    label: "Search files",
  },
  openInEditor: {
    key: "o",
    meta: true,
    metaOnly: true,
    display: ["⌘", "O"],
    label: "Open in editor",
  },

  // Notes
  openNotes: {
    key: "n",
    meta: true,
    metaOnly: true,
    shift: true,
    display: ["⌘", "⇧", "N"],
    label: "Repository notes",
  },

  // Diff viewer
  toggleDiffMode: {
    key: "\\",
    meta: true,
    metaOnly: true,
    display: ["⌘", "\\"],
    label: "Toggle split / inline diff",
  },

  // Forms
  submitForm: {
    key: "enter",
    meta: true,
    metaOnly: true,
    display: ["⌘", "↵"],
    label: "Submit",
  },
  // New task only (scoped to its form, like commitAndPush to Changes).
  saveDraft: {
    key: "enter",
    meta: true,
    metaOnly: true,
    shift: true,
    display: ["⌘", "⇧", "↵"],
    label: "Save as draft",
  },

  // Git
  commitAndPush: {
    key: "enter",
    meta: true,
    metaOnly: true,
    shift: true,
    display: ["⌘", "⇧", "↵"],
    label: "Commit & push",
  },

  // ⌘1..⌘9 — dynamic bindings to pinned run commands (in sort_order).
  // Not in this registry because the target ID varies per repository;
  // the dispatcher lives in the workspace route at
  // `routes/_app/repositories/$repositoryId/workspaces/$workspaceId.tsx`.
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** Phasr ships for macOS; the check keeps `metaOnly` honest elsewhere. */
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      navigator.platform ??
      navigator.userAgent,
  );

/**
 * Returns true if `e` matches `s` exactly. Meta and Shift must both
 * agree — an entry without `shift` will NOT match a meta+shift press,
 * preventing accidental double-bindings. `ignoreShift` opts an entry out
 * of that check, and `aliases` accepts the other `e.key` spellings of the
 * same physical key.
 *
 * Does not stopPropagation or preventDefault — the caller decides what
 * to do once the match is confirmed.
 */
export function matchShortcut(e: KeyboardEvent, s: Shortcut, mac: boolean = IS_MAC): boolean {
  const wantsMeta = !!s.meta;
  const hasMeta = s.metaOnly && mac ? e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey;
  if (wantsMeta !== hasMeta) return false;
  if (!s.ignoreShift && !!s.shift !== e.shiftKey) return false;
  const key = e.key.toLowerCase();
  return key === s.key || !!s.aliases?.includes(key);
}
