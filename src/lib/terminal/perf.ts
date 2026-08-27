/**
 * Perf Phase 0 — the measurement half of `specs/perf-p0-measurement-baseline-spec.md`.
 *
 * Everything here exists to make four numbers observable on the runtime
 * phasr actually ships on, without touching any hot path when it is off:
 *
 *   - keystroke→paint latency (last / p50 / p95),
 *   - fps (movement of the render loop's own tick counter),
 *   - parse backlog (bytes the surface is holding that the engine has not
 *     parsed yet — `pendingWrites` before attach plus the held grapheme
 *     tail; the engine itself parses synchronously in `write()`, so there
 *     is no engine-side queue to count),
 *   - bytes/s of PTY output.
 *
 * **Latency rule (criterion 2 of the spec).** A `performance.mark` is
 * placed in the surface's `onData` path — the moment the emulator turned a
 * key event into bytes for the PTY — and resolved against the patched
 * engine's `getRenderStats()`: the sample is `lastFrameAt - markTime` for
 * the FIRST frame whose entry stamp is at or after the mark, because
 * `lastFrameAt` is stamped on frame entry and a frame that entered before
 * the mark cannot have painted its consequence. A frame that ran too early
 * (`ticks` moved, `lastFrameAt` still behind the mark) leaves the mark
 * pending rather than producing a garbage sample; a mark that outlives
 * `MARK_EXPIRE_MS` (hidden page, rAF stopped) is dropped, not recorded.
 *
 * Gating: DEV builds only, and off by default even there. `import.meta.env.DEV`
 * is compile-time false in a production bundle, so `createSurfacePerf`
 * returns `null` before any of this allocates — the HUD *cannot* render in
 * a shipped build. In dev it turns on via localStorage (same pattern as
 * `diagnostics.ts`) or `VITE_PERF_HUD=1`:
 *
 *   localStorage.setItem("phasr.perf.hud", "1"); location.reload();
 *   // or from the console: __PHASR_PERF__.enable()
 */

import { attachPerfHud, type PerfHud } from "@/lib/terminal/perfHud";

export const PERF_FLAG = "phasr.perf.hud";

/** Samples kept for the percentiles — enough for a burst of typing. */
const SAMPLE_RING = 240;
/** Pending marks kept; typing cannot realistically outrun this per frame. */
const MAX_PENDING = 128;
/** A mark unresolved this long is a stopped rAF, not a slow frame. */
export const MARK_EXPIRE_MS = 2000;
/** Rolling window for the bytes/s meter. */
const RATE_WINDOW_MS = 2000;
/** HUD DOM writes are throttled to this. */
const HUD_UPDATE_MS = 250;

/**
 * What the `getScrollbackLine` microbench reports (spec criterion 7 / the
 * architect's Q5). Implemented by the ghostty backend, driven through the
 * DEV bridge so the e2e probe crosses the Playwright boundary once and
 * loops inside the page.
 */
export interface ScrollbackBenchResult {
  /** History depth at bench time. */
  depth: number;
  /** Lines actually timed. */
  sampled: number;
  /** Wall ms for the fetch-only pass (`getScrollbackLine` + cell walk). */
  fetchMs: number;
  /** Wall ms for fetch + text assembly + `getScrollbackGraphemeString`. */
  graphemeMs: number;
  fetchLinesPerSec: number;
  graphemeLinesPerSec: number;
  fetchUsPerLine: number;
  graphemeUsPerLine: number;
  /** Anti-DCE witnesses; also say the sampled lines held real content. */
  cells: number;
  chars: number;
}

/** The slice of the patched `getRenderStats()` the samplers read. */
export interface RenderStatsLike {
  ticks: number;
  lastFrameAt: number;
  paused: boolean;
  open: boolean;
  disposed: boolean;
}

export function perfEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  if (import.meta.env.VITE_PERF_HUD === "1") return true;
  try {
    return window.localStorage.getItem(PERF_FLAG) === "1";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure maths — unit-tested in perf.test.ts
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile over an UNSORTED sample list. Matches the
 * `sorted[floor(length * q)]` convention every existing probe logs, so a
 * HUD number and a probe number are the same statistic.
 */
export function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

export interface LatencySummary {
  last: number;
  p50: number;
  p95: number;
  count: number;
  /** Marks dropped because no frame arrived in time — a stalled loop. */
  expired: number;
}

interface PendingMark {
  t: number;
  ticks: number;
}

/**
 * The mark→frame resolver. Pure: time and stats are handed in, so the
 * whole resolution rule is testable without a browser.
 */
export class LatencyTracker {
  private readonly pending: PendingMark[] = [];
  private readonly samples: number[] = [];
  private last = 0;
  private expired = 0;
  private total = 0;

  /** Place a mark: input left the emulator at `t`, tick counter at `ticks`. */
  mark(t: number, ticks: number): void {
    if (this.pending.length >= MAX_PENDING) this.pending.shift();
    this.pending.push({ t, ticks });
  }

  /**
   * A frame observation. Resolves every pending mark the frame can answer
   * for; expires marks nothing will ever answer for.
   *
   * @returns the samples recorded by THIS call (for performance.measure).
   */
  onFrame(stats: RenderStatsLike, now: number): number[] {
    const recorded: number[] = [];
    for (let i = 0; i < this.pending.length; ) {
      const m = this.pending[i]!;
      if (stats.ticks > m.ticks && stats.lastFrameAt >= m.t) {
        const sample = stats.lastFrameAt - m.t;
        this.record(sample);
        recorded.push(sample);
        this.pending.splice(i, 1);
        continue;
      }
      if (now - m.t > MARK_EXPIRE_MS) {
        // A dropped frame must not corrupt a sample: the mark dies, the
        // statistics don't learn a 2000ms "latency" that never happened.
        this.expired += 1;
        this.pending.splice(i, 1);
        continue;
      }
      i += 1;
    }
    return recorded;
  }

  private record(sample: number): void {
    this.last = sample;
    this.total += 1;
    this.samples.push(sample);
    if (this.samples.length > SAMPLE_RING) this.samples.shift();
  }

  summary(): LatencySummary {
    return {
      last: this.last,
      p50: percentile(this.samples, 0.5),
      p95: percentile(this.samples, 0.95),
      count: this.total,
      expired: this.expired,
    };
  }

  pendingCount(): number {
    return this.pending.length;
  }
}

/** Rolling bytes/s over `RATE_WINDOW_MS`. */
export class RateMeter {
  private readonly events: { t: number; n: number }[] = [];

  add(n: number, t: number): void {
    this.events.push({ t, n });
    this.prune(t);
  }

  perSecond(t: number): number {
    this.prune(t);
    let sum = 0;
    for (const e of this.events) sum += e.n;
    return (sum * 1000) / RATE_WINDOW_MS;
  }

  private prune(t: number): void {
    while (this.events.length > 0 && t - this.events[0]!.t > RATE_WINDOW_MS) {
      this.events.shift();
    }
  }
}

// ---------------------------------------------------------------------------
// Per-surface instrumentation
// ---------------------------------------------------------------------------

export interface SurfacePerfHooks {
  getStats(): RenderStatsLike | null;
  backlogBytes(): number;
  host: HTMLElement;
}

export interface PerfSnapshot {
  id: string;
  latency: LatencySummary;
  fps: number;
  bytesPerSec: number;
  backlogBytes: number;
  ticks: number;
}

export class SurfacePerf {
  private readonly latency = new LatencyTracker();
  private readonly rate = new RateMeter();
  private hooks: SurfacePerfHooks | null = null;
  private hud: PerfHud | null = null;
  private raf: number | null = null;
  private active = true;
  private disposed = false;
  private lastHudAt = 0;
  private lastFpsAt = 0;
  private lastFpsTicks = 0;
  private fps = 0;
  private marksPlaced = 0;

  constructor(readonly id: string) {}

  /** The surface's `onData` fired — user input just left the emulator. */
  input(): void {
    if (this.disposed) return;
    const stats = this.hooks?.getStats();
    if (!stats || stats.paused || !stats.open || stats.disposed) return;
    const now = performance.now();
    // The criterion-2 mark, visible in a devtools timeline. Cleared
    // periodically so a long dev session does not grow the entry buffer.
    performance.mark("phasr:term-input");
    this.marksPlaced += 1;
    if (this.marksPlaced % 512 === 0) {
      performance.clearMarks("phasr:term-input");
      performance.clearMeasures("phasr:input-paint");
    }
    this.latency.mark(now, stats.ticks);
  }

  /** PTY output entered the surface's write path. */
  output(bytes: number): void {
    if (this.disposed) return;
    this.rate.add(bytes, performance.now());
  }

  /** Engine attached; start the sampling loop and the HUD. */
  attach(hooks: SurfacePerfHooks): void {
    if (this.disposed) return;
    this.hooks = hooks;
    this.hud = attachPerfHud(hooks.host);
    this.startLoop();
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) this.startLoop();
    else this.stopLoop();
  }

  snapshot(): PerfSnapshot {
    const stats = this.hooks?.getStats();
    return {
      id: this.id,
      latency: this.latency.summary(),
      fps: this.fps,
      bytesPerSec: this.rate.perSecond(performance.now()),
      backlogBytes: this.hooks?.backlogBytes() ?? 0,
      ticks: stats?.ticks ?? 0,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoop();
    this.hud?.dispose();
    this.hud = null;
    this.hooks = null;
    perfRegistry.delete(this.id);
  }

  private startLoop(): void {
    if (this.disposed || this.raf !== null || typeof window === "undefined")
      return;
    const tick = () => {
      this.raf = null;
      if (this.disposed || !this.active) return;
      this.sample();
      this.raf = window.requestAnimationFrame(tick);
    };
    this.raf = window.requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf !== null) {
      window.cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  private sample(): void {
    const stats = this.hooks?.getStats();
    if (!stats) return;
    const now = performance.now();

    const recorded = this.latency.onFrame(stats, now);
    for (const sample of recorded) {
      // The paired half of the criterion-2 mark: an explicit-timestamp
      // measure, so the devtools timeline shows input→paint spans.
      try {
        performance.measure("phasr:input-paint", {
          start: stats.lastFrameAt - sample,
          end: stats.lastFrameAt,
        });
      } catch {
        /* a clock this old is not worth throwing for */
      }
    }

    // fps over a ~500ms window of the ENGINE's own tick counter — the
    // free-running rAF chain the spec says fps must measure, not our
    // sampling loop's cadence.
    if (this.lastFpsAt === 0) {
      this.lastFpsAt = now;
      this.lastFpsTicks = stats.ticks;
    } else if (now - this.lastFpsAt >= 500) {
      this.fps = ((stats.ticks - this.lastFpsTicks) * 1000) / (now - this.lastFpsAt);
      this.lastFpsAt = now;
      this.lastFpsTicks = stats.ticks;
    }

    if (this.hud && now - this.lastHudAt >= HUD_UPDATE_MS) {
      this.lastHudAt = now;
      this.hud.update(this.snapshot());
    }
  }
}

// ---------------------------------------------------------------------------
// Registry + dev console global
// ---------------------------------------------------------------------------

const perfRegistry = new Map<string, SurfacePerf>();

export interface PerfGlobal {
  enabled(): boolean;
  /** Sets the flag; takes effect for surfaces created after a reload. */
  enable(): void;
  disable(): void;
  ids(): string[];
  snapshot(id?: string): PerfSnapshot | null;
}

declare global {
  interface Window {
    __PHASR_PERF__?: PerfGlobal;
  }
}

function installPerfGlobal(): void {
  if (typeof window === "undefined" || window.__PHASR_PERF__) return;
  window.__PHASR_PERF__ = {
    enabled: perfEnabled,
    enable: () => {
      try {
        window.localStorage.setItem(PERF_FLAG, "1");
      } catch {
        /* storage denied */
      }
      console.info("[perf] enabled — reload so surfaces pick it up");
    },
    disable: () => {
      try {
        window.localStorage.removeItem(PERF_FLAG);
      } catch {
        /* storage denied */
      }
      console.info("[perf] disabled — reload to detach");
    },
    ids: () => [...perfRegistry.keys()],
    snapshot: (id?: string) => {
      const key = id ?? [...perfRegistry.keys()][0];
      return key ? (perfRegistry.get(key)?.snapshot() ?? null) : null;
    },
  };
}

/**
 * The single entry point the backend calls. `null` in production builds
 * (compile-time) and in dev unless the flag is on — so the OFF cost in a
 * surface's hot paths is one `this.perf?` narrowing per call.
 */
export function createSurfacePerf(id: string): SurfacePerf | null {
  if (!import.meta.env.DEV) return null;
  installPerfGlobal();
  if (!perfEnabled()) return null;
  const perf = new SurfacePerf(id);
  perfRegistry.set(id, perf);
  return perf;
}
