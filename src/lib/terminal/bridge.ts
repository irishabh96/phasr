import { routeDroppedPaths } from "@/lib/terminal/drop";
import type {
  TerminalBackendKind,
  TerminalSurface,
} from "@/lib/terminal/surface";

/**
 * DEV-only introspection bridge for e2e.
 *
 * Playwright used to reach into the emulator's private DOM and
 * divide its bounding box by hardcoded grid dimensions to find a cell.
 * That coupled the suite to one emulator's markup AND was silently wrong
 * at any other viewport size. This bridge asks the surface instead, so a
 * spec locates a cell exactly, and does so identically on every backend.
 *
 * Gated on `import.meta.env.DEV`, the same way `routes/design-test.tsx`
 * gates its harness route: the registry is never populated and the global
 * is never installed in a production bundle.
 */

/** Plain, structured-cloneable rect — a `DOMRect`'s fields are prototype
 *  getters and serialize to `{}` across the Playwright boundary. */
export interface BridgeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TerminalBridge {
  /** Ids of every live surface, in creation order. */
  ids(): string[];
  grid(id: string): { rows: number; cols: number } | null;
  /** Viewport-relative — `row` 0 is the top VISIBLE line. What a click wants. */
  cellRect(id: string, col: number, row: number): BridgeRect | null;
  /** Buffer-absolute — `row` counts from the top of SCROLLBACK, not the
   *  viewport. Mirrors `TerminalSurface.readLine`; the two coincide only
   *  while nothing has scrolled off. */
  lineText(id: string, row: number): string | null;
  /**
   * Scroll state — the discriminator between "the buffer really has blank
   * rows at the top" and "the viewport is scrolled off the bottom". Those
   * are pixel-identical on screen and have opposite fixes, so a spec that
   * asserts on content POSITION has to be able to ask.
   */
  viewport(id: string): { offset: number; scrollback: number } | null;
  backend(id: string): TerminalBackendKind | null;
  /** OS file drops arrive through Tauri, which Playwright cannot emit, so
   *  a spec exercises the routing directly at a real screen point. */
  dropPaths(paths: string[], x: number, y: number): void;
  /**
   * Force a full redraw — the ORACLE for "what is on screen matches the
   * buffer". The render loop is incremental (it repaints only the rows the
   * emulator marked dirty), so a spec cannot tell a correct screen from a
   * stale one by looking at pixels alone. It can compare the live canvas
   * with the canvas after this call: a full redraw is by definition the
   * truth, so any difference is a row the incremental path failed to
   * repaint. See `e2e/terminal-stale-rows.spec.ts`.
   */
  repaint(id: string): void;
}

declare global {
  interface Window {
    __PHASR_TERM__?: TerminalBridge;
  }
}

const live = new Map<string, TerminalSurface>();

function bridge(): TerminalBridge {
  return {
    ids: () => [...live.keys()],
    grid: (id) => {
      const s = live.get(id);
      return s ? { rows: s.rows, cols: s.cols } : null;
    },
    cellRect: (id, col, row) => {
      const rect = live.get(id)?.cellRect(col, row);
      if (!rect) return null;
      const { x, y, width, height } = rect;
      return { x, y, width, height };
    },
    lineText: (id, row) => live.get(id)?.readLine(row) ?? null,
    viewport: (id) => live.get(id)?.readViewport() ?? null,
    backend: (id) => live.get(id)?.kind ?? null,
    dropPaths: (paths, x, y) => routeDroppedPaths(paths, { x, y }),
    repaint: (id) => live.get(id)?.repaint(),
  };
}

/**
 * Publish a surface to the bridge. Called by the factory, so no component
 * has to remember and every backend is covered by construction.
 *
 * `dispose` is wrapped rather than tracked separately: the registry must
 * not be able to outlive the emulator and hand a spec a disposed terminal
 * that answers `null` to everything. DEV-only, so the instance-level
 * shadowing of the prototype method never reaches users.
 */
export function registerSurfaceForTests(surface: TerminalSurface): void {
  if (!import.meta.env.DEV) return;
  live.set(surface.id, surface);
  const dispose = surface.dispose.bind(surface);
  surface.dispose = () => {
    live.delete(surface.id);
    dispose();
  };
  if (typeof window !== "undefined" && !window.__PHASR_TERM__) {
    window.__PHASR_TERM__ = bridge();
  }
}
