/**
 * iTerm-parity terminal keymap.
 *
 * xterm.js ignores meta-modified keys entirely — nothing reaches the PTY
 * for ⌘⌫, ⌘←, ⌘→ — and it emits a plain `\r` for ⇧↵, which agent CLIs
 * (Claude Code) can't distinguish from ↵. This table is a 1:1 translation
 * of the user's iTerm key mappings (`hello.itermkeymap`, the
 * natural-text-editing preset) plus ⇧↵ → `ESC CR`, the sequence
 * `claude /terminal-setup` installs for "insert newline".
 *
 * Installed once in `createXtermTerminal` via `attachCustomKeyEventHandler`,
 * so every terminal surface (agent, session tabs, run commands) gets the
 * same chords. Sequences are fed through `term.input()`, which emits
 * `onData` — the existing PTY send paths are reused untouched.
 *
 * Combos NOT in this table return `null` and keep their default handling:
 * app chrome shortcuts (⌘K/⌘W/⌘T… in `_app.tsx`) run in window capture
 * phase before xterm sees the event, and ⌘C/⌘V stay native via the Edit
 * menu. Only ever add MODIFIED keys here — plain keys belong to xterm.
 */

/** Modifier-canonical combo key: "Meta+Alt+Ctrl+Shift+<KeyboardEvent.key>". */
function comboOf(e: KeyboardEvent): string {
  let combo = "";
  if (e.metaKey) combo += "Meta+";
  if (e.altKey) combo += "Alt+";
  if (e.ctrlKey) combo += "Ctrl+";
  if (e.shiftKey) combo += "Shift+";
  return combo + e.key;
}

const ESC = "\x1b";

/**
 * combo → byte sequence for the PTY. Sources, per row group, are the
 * decoded `hello.itermkeymap` entries (NSEvent flags: shift 0x20000,
 * ctrl 0x40000, opt 0x80000, cmd 0x100000).
 */
const KEYMAP: Record<string, string> = {
  // ⇧↵ — not in the itermkeymap; Claude Code's insert-newline binding.
  "Shift+Enter": `${ESC}\r`,

  // ⌘ line editing (0xf702/0xf703-0x300000, 0x7f-0x100000)
  "Meta+ArrowLeft": "\x01", // ^A — line start
  "Meta+ArrowRight": "\x05", // ^E — line end
  "Meta+Backspace": "\x15", // ^U — kill line backwards

  // ⌥ word editing (0xf702/0xf703-0x280000, 0x7f-0x80000, 0xf728-0x80000)
  "Alt+ArrowLeft": `${ESC}b`,
  "Alt+ArrowRight": `${ESC}f`,
  "Alt+Backspace": `${ESC}\x7f`,
  "Alt+Delete": `${ESC}d`, // forward-delete word

  // ⌥↑/↓ (0xf700/0xf701-0x280000)
  "Alt+ArrowUp": `${ESC}${ESC}[A`,
  "Alt+ArrowDown": `${ESC}${ESC}[B`,

  // Forward delete (0xf728-0x0)
  Delete: "\x04", // ^D — delete char forward

  // Modified arrows as CSI 1;N (shift=2, ctrl=5, ctrl+shift=6)
  "Shift+ArrowUp": `${ESC}[1;2A`,
  "Shift+ArrowDown": `${ESC}[1;2B`,
  "Shift+ArrowRight": `${ESC}[1;2C`,
  "Shift+ArrowLeft": `${ESC}[1;2D`,
  "Ctrl+ArrowUp": `${ESC}[1;5A`,
  "Ctrl+ArrowDown": `${ESC}[1;5B`,
  "Ctrl+ArrowRight": `${ESC}[1;5C`,
  "Ctrl+ArrowLeft": `${ESC}[1;5D`,
  "Ctrl+Shift+ArrowUp": `${ESC}[1;6A`,
  "Ctrl+Shift+ArrowDown": `${ESC}[1;6B`,
  "Ctrl+Shift+ArrowRight": `${ESC}[1;6C`,
  "Ctrl+Shift+ArrowLeft": `${ESC}[1;6D`,

  // Home / End variants (0xf729 / 0xf72b with 0x20000 / 0x40000)
  "Shift+Home": `${ESC}[1;2H`,
  "Ctrl+Home": `${ESC}[1;5H`,
  "Shift+End": `${ESC}[1;2F`,
  "Ctrl+End": `${ESC}[1;5F`,

  // ^digit control codes (0x32..0x38, 0x2d, 0x2f with 0x40000)
  "Ctrl+2": "\x00",
  "Ctrl+3": "\x1b",
  "Ctrl+4": "\x1c",
  "Ctrl+5": "\x1d",
  "Ctrl+6": "\x1e",
  "Ctrl+7": "\x1f",
  "Ctrl+8": "\x7f",
  "Ctrl+-": "\x1f",
  "Ctrl+/": "\x1f",

  // Shifted function keys (0xf704..0xf70f with 0x20000)
  "Shift+F1": `${ESC}[1;2P`,
  "Shift+F2": `${ESC}[1;2Q`,
  "Shift+F3": `${ESC}[1;2R`,
  "Shift+F4": `${ESC}[1;2S`,
  "Shift+F5": `${ESC}[15;2~`,
  "Shift+F6": `${ESC}[17;2~`,
  "Shift+F7": `${ESC}[18;2~`,
  "Shift+F8": `${ESC}[19;2~`,
  "Shift+F9": `${ESC}[20;2~`,
  "Shift+F10": `${ESC}[21;2~`,
  "Shift+F11": `${ESC}[23;2~`,
  "Shift+F12": `${ESC}[24;2~`,
};

/**
 * The sequence to send to the PTY for this keydown, or `null` when the
 * combo is not ours and default handling (xterm / app shortcuts / native
 * menu) should proceed.
 */
export function itermSequenceFor(e: KeyboardEvent): string | null {
  return KEYMAP[comboOf(e)] ?? null;
}
