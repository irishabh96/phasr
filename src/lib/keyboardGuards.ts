/**
 * Guards shared by the app's window-level keyboard shortcuts.
 *
 * Task shortcuts (⌘W, ⌘T, ⌘1–9, ⌘Y/⌘⌫, ⌘., ⌘⇧R, ⌘I, ⌘⌥1–9, ⌘N) act on the
 * task underneath. While a dialog or the Settings sheet is open on top of
 * it, that task is out of sight, so they must not fire: ⌘W would kill a
 * hidden terminal, ⌘1 would start a command you can't see, ⌘Y would answer
 * the agent.
 */

const OPEN_OVERLAY_SELECTOR =
  "[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']";

/** `?settings=<section>` opens the Settings sheet over any route. */
function settingsSheetInUrl(search: string | undefined): boolean {
  if (!search) return false;
  try {
    return !!new URLSearchParams(search).get("settings");
  } catch {
    return false;
  }
}

/**
 * True while a modal surface owns the screen: any open Radix dialog
 * (New task, palette, confirm dialogs, the Settings sheet) or the Settings
 * sheet's search param (covers the frame between the URL change and the
 * sheet mounting). The inline approval card is `role="alertdialog"` with
 * no `data-state`, so it never counts.
 */
export function isOverlayOpen(doc: Document = document): boolean {
  if (doc.querySelector(OPEN_OVERLAY_SELECTOR)) return true;
  return settingsSheetInUrl(doc.defaultView?.location?.search);
}

/** Any terminal surface: the agent's, a shell tab, or a run command. */
export function inTerminalSurface(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el?.closest?.("[data-testid='terminal-surface']");
}

/** The task's own agent terminal (the pinned main tab). */
export function inAgentTerminal(target: EventTarget | null): boolean {
  const el = target as Element | null;
  return !!el?.closest?.("[data-testid='terminal-surface'][data-terminal-role='agent']");
}

/** A text field, select, contenteditable or the code editor. */
export function inEditable(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el?.closest) return false;
  if (inTerminalSurface(el)) return false;
  return !!el.closest(
    "input, textarea, select, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only'], .cm-editor",
  );
}

/**
 * Where the approval card's keys may fire from.
 *  - ⌘Y (allow once) from the page, or from the agent's own terminal,
 *    where the dialog it answers is showing. Never from a shell / run
 *    terminal or a field.
 *  - ⌘⌫ (deny) only from the page: in every terminal ⌘⌫ is kill-line, and
 *    in a field it deletes to the start of the line.
 */
export function approvalKeyAllowed(action: "allow" | "deny", target: EventTarget | null): boolean {
  if (inEditable(target)) return false;
  if (inTerminalSurface(target)) return action === "allow" && inAgentTerminal(target);
  return true;
}
