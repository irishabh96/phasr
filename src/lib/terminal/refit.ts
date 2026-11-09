import { isPanelAnimating, onPanelsSettled } from "@/lib/panelMotion";
import { isSurfaceVisible } from "./cache";
import type { TerminalSurface } from "./surface";

/**
 * Terminal refits (spec P1/P2).
 *
 * - A `ResizeObserver` burst becomes at most one fit per animation frame.
 * - While a side panel animates (`isPanelAnimating`) nothing fits; when the
 *   panels settle, each visible terminal fits exactly once at the final size.
 * - A fit at the size the surface was last fitted at is skipped, so the
 *   observer's echo of a size we already adopted costs nothing.
 *
 * Every component fit goes through `fitSurfaceNow`, which records the size
 * it fitted at (the dedupe key) and feeds the dev-only probe the e2e suite
 * reads (`window.__PHASR_PERF__`).
 */

const fittedAt = new WeakMap<TerminalSurface, string>();

function sizeKey(el: HTMLElement): string {
  return `${el.clientWidth}x${el.clientHeight}`;
}

interface PerfProbe {
  terminalFits: number;
  terminalFitsWhileAnimating: number;
}

function probe(): PerfProbe | null {
  if (!import.meta.env.DEV || typeof window === "undefined") return null;
  const w = window as unknown as { __PHASR_PERF__?: PerfProbe };
  return (w.__PHASR_PERF__ ??= { terminalFits: 0, terminalFitsWhileAnimating: 0 });
}

/** Fit now (anchored) and remember the size it was fitted at. */
export function fitSurfaceNow(surface: TerminalSurface): void {
  fittedAt.set(surface, sizeKey(surface.element));
  const p = probe();
  if (p) {
    p.terminalFits += 1;
    if (isPanelAnimating()) p.terminalFitsWhileAnimating += 1;
  }
  surface.fitAnchored();
}

export interface SurfaceRefitter {
  /**
   * Fit now unless hidden or a panel is animating. `force` skips the
   * same-size check — for the settle timers that catch a late window
   * maximize, where the size may not have moved yet the measure was stale.
   */
  now(opts?: { force?: boolean }): void;
  dispose(): void;
}

/**
 * Wire a surface's resize sources: a `ResizeObserver` on `observe`, the
 * window `resize` event, and the panels-settled signal.
 */
export function watchSurfaceSize(surface: TerminalSurface, observe: HTMLElement): SurfaceRefitter {
  let raf = 0;
  let force = false;

  const now = (opts?: { force?: boolean }) => {
    const f = force || !!opts?.force;
    force = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    // The panels-settled callback below refits once the transition ends.
    if (isPanelAnimating()) return;
    if (!isSurfaceVisible(surface.element)) return;
    if (!f && fittedAt.get(surface) === sizeKey(surface.element)) return;
    fitSurfaceNow(surface);
  };

  const schedule = (opts?: { force?: boolean }) => {
    if (opts?.force) force = true;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      now();
    });
  };

  const resizeObserver = new ResizeObserver(() => schedule());
  resizeObserver.observe(observe);
  const onWindowResize = () => schedule({ force: true });
  window.addEventListener("resize", onWindowResize);
  const offSettled = onPanelsSettled(() => now());

  return {
    now,
    dispose() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowResize);
      offSettled();
    },
  };
}
