import type { SurfaceDisposable, TerminalSurface } from "@/lib/terminal/surface";

/**
 * Terminals outlive their React components. A surface's element stays in
 * the document forever: when the component unmounts, the element is parked
 * in this offscreen host instead of being detached, so the renderer keeps
 * its GPU context, the scrollback survives, and the live PTY channel keeps
 * writing into the same emulator. The next mount just moves the element
 * back into its slot.
 *
 * There is exactly ONE park host for the whole app (agent terminals, shell
 * tabs, anything later) — it used to be two identical copies in two
 * components.
 */
let parkHost: HTMLDivElement | null = null;

export function getParkHost(): HTMLDivElement {
  if (!parkHost) {
    parkHost = document.createElement("div");
    parkHost.setAttribute("aria-hidden", "true");
    Object.assign(parkHost.style, {
      position: "fixed",
      left: "-9999px",
      top: "0",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      visibility: "hidden",
      pointerEvents: "none",
    });
    document.body.appendChild(parkHost);
  }
  return parkHost;
}

/** Move a surface offscreen without destroying it. */
export function parkSurface(surface: TerminalSurface): void {
  // Nothing offscreen should be drawing. A no-op on an engine that renders on
  // demand), but the park path is exactly where a backend with a
  // free-running frame loop has to be told to stop, so it is wired here —
  // once — rather than in each of the three components.
  surface.setActive(false);
  getParkHost().appendChild(surface.element);
}

/**
 * Is this surface currently parked offscreen (as opposed to sitting in a
 * component's mount slot)? Only a parked surface may be evicted: a mounted
 * component holds its own reference and will not re-run its mount effect,
 * so disposing underneath it would leave a permanently blank terminal.
 */
export function isParked(surface: TerminalSurface): boolean {
  return parkHost !== null && parkHost.contains(surface.element);
}

/**
 * Is this surface big enough to fit against? Fitting a 0×0 (or parked)
 * element collapses the grid to its 2×1 minimum and the renderer gets
 * stuck painting into that tiny region even after the tab is visible
 * again. The park host is 1px, hence `>= 2` rather than `>= 1`.
 */
export function isSurfaceVisible(element: HTMLElement): boolean {
  return (
    element.isConnected && element.clientWidth >= 2 && element.clientHeight >= 2
  );
}

export interface SurfaceCacheEntry {
  surface: TerminalSurface;
  /** Input/resize handlers — replaced on each remount. */
  inputDisposables: SurfaceDisposable[];
}

const DEFAULT_MAX_CACHED = 8;
const MAX_CACHED_KEY = "phasr.terminal.maxCached";

/**
 * How many live terminals to keep. Deliberately generous — eviction costs
 * the user scrollback (see below) — but bounded, because each surface holds
 * a renderer and, on the WebGL backend, one of the browser's ~16 GPU
 * contexts. Unbounded, a long session with many workspaces silently ran out.
 */
export function maxCachedSurfaces(): number {
  try {
    const parsed = Number.parseInt(localStorage.getItem(MAX_CACHED_KEY) ?? "", 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
  } catch {
    // Storage can be unavailable (private mode, disabled cookies).
  }
  return DEFAULT_MAX_CACHED;
}

interface Evictable {
  /** @returns true if it actually went. */
  evict(): boolean;
}

/**
 * Every cached surface in the app, least-recently-used FIRST. The budget is
 * global (GPU contexts are), so this spans every cache instance rather than
 * each one policing itself — two caches bounded at 8 apiece would be 16
 * live terminals, i.e. exactly the limit they exist to stay under.
 *
 * `Map` preserves insertion order and re-inserting moves a key to the end,
 * which is the whole LRU.
 */
const recency = new Map<string, Evictable>();

function touch(key: string, target: Evictable): void {
  recency.delete(key);
  recency.set(key, target);
}

function enforce(): void {
  const limit = maxCachedSurfaces();
  // Oldest first; each successful evict removes itself from `recency`.
  for (const target of [...recency.values()]) {
    if (recency.size <= limit) return;
    target.evict();
  }
}

/** Test seam: drop all recency bookkeeping without touching any surface. */
export function __resetSurfaceRecency(): void {
  recency.clear();
}

/**
 * Keyed store of live terminals, bounded by a global LRU.
 *
 * **Eviction disposes the surface and never the PTY.** The process keeps
 * running and keeps writing into its replay buffer; the next mount finds no
 * cache entry, builds a fresh surface, and re-attaches through the same
 * `subscribe_with_replay()` path a cold attach uses.
 *
 * The cost the user pays is scrollback: the replay buffer is 128 KB, which
 * is only ~1–2 screens of a busy TUI, so an evicted terminal comes back with
 * its recent output but not its history. That is why the bound is 8 and not
 * 2, and why evictions are logged — if they show up in normal use, the
 * bound is too tight rather than the design being wrong.
 */
export class TerminalSurfaceCache<T extends SurfaceCacheEntry> {
  private readonly entries = new Map<string, T>();

  /** @param namespace disambiguates ids across caches in the global LRU. */
  constructor(private readonly namespace: string) {}

  private globalKey(id: string): string {
    return `${this.namespace}:${id}`;
  }

  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (entry) touch(this.globalKey(id), { evict: () => this.evict(id) });
    return entry;
  }

  set(id: string, entry: T): void {
    this.entries.set(id, entry);
    touch(this.globalKey(id), { evict: () => this.evict(id) });
    enforce();
  }

  /** Explicit teardown: input handlers, then the surface (and its DOM). */
  dispose(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    for (const d of entry.inputDisposables) d.dispose();
    entry.inputDisposables = [];
    entry.surface.dispose();
    this.entries.delete(id);
    recency.delete(this.globalKey(id));
  }

  /**
   * LRU eviction. Refuses anything currently mounted — a live component
   * holds this surface and will not rebuild it, so disposing it there would
   * blank the terminal for good instead of costing scrollback.
   */
  private evict(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) {
      recency.delete(this.globalKey(id));
      return false;
    }
    if (!isParked(entry.surface)) return false;
    this.dispose(id);
    console.info(
      `[terminal] evicted ${this.globalKey(id)} (over ${maxCachedSurfaces()} cached); ` +
        `its process is untouched and the next mount re-attaches with replay`,
    );
    return true;
  }
}
