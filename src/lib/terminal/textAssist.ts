/**
 * Keep the OS's writing aids off a terminal's input elements.
 *
 * ghostty-web takes keyboard input through two editable elements: the host
 * element it is opened on (made `contenteditable`, `role="textbox"`, and
 * the one `term.focus()` focuses) and a 1px hidden `<textarea>` at the
 * host's top-left (focused when the canvas is clicked). To macOS both look
 * like an empty text field, so WebKit offers Writing Tools ("Write with
 * Siri") and inline predictions there, anchored at the terminal's top-left
 * corner, and anything they insert would be typed into the PTY.
 *
 * These attributes are the per-element opt-outs WebKit honours:
 * `writingsuggestions="false"` (inline predictions; WebKit 18+),
 * `spellcheck`, `autocorrect`, `autocapitalize`, and `autocomplete` on the
 * textarea. Writing Tools itself has no documented per-element switch in
 * WebKit (the SDK only exposes `WKWebViewConfiguration.writingToolsBehavior`),
 * so the app turns it off for the whole webview at window creation
 * (src-tauri, `writing_tools.rs`).
 */
export const TEXT_ASSIST_OFF: Readonly<Record<string, string>> = {
  writingsuggestions: "false",
  spellcheck: "false",
  autocorrect: "off",
  autocapitalize: "off",
};

export function disableTextAssistance(el: HTMLElement): void {
  for (const [name, value] of Object.entries(TEXT_ASSIST_OFF)) el.setAttribute(name, value);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.setAttribute("autocomplete", "off");
  } else if (el.getAttribute("role") === "textbox") {
    // The host is the accessible textbox; it suggests nothing.
    el.setAttribute("aria-autocomplete", "none");
  }
}
