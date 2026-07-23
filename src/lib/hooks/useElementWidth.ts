import { useEffect, useState } from "react";

/**
 * Track an element's content-box width with a ResizeObserver.
 *
 * Returns a `[ref, width]` pair. `width` is `null` until the first measurement
 * lands, so a caller can pick a SAFE default before layout settles (e.g. treat
 * "unknown" as the narrow / compact branch — never a wide branch that would
 * clip on first paint).
 *
 * `ref` is a CALLBACK ref (not a RefObject) on purpose: the host component may
 * render a loading / error state first and only mount the measured element on a
 * later render. A callback ref re-attaches the observer exactly when the real
 * node appears; a `useEffect([refObject])` would run once against a null ref and
 * never reconnect.
 *
 * Used to make the workspace header and the right-hand Changes panel respond to
 * their OWN width rather than a hard-coded viewport breakpoint: the real
 * constraint is how much room the toolbar or the panel actually has (the user
 * can resize either sidebar), not the window size.
 */
export function useElementWidth<T extends HTMLElement = HTMLElement>(): [
  (node: T | null) => void,
  number | null,
] {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!node) return;
    // Seed from the current box so the first committed width isn't a frame late.
    setWidth(node.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect?.width;
        if (typeof w === "number") setWidth(w);
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);

  return [setNode, width];
}
