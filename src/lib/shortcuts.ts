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
 *  - `shift` matters: `meta` alone won't match a meta+shift press, and
 *    vice-versa. Add an explicit entry for both if both should bind.
 */

export interface Shortcut {
  /** KeyboardEvent.key, lowercased. */
  key: string;
  /** ⌘ on mac / Ctrl on Windows + Linux. */
  meta?: boolean;
  /** Requires Shift in addition to meta (or alone). */
  shift?: boolean;
  /** Chip segments for `<kbd>` rendering. Mac glyphs; we don't currently swap on platform. */
  display: string[];
  /** Human description used in tooltips, palettes, the settings table. */
  label: string;
}

export const SHORTCUTS = {
  // App
  togglePalette: {
    key: "k",
    meta: true,
    display: ["⌘", "K"],
    label: "Command palette",
  },
  toggleSidebarPin: {
    key: "b",
    meta: true,
    display: ["⌘", "B"],
    label: "Pin sidebar",
  },
  toggleSidebarHide: {
    key: "b",
    meta: true,
    shift: true,
    display: ["⌘", "⇧", "B"],
    label: "Hide sidebar",
  },
  toggleRightPanel: {
    key: "j",
    meta: true,
    display: ["⌘", "J"],
    label: "Toggle right panel",
  },

  // Workspace / repo
  newWorkspace: {
    key: "n",
    meta: true,
    display: ["⌘", "N"],
    label: "New task",
  },
  newTerminal: {
    key: "t",
    meta: true,
    display: ["⌘", "T"],
    label: "New terminal",
  },
  closeActiveTab: {
    key: "w",
    meta: true,
    display: ["⌘", "W"],
    label: "Close tab",
  },
  searchFiles: {
    key: "p",
    meta: true,
    display: ["⌘", "P"],
    label: "Search files",
  },
  openInEditor: {
    key: "o",
    meta: true,
    display: ["⌘", "O"],
    label: "Open in editor",
  },

  // Diff viewer
  toggleDiffMode: {
    key: "\\",
    meta: true,
    display: ["⌘", "\\"],
    label: "Toggle split / inline diff",
  },
} as const satisfies Record<string, Shortcut>;

export type ShortcutId = keyof typeof SHORTCUTS;

/**
 * Returns true if `e` matches `s` exactly. Meta and Shift must both
 * agree — an entry without `shift` will NOT match a meta+shift press,
 * preventing accidental double-bindings.
 *
 * Does not stopPropagation or preventDefault — the caller decides what
 * to do once the match is confirmed.
 */
export function matchShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const wantsMeta = !!s.meta;
  const wantsShift = !!s.shift;
  const hasMeta = e.metaKey || e.ctrlKey;
  if (wantsMeta !== hasMeta) return false;
  if (wantsShift !== e.shiftKey) return false;
  return e.key.toLowerCase() === s.key;
}
