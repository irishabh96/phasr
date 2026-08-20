import type { SurfaceDisposable } from "@/lib/terminal/surface";

/**
 * Clipboard for the ghostty backend — the "ladder" from the migration
 * plan's Phase 0 question 2.
 *
 * ## The problem
 *
 * phasr's only copy/paste path is `PredefinedMenuItem::copy` /
 * `::paste` in `src-tauri/src/lib.rs`. Those send the native `copy:` /
 * `paste:` responder actions, and they worked before *only* because the
 * old engine intercepted `copy`/`paste` on its hidden textarea. ghostty-web draws
 * its selection on a `<canvas>`: there is no DOM selection anywhere, so
 * WebKit has nothing to copy from.
 *
 * ## What ghostty-web@0.4.0 actually ships (verified in `dist/`)
 *
 * - `paste` **is** listened for, twice: `InputHandler` on the container
 *   and `Terminal.open()` on the hidden textarea. So the plan's "no DOM
 *   clipboard listeners" is only half right — paste has cover, copy has
 *   none.
 * - There is **no** `copy` or `cut` listener anywhere.
 * - `SelectionManager` auto-copies to the clipboard on mouseup and on
 *   dblclick (`copyToClipboard(getSelection())`), i.e. copy-on-select,
 *   iTerm style. That is a real behaviour change from before and is not
 *   opt-out-able — recorded in ADR-002 rather than worked around.
 *
 * ## Rung 1 (installed here, always)
 *
 * Capture-phase `copy`/`cut`/`paste` on the surface element. Capture
 * matters: it runs before both of ghostty-web's own paste listeners, and
 * `stopPropagation()` then guarantees exactly one paste rather than two.
 *
 * ## Rung 2 (implemented, off by default — see `installSelectionMirror`)
 *
 * If WebKit refuses to *dispatch* `copy` because `Editor::canCopy()` is
 * false with no live DOM selection, mirror the terminal selection into
 * ghostty-web's hidden textarea and `select()` it. Not enabled by
 * default because it cannot be verified anywhere except a built `.app`
 * (Chromium happily dispatches `copy` either way), so turning it on
 * blind would be shipping an untested input-path change.
 *
 * ## Rung 3
 *
 * Replacing the `PredefinedMenuItem`s with custom `MenuItem`s that emit a
 * Tauri event. **Not implemented and not to be implemented without
 * asking** — we would then own copy/paste for every plain `<input>` in
 * the app.
 */

/** The slice of `ghostty-web`'s `Terminal` the clipboard needs. */
export interface GhosttyClipboardTerminal {
  getSelection(): string;
  hasSelection(): boolean;
  paste(data: string): void;
  readonly textarea?: HTMLTextAreaElement | undefined;
  onSelectionChange(listener: () => void): { dispose(): void };
}

const MIRROR_KEY = "phasr.terminal.clipboardMirror";

/**
 * Rung 2's switch. `localStorage.setItem("phasr.terminal.clipboardMirror",
 * "1")` and reload — deliberately runtime-flippable so the manual
 * WKWebView pass can answer Phase 0 question 2 in one session instead of
 * one build per rung.
 */
export function selectionMirrorEnabled(): boolean {
  try {
    return localStorage.getItem(MIRROR_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Copy-on-select for the gestures phasr owns (`backends/ghostty/selection.ts`).
 *
 * ghostty-web copies whatever a DRAG selects from its own `mouseup`
 * handler, so a double- or triple-click that did not go through it has to
 * do the same or the two gestures would disagree about whether selecting
 * copies. Same two rungs as upstream's private `copyToClipboard`: the
 * async API first, then the hidden textarea + `execCommand`, which is the
 * only path that works when the async one is unavailable or rejects.
 */
export function copySelectionText(
  text: string,
  textarea?: HTMLTextAreaElement | undefined,
): void {
  if (!text) return;
  const clipboard = navigator.clipboard as Clipboard | undefined;
  if (typeof clipboard?.writeText === "function") {
    void clipboard.writeText(text).catch(() => legacyCopy(text, textarea));
    return;
  }
  legacyCopy(text, textarea);
}

function legacyCopy(
  text: string,
  textarea: HTMLTextAreaElement | undefined,
): void {
  const host = textarea ?? document.createElement("textarea");
  const detached = host !== textarea;
  const previous = document.activeElement;
  try {
    if (detached) {
      host.style.position = "fixed";
      host.style.opacity = "0";
      document.body.appendChild(host);
    }
    host.value = text;
    host.focus();
    host.select();
    host.setSelectionRange(0, text.length);
    document.execCommand("copy");
  } catch {
    /* nothing else to try */
  } finally {
    if (detached) host.remove();
    else host.value = "";
    if (previous instanceof HTMLElement) previous.focus();
  }
}

/** Rung 1. */
export function installGhosttyClipboard(
  element: HTMLElement,
  term: GhosttyClipboardTerminal,
): SurfaceDisposable {
  const onCopy = (event: ClipboardEvent) => {
    if (!term.hasSelection()) return;
    const text = term.getSelection();
    if (!text) return;
    event.clipboardData?.setData("text/plain", text);
    event.preventDefault();
    event.stopPropagation();
  };

  // A terminal has nothing to cut. Treating ⌘X as a copy is what iTerm
  // and Terminal.app do, and it is strictly better than the alternative
  // (the event falls through to the contenteditable host ghostty-web
  // installs on this element and mutates the DOM under the canvas).
  const onCut = onCopy;

  const onPaste = (event: ClipboardEvent) => {
    const text = event.clipboardData?.getData("text");
    event.preventDefault();
    // Stops ghostty-web's own two paste listeners (container + textarea)
    // from firing on the way back up — otherwise a single ⌘V pastes twice.
    event.stopPropagation();
    if (text) term.paste(text);
  };

  element.addEventListener("copy", onCopy, { capture: true });
  element.addEventListener("cut", onCut, { capture: true });
  element.addEventListener("paste", onPaste, { capture: true });

  const mirror = selectionMirrorEnabled()
    ? installSelectionMirror(term)
    : null;

  return {
    dispose() {
      element.removeEventListener("copy", onCopy, { capture: true });
      element.removeEventListener("cut", onCut, { capture: true });
      element.removeEventListener("paste", onPaste, { capture: true });
      mirror?.dispose();
    },
  };
}

/**
 * Rung 2: keep ghostty-web's hidden textarea holding — and selecting —
 * whatever the terminal has selected, so `Editor::canCopy()` is true and
 * WebKit will both enable Edit ▸ Copy and dispatch a `copy` event that
 * rung 1 can answer.
 *
 * The mechanism is not speculative: ghostty-web does exactly this in its
 * own `contextmenu` handler so the right-click menu can copy. This just
 * does it on every selection change instead of only on right-click.
 *
 * Safe with respect to typing: `InputHandler` calls `preventDefault()` on
 * every printable keydown, so a focused, selected textarea never actually
 * receives text.
 */
export function installSelectionMirror(
  term: GhosttyClipboardTerminal,
): SurfaceDisposable {
  const sync = () => {
    const textarea = term.textarea;
    if (!textarea) return;
    const text = term.hasSelection() ? term.getSelection() : "";
    textarea.value = text;
    if (!text) return;
    textarea.select();
    textarea.setSelectionRange(0, text.length);
  };
  const sub = term.onSelectionChange(sync);
  return { dispose: () => sub.dispose() };
}
