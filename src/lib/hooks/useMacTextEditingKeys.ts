import { useEffect } from "react";

/**
 * macOS text-editing chords for every HTML input/textarea.
 *
 * The wry/WKWebView embedding delivers ⌘-modified keydowns to JS (that's
 * how ⌘K/⌘W/⌘T work) but never runs the native editing actions behind
 * them (`deleteToBeginningOfLine:`, `moveToBeginningOfLine:` …), so
 * ⌘⌫ / ⌘← / ⌘→ have always been dead in fields. This hook implements
 * them directly on the focused field.
 *
 * Terminals are excluded — xterm's helper textarea gets the iTerm keymap
 * (`src/lib/terminal/keymap.ts`) instead.
 *
 * Line boundaries are logical (`\n`), not visual wraps: single-line
 * inputs treat the whole value as one line; textareas behave per-line.
 */

/** Input types that support the selection APIs. */
const SELECTABLE_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "password",
]);

type Field = HTMLInputElement | HTMLTextAreaElement;

function editableFieldOf(e: KeyboardEvent): Field | null {
  const t = e.target;
  if (t instanceof HTMLTextAreaElement) {
    // xterm's hidden textarea — the terminal keymap owns those keys.
    if (t.classList.contains("xterm-helper-textarea")) return null;
    return t.readOnly || t.disabled ? null : t;
  }
  if (t instanceof HTMLInputElement) {
    if (!SELECTABLE_INPUT_TYPES.has(t.type)) return null;
    return t.readOnly || t.disabled ? null : t;
  }
  return null;
}

function lineStartOf(value: string, pos: number): number {
  return value.lastIndexOf("\n", pos - 1) + 1;
}

function lineEndOf(value: string, pos: number): number {
  const nl = value.indexOf("\n", pos);
  return nl === -1 ? value.length : nl;
}

/**
 * The selection's two ends: `anchor` stays put when extending, `focus`
 * is the end that moves (the caret when collapsed).
 */
function selectionEndsOf(el: Field): { anchor: number; focus: number } {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? 0;
  return el.selectionDirection === "backward"
    ? { anchor: end, focus: start }
    : { anchor: start, focus: end };
}

function extendTo(el: Field, anchor: number, newFocus: number): void {
  el.setSelectionRange(
    Math.min(anchor, newFocus),
    Math.max(anchor, newFocus),
    newFocus < anchor ? "backward" : "forward",
  );
}

/** Exported for direct unit testing; installed by the hook below. */
export function handleMacTextEditingKey(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (!e.metaKey || e.ctrlKey || e.altKey) return;

  const el = editableFieldOf(e);
  if (!el) return;

  const value = el.value;
  const selStart = el.selectionStart ?? 0;
  const selEnd = el.selectionEnd ?? 0;

  if (e.key === "Backspace" && !e.shiftKey) {
    // deleteToBeginningOfLine: removes [line start, selection end].
    const start = lineStartOf(value, selStart);
    if (start === selEnd) {
      e.preventDefault();
      return; // already at line start — consume, don't fall through
    }
    el.setRangeText("", start, selEnd, "start");
    // React's value tracker was bypassed by setRangeText, so this event
    // reaches onChange and controlled fields stay in sync.
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "deleteContentBackward",
      }),
    );
    e.preventDefault();
    return;
  }

  if (e.key === "ArrowLeft") {
    if (e.shiftKey) {
      const { anchor, focus } = selectionEndsOf(el);
      extendTo(el, anchor, lineStartOf(value, focus));
    } else {
      const start = lineStartOf(value, selStart);
      el.setSelectionRange(start, start);
    }
    e.preventDefault();
    return;
  }

  if (e.key === "ArrowRight") {
    if (e.shiftKey) {
      const { anchor, focus } = selectionEndsOf(el);
      extendTo(el, anchor, lineEndOf(value, focus));
    } else {
      const end = lineEndOf(value, selEnd);
      el.setSelectionRange(end, end);
    }
    e.preventDefault();
  }
}

/**
 * Install once at the app shell. Capture phase so the chords work even
 * inside components that stopPropagation in their own bubble handlers.
 */
export function useMacTextEditingKeys(): void {
  useEffect(() => {
    window.addEventListener("keydown", handleMacTextEditingKey, {
      capture: true,
    });
    return () =>
      window.removeEventListener("keydown", handleMacTextEditingKey, {
        capture: true,
      });
  }, []);
}
