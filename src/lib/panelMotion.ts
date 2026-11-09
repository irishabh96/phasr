/**
 * Side-panel motion bookkeeping (spec P1).
 *
 * The sidebar and the inspector collapse with a transform inside a clipped
 * container, so the centre column changes width once, not on every frame.
 * While one of them animates, the shell carries `data-panel-animating` and
 * terminals hold their refits; when the last animation ends the panel's
 * final width is already committed, and every terminal refits exactly once.
 */

type Listener = () => void;

let active = 0;
const listeners = new Set<Listener>();

function shell(): HTMLElement | null {
  return typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>("[data-app-shell]");
}

/** True while any side panel is mid-transition. */
export function isPanelAnimating(): boolean {
  return active > 0;
}

/** Mark a panel transition as started. Pair with `endPanelAnimation`. */
export function beginPanelAnimation(): void {
  active += 1;
  if (active === 1) shell()?.setAttribute("data-panel-animating", "");
}

/**
 * Mark a panel transition as finished. Call it only after the panel's final
 * width is in the DOM (a layout effect), so the refits it triggers measure
 * the settled layout.
 */
export function endPanelAnimation(): void {
  if (active === 0) return;
  active -= 1;
  if (active > 0) return;
  shell()?.removeAttribute("data-panel-animating");
  for (const l of [...listeners]) l();
}

/** Run `cb` each time the last running panel animation settles. */
export function onPanelsSettled(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
