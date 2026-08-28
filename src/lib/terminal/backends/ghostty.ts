import type {
  Ghostty,
  ITerminalOptions,
  Terminal as GhosttyTerminal,
} from "ghostty-web";
import {
  copySelectionText,
  installGhosttyClipboard,
  type GhosttyClipboardTerminal,
} from "@/lib/terminal/backends/ghostty/clipboard";
import {
  installGhosttySelection,
  type GhosttySelectionTerminal,
} from "@/lib/terminal/backends/ghostty/selection";
import {
  createGhosttyLinkProvider,
  lineToText,
  noopDisposable,
} from "@/lib/terminal/backends/ghostty/links";
import {
  createOsc8LinkProvider,
  unregisterBuiltinLinkProviders,
  type GhosttyLinkTerminal,
} from "@/lib/terminal/backends/ghostty/osc8Provider";
import {
  DEC_APPLICATION_CURSOR,
  DEC_SGR_MOUSE,
  WheelAccumulator,
  wheelOutcome,
} from "@/lib/terminal/backends/ghostty/wheel";
import { reportP0Error } from "@/lib/sentry";
import {
  diagAttach,
  diagCreate,
  diagDispose,
  diagNote,
  diagWrite,
  installTerminalDiagnostics,
  terminalDiagnosticsEnabled,
} from "@/lib/terminal/diagnostics";
import { safeWriteEnd } from "@/lib/terminal/graphemeTail";
import {
  createSurfacePerf,
  type ScrollbackBenchResult,
  type SurfacePerf,
} from "@/lib/terminal/perf";
import {
  applyChangedOptions,
  applyChangedTheme,
  buildSurfaceOptions,
  scrollbackBytes,
  type ResolvedSurfaceOptions,
} from "@/lib/terminal/options";
import {
  ALT_SCREEN_MODE,
  decModeSequence,
  modeRepairSequence,
  planResize,
  RETAINED_DEC_MODES,
} from "@/lib/terminal/reflow";
import {
  looksWrapped,
  planPrimary,
  restoreCursorSequence,
  serializeAlternate,
  type GridSnapshot,
  type SnapshotCell,
  type SnapshotRow,
} from "@/lib/terminal/serialize";
import type {
  LinkSource,
  SurfaceDisposable,
  TerminalSurface,
  TerminalSurfaceSettings,
  TerminalTheme,
} from "@/lib/terminal/surface";

/**
 * Ghostty's real VT engine (`ghostty-web@0.4.0`, MIT — Coder) behind the
 * `TerminalSurface` contract.
 *
 * `ghostty-web` is reached ONLY through the `import("ghostty-web")` below,
 * which keeps it out of the entry chunk: its ESM bundle inlines the 416 KB
 * `.wasm` as a `data:application/wasm;base64,…` URL, so
 * `dist/ghostty-web.js` is 668 KB and a static import would put all of it
 * in front of the first paint. See ADR-002.
 *
 * Everything is synchronous to the caller even though the engine is not:
 * `createTerminalSurface()` is called from a `useEffect` in three
 * components and making it async would ripple through all of them. The
 * surface therefore exists immediately with a real `element`, queues
 * whatever it is asked to do, and replays it the moment the engine lands.
 */

/**
 * One WASM instance for the whole app. `ghostty-web` keeps its own module
 * singleton behind `init()`, but this is ours and explicit: the instance
 * is passed through `ITerminalOptions.ghostty`, so N terminals share ONE
 * `WebAssembly.Memory` rather than N. That is what makes the per-terminal
 * memory number in ADR-002 (question 5) incremental growth of one heap
 * instead of a fixed per-instance cost.
 */
let enginePromise: Promise<GhosttyEngine> | null = null;

interface GhosttyEngine {
  ghostty: Ghostty;
  Terminal: typeof GhosttyTerminal;
}

export function preloadGhosttyEngine(): Promise<GhosttyEngine> {
  enginePromise ??= import("ghostty-web").then(async (mod) => {
    // No network: `Ghostty.load()` with no argument fetches the inlined
    // data: URL, so this is a compile + instantiate, not a download.
    const ghostty = await mod.Ghostty.load();
    exposeWasmProbe(ghostty);
    return { ghostty, Terminal: mod.Terminal };
  });
  return enginePromise;
}

declare global {
  interface Window {
    /** DEV-only. See `exposeWasmProbe`. */
    __PHASR_GHOSTTY__?: { wasmBytes(): number };
  }
}

/**
 * DEV-only hook for measuring WASM linear memory, gated the same way as
 * `bridge.ts` and `routes/design-test.tsx`.
 *
 * `Ghostty.memory` is `private` in the `.d.ts` and a plain own property at
 * runtime. It exists because Phase 0 question 5 ("per-terminal WASM memory
 * at scrollback: 10000") is only answerable from inside the page, and the
 * answer is load-bearing for the LRU bound in `cache.ts` — a number that
 * should be re-measurable rather than quoted from a one-off session.
 */
function exposeWasmProbe(ghostty: Ghostty): void {
  if (!import.meta.env.DEV) return;
  if (typeof window === "undefined") return;
  window.__PHASR_GHOSTTY__ = {
    wasmBytes: () => {
      const memory = (ghostty as unknown as { memory?: WebAssembly.Memory })
        .memory;
      return memory?.buffer.byteLength ?? 0;
    },
  };
}

/** Test seam — drops the memoized instance so a spec can count loads. */
export function __resetGhosttyEngine(): void {
  enginePromise = null;
}

/**
 * How long a trailing, still-extendable codepoint may be held before it is
 * written anyway. A real PTY read boundary puts the continuation in the very
 * next chunk (sub-millisecond), so this is only ever reached when the writer
 * genuinely stopped mid-cluster — at which point painting the base codepoint
 * is the correct thing to do. See `graphemeTail.ts`.
 */
const HELD_TAIL_MS = 50;

const MIN_COLS = 2;
const MIN_ROWS = 1;

/**
 * How long the container must hold still before a width change is applied.
 *
 * Both side panels animate their width over 220 ms and the `ResizeObserver`
 * fires on every frame of it, so this is what turns a gesture into ONE
 * event: one grid rebuild and — because the rebuild is where `onResize`
 * fires — one `resize_task`, in place of the thirteen a single panel toggle
 * used to send in 220 ms (ADR-002). A live window drag collapses the same
 * way, however long it lasts.
 *
 * Same number as `settle.ts`'s quiet period, for the same reason: it has to
 * outlast a dropped frame without outlasting the user's patience. Too short
 * and a stutter mid-animation buys a second rebuild; too long and the grid
 * visibly lags the pane.
 */
const REBUILD_QUIET_MS = 120;

/**
 * History rows a rebuild carries over.
 *
 * A rebuild reads the old grid cell by cell (`serialize.ts`), so unlike the
 * byte ring this replaced there is no *correctness* reason to bound it —
 * only time. Measured on the aged-session fixture, reading and re-emitting
 * costs ~15 µs a row, so 25,000 is ~375 ms in the worst case — paid only
 * when a terminal that deep gets a WIDTH change, i.e. a panel toggle or a
 * window resize, never during ordinary output.
 *
 * This is the one remaining line bound in an otherwise unlimited-scrollback
 * app, and it is a TIME bound, not a memory one: the engine happily holds
 * hundreds of thousands of rows (`scrollbackBytes`), but re-emitting them
 * synchronously through a fresh grid at ~15 µs each would read as a hang —
 * the exact failure class the 0.4.x scroll work exists to remove. A
 * rebuild that truncates says so in the console. Chunking the re-emit
 * across frames (buffering live writes through the `pendingWrites`
 * mechanism) is the known follow-up that removes this bound too.
 */
const MAX_HISTORY_ROWS = 25000;

/**
 * Attempts a single rebuild gets at constructing a writable grid.
 *
 * A create can land on pages the engine recycled from an earlier free, and
 * writing styled or grapheme-bearing content into those traps
 * (`memory access out of bounds`) — the aged-session probe pins it. The
 * identical content into virgin memory succeeds. Each failed attempt PARKS
 * the damaged grid (see `quarantinedGrids`), which keeps the poisoned
 * region occupied, so the next create is forced onto fresh memory. Two
 * attempts settle it in practice; three is margin.
 */
const MAX_REBUILD_ATTEMPTS = 3;

/**
 * Grids that trapped mid-write, held forever so their pages are never
 * recycled into a future create. Deliberately a leak: each entry is one
 * poisoned allocator region discovered at runtime, kept out of circulation
 * for the life of the page. Freeing one hands the same poison to the next
 * `createTerminal`, which is how a rebuild that "retried" used to trap
 * twice in a row deterministically.
 *
 * Unlimited scrollback raised the stakes without changing the design: a
 * deep, style-heavy carry re-emits more styled content through a fresh
 * grid, so a single width change can now spend both retry attempts and
 * park two grids where the old ~1,100-row ceiling rarely parked any
 * (e2e/terminal-aged.spec.ts, the style-saturated case, measures 6 across
 * four toggles). Still bounded per user gesture, still recovered — but a
 * reason the upstream page-recycling report matters more now.
 */
const quarantinedGrids: { free(): void }[] = [];

/**
 * The 16-byte cell struct `ghostty-web` hands back from its row accessors,
 * named locally so the reader does not import the engine for a shape.
 */
interface GhosttyCellLike {
  codepoint: number;
  fg_r: number;
  fg_g: number;
  fg_b: number;
  bg_r: number;
  bg_g: number;
  bg_b: number;
  flags: number;
  width: number;
  grapheme_len: number;
}

/**
 * The private half of ghostty-web's `Terminal` a grid swap has to touch.
 * `createTerminal` and `buildWasmConfig` are the calls `open()` itself
 * makes; reaching them from outside is what lets a rebuild construct the
 * replacement grid BEFORE freeing the one it replaces.
 */
interface GhosttyPrivateGrid {
  wasmTerm: { free(): void };
  ghostty: {
    createTerminal(cols: number, rows: number, cfg: unknown): unknown;
  };
  buildWasmConfig(): unknown;
  renderer?: { clear?(): void };
}

/** What `swapGrid` hands back so a failed rebuild can restore the world. */
interface GridSwap {
  stale: { free(): void };
  oldCols: number;
  oldRows: number;
}

/** ghostty-web reserves this much width for its own overlay scrollbar. */
const SCROLLBAR_WIDTH = 15;

/**
 * How long the render loop may go without running before a surface that is
 * supposed to be painting is declared stalled.
 *
 * A second, not a frame or two: the point is to be unambiguous. A busy
 * main thread, a long WASM write, a garbage collection — all of those skip
 * frames, and none of them skip a whole second while the page is visible
 * and the terminal is on screen. Below that, this would be a repaint
 * heuristic instead of a fault detector.
 */
const STALL_MS = 1000;

let surfaceSeq = 0;

export class GhosttySurface implements TerminalSurface {
  readonly kind = "ghostty" as const;
  readonly id: string;
  readonly element: HTMLDivElement;

  private term: GhosttyTerminal | null = null;
  private disposed = false;

  /** Everything queued while the engine was still loading. */
  private readonly pendingWrites: (string | Uint8Array)[] = [];
  private readonly pendingInput: string[] = [];
  private readonly dataCbs = new Set<(data: string) => void>();
  private readonly resizeCbs = new Set<
    (size: { rows: number; cols: number }) => void
  >();
  private pendingFocus = false;
  /** Trailing bytes a following chunk could still extend — see `write`. */
  private heldTail: Uint8Array | null = null;
  private heldTimer: number | null = null;
  /** See `diagnostics.ts` — OFF unless the user switches it on. */
  private readonly diag = terminalDiagnosticsEnabled();
  /** Phase 0 instrumentation — `null` in prod builds and in dev unless
   *  switched on, so hot paths pay one optional-chain when it is off.
   *  See `perf.ts`. */
  private perf: SurfacePerf | null = null;
  private linkSource: LinkSource | null = null;
  private keymap: ((event: KeyboardEvent) => string | null) | null = null;
  private clipboardWanted = false;
  private clipboard: SurfaceDisposable | null = null;
  private selection: SurfaceDisposable | null = null;
  private active = true;
  private pausedWarned = false;
  /** Throttles the write-path restart. See `healIfStalled`. */
  private lastKickAt = 0;
  /** Frame failures already reported. See `reportFrameErrors`. */
  private reportedFrameErrors = 0;

  /** Has this terminal been shown anything? See `fitAnchored`. */
  private written = false;
  /** Pending rebuild, waiting for the container to stop moving. */
  private rebuildTimer: number | null = null;
  /**
   * A settings change (scrollback) needs the next settled rebuild even if
   * the geometry did not move — the engine only reads `scrollback` at
   * terminal construction (`buildWasmConfig`), so applying it live IS a
   * rebuild. Cleared only when one lands, so a failed attempt's retry
   * still knows why it was asked for.
   */
  private pendingConfigRebuild = false;
  /**
   * A rebuild that could not be applied, waiting for one retry.
   *
   * Never a silent fall-back to a plain resize: that is the reflow whose
   * anchor bug started all of this, and shipping it behind a `catch` is how
   * a fixed terminal regresses without anyone noticing. See
   * `applySettledWidth`.
   */
  private rebuildRetry: number | null = null;
  private rebuildRetried = false;
  /** Where the cursor was inside the alternate screen's frame. */
  private altCursor = { x: 0, y: 0 };

  /**
   * The grid a PTY spawned before the engine attached is given. Measured
   * by `fit()` from the container and the font (exactly the way
   * ghostty-web measures it, so the engine agrees and nothing resizes);
   * 24x80 only until the first fit, i.e. only for a surface whose element
   * is not in the document yet.
   */
  private preAttachGrid = { rows: 24, cols: 80 };

  private options: ResolvedSurfaceOptions;
  /**
   * Theme diffing target. Deliberately NOT `term.options`: writing
   * `options.theme` after `open()` logs
   * "ghostty-web: theme changes after open() are not yet fully supported"
   * and does nothing (`handleOptionChange`, case "theme"). The colours go
   * straight to the renderer instead — see `applyTheme`.
   */
  private readonly themeTarget: { theme?: unknown } = {};

  constructor(settings?: Partial<TerminalSurfaceSettings>) {
    surfaceSeq += 1;
    this.id = `ghostty-${surfaceSeq}`;
    if (this.diag) {
      installTerminalDiagnostics();
      diagCreate(this.id);
    }
    this.perf = createSurfacePerf(this.id);
    this.options = buildSurfaceOptions(settings);
    this.themeTarget.theme = this.options.theme;

    this.element = document.createElement("div");
    this.element.className = "h-full w-full";

    void preloadGhosttyEngine().then(
      (engine) => this.attach(engine),
      (err) => {
        console.error("[terminal] ghostty engine failed to load", err);
      },
    );
  }

  // -------------------------------------------------------------------
  // Engine attach / replay
  // -------------------------------------------------------------------

  private attach(engine: GhosttyEngine): void {
    if (this.disposed) return;
    // Born at the grid `fit()` already measured, which is the grid the PTY
    // was spawned at. Opening at ghostty-web's 80x24 default and resizing
    // afterwards would send the process a SIGWINCH it does not need, in the
    // middle of a TUI's first paint.
    const term = new engine.Terminal({
      ...toGhosttyOptions(this.options, engine.ghostty),
      rows: this.preAttachGrid.rows,
      cols: this.preAttachGrid.cols,
    });
    this.term = term;
    if (this.diag) {
      installTerminalDiagnostics();
      diagAttach(
        this.id,
        this.options.theme as unknown as Record<string, string>,
        { ...this.preAttachGrid },
      );
    }
    // ghostty-web builds a canvas + a hidden textarea under the element it
    // is given and measures the font on a detached 2D context, so opening
    // on a still-detached element is safe — the caller re-parents
    // `element` into its mount and the first `fit()` sizes the grid.
    term.open(this.element);

    // Perf FIRST, so the criterion-2 mark is stamped before the data
    // callbacks spend time turning the bytes into an IPC call.
    if (this.perf) {
      term.onData(() => this.perf?.input());
      this.perf.attach({
        getStats: () => term.getRenderStats?.() ?? null,
        backlogBytes: () => this.backlogBytes(),
        host: this.element,
      });
    }
    for (const cb of this.dataCbs) term.onData(cb);
    for (const cb of this.resizeCbs) term.onResize(cb);

    if (this.linkSource) this.wireLinks(term, this.linkSource);
    if (this.keymap) this.wireKeymap(term, this.keymap);
    this.wireWheel(term);
    this.wireSelection(term);
    if (this.clipboardWanted && !this.clipboard) {
      this.clipboard = installGhosttyClipboard(
        this.element,
        term as unknown as GhosttyClipboardTerminal,
      );
    }

    // Through `write`, not `term.write`: the queued chunks are the same PTY
    // chunks the live path gets, and a cluster can straddle two of them.
    const queued = this.pendingWrites.splice(0, this.pendingWrites.length);
    for (const data of queued) this.write(data);
    for (const seq of this.pendingInput) term.input(seq, true);
    this.pendingInput.length = 0;

    // The grid was 80×24 while the engine loaded, which is what the PTY
    // was spawned at. Fitting here fires `onResize`, and the components'
    // resize handler turns that into `resize_task` — so the agent gets
    // the real width one round trip late rather than never.
    this.fit();
    if (this.pendingFocus) term.focus();
    this.pendingFocus = false;
    if (!this.active) this.setActive(false);
  }

  // -------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------

  get rows(): number {
    return this.term?.rows ?? this.preAttachGrid.rows;
  }

  get cols(): number {
    return this.term?.cols ?? this.preAttachGrid.cols;
  }

  /**
   * Our own fit rather than ghostty-web's `FitAddon`, which holds a 50 ms
   * `_isResizing` lockout after every resize and silently drops any fit
   * that lands inside it. phasr fits on a settle timer after a drag, which
   * is exactly the call that would get dropped.
   *
   * Works BEFORE the engine has attached, which is the whole point: all
   * three components fit synchronously and then spawn the PTY at
   * `surface.rows`/`surface.cols`, and the engine is always one microtask
   * away at best (`attach()` runs off `preloadGhosttyEngine().then`). A fit
   * that needed the engine was therefore a guaranteed no-op on the fresh
   * path, and every PTY in the app was spawned at the 24x80 fallback — see
   * `preAttachGrid`.
   */
  fit(): boolean {
    if (this.disposed) return false;
    const target = this.measureGrid();
    if (!target) return false;
    const { cols, rows } = target;

    const term = this.term;
    if (!term) {
      // No engine yet: record the measurement so `rows`/`cols` — i.e. the
      // size the PTY is spawned at — describe the real terminal. `attach()`
      // opens the engine at this grid, so nothing resizes afterwards.
      if (cols === this.preAttachGrid.cols && rows === this.preAttachGrid.rows)
        return false;
      this.preAttachGrid = { rows, cols };
      return true;
    }
    if (cols === term.cols && rows === term.rows) return false;
    // `resize` repaints in full and fires `onResize` itself.
    if (this.diag) diagNote(this.id, `resize ${cols}x${rows}`);
    term.resize(cols, rows);
    return true;
  }

  /** The grid this container currently deserves. `null` when it cannot be
   *  measured — a parked or zero-sized element, or no font metrics yet. */
  private measureGrid(): { cols: number; rows: number } | null {
    const metrics =
      this.term?.renderer?.getMetrics() ?? measureCell(this.options);
    if (!metrics || metrics.width === 0 || metrics.height === 0) return null;

    const style = window.getComputedStyle(this.element);
    const px = (v: string) => Number.parseInt(style.getPropertyValue(v)) || 0;
    const width =
      this.element.clientWidth -
      px("padding-left") -
      px("padding-right") -
      SCROLLBAR_WIDTH;
    const height =
      this.element.clientHeight - px("padding-top") - px("padding-bottom");
    if (width <= 0 || height <= 0) return null;

    return {
      cols: Math.max(MIN_COLS, Math.floor(width / metrics.width)),
      rows: Math.max(MIN_ROWS, Math.floor(height / metrics.height)),
    };
  }

  fitAnchored(): void {
    if (this.disposed) return;
    const term = this.term;
    // Nothing to protect yet: no engine means no buffer, and this
    // measurement is the one the PTY is spawned at. Deferring it would
    // reintroduce the 80x24 spawn.
    if (!term || !this.written) {
      this.fit();
      return;
    }
    const target = this.measureGrid();
    if (!target) return;

    switch (planResize({ cols: term.cols, rows: term.rows }, target)) {
      case "none":
        // A width change that came back before it settled — an open/close
        // faster than the debounce costs nothing at all.
        this.cancelWidthRebuild();
        return;
      case "resize":
        // Rows only. Nothing rewraps, so nothing drifts; and any rebuild
        // that was pending is moot, because the width it was scheduled for
        // is the width the grid already has.
        this.cancelWidthRebuild();
        this.fit();
        return;
      case "rebuild":
        this.scheduleRebuild();
    }
  }

  private scheduleRebuild(): void {
    this.cancelRebuild();
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      this.applySettledWidth();
    }, REBUILD_QUIET_MS);
  }

  private cancelRebuild(): void {
    if (this.rebuildTimer === null) return;
    window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
  }

  /**
   * Drop a rebuild that only existed to adopt a WIDTH — but never one that
   * `applySettings` scheduled to adopt a changed config (`scrollback`).
   *
   * The two arrive on the same timer, and only the width one is made moot
   * by the grid already fitting. A config rebuild is not about width at
   * all, and nothing re-arms it: cancelling it here left
   * `pendingConfigRebuild` stuck true and the new limit never applied.
   *
   * That is the common case, not a corner: the scrollback control changes
   * scrollback and nothing else, so the settings write is followed by a
   * `fitAnchored()` that plans `none` (or `resize`, if a font change moved
   * the rows) and swallowed the rebuild. It only ever appeared to work
   * because a font-size change that also moved the COLUMN count re-armed
   * the timer through the `rebuild` branch — which is exactly what the
   * Chromium spec did, and why the same spec failed under WebKit, where
   * the same font step happened not to change the column count.
   */
  private cancelWidthRebuild(): void {
    if (this.pendingConfigRebuild) return;
    this.cancelRebuild();
  }

  /** The container stopped moving. Apply what it settled on. */
  private applySettledWidth(): void {
    const term = this.term;
    if (this.disposed || !term) return;
    const target = this.measureGrid();
    // Parked, hidden, or mid-layout. The next `fitAnchored()` reschedules;
    // rebuilding against a 1px park host would collapse the grid to its
    // minimum and re-emit the whole buffer into it for nothing.
    if (!target) return;
    if (
      planResize({ cols: term.cols, rows: term.rows }, target) !== "rebuild" &&
      !this.pendingConfigRebuild
    ) {
      this.fit();
      return;
    }
    try {
      this.rebuildGrid(term, target);
      this.pendingConfigRebuild = false;
      this.cancelRebuildRetry();
    } catch (err) {
      this.rebuildFailed(err);
    }
  }

  /**
   * A rebuild threw. **Do not resize.**
   *
   * The obvious recovery — fall back to `fit()`, so the grid at least
   * matches its pane — is the bug this whole mechanism exists to avoid:
   * `ghostty_terminal_resize` on live content is the reflow whose lost
   * anchor marches the user's content down the screen (ADR-002, fourth
   * pass). Reaching for it inside a `catch` means the terminal silently
   * goes back to the broken behaviour on exactly the sessions where the
   * rebuild is hardest — the old, busy, colourful ones — and nothing in the
   * UI says so. It shipped that way, and it is why "fixed" had to be fixed
   * again.
   *
   * So the grid keeps the width it has. The visible cost is honest and
   * bounded: after a narrowing, the right-hand end of long lines is clipped
   * by the pane until the retry lands; after a widening, a strip of
   * background. One retry, a settle later, in case the failure was
   * transient — and a loud log either way, because a terminal that cannot
   * rebuild is a bug report, not a state to live in quietly.
   */
  private rebuildFailed(err: unknown): void {
    console.error(
      "[terminal] grid rebuild failed; the grid keeps its old width and will retry once",
      err,
    );
    if (this.diag) diagNote(this.id, `rebuild FAILED: ${String(err)}`);
    if (this.rebuildRetried) {
      // Already retried once and failed again. Stop: retrying a rebuild
      // against a damaged page list forever would burn the frame budget and
      // never succeed.
      console.error("[terminal] grid rebuild failed twice; giving up on this width");
      if (this.diag) diagNote(this.id, "rebuild gave up");
      return;
    }
    this.rebuildRetried = true;
    this.rebuildRetry = window.setTimeout(() => {
      this.rebuildRetry = null;
      this.scheduleRebuild();
    }, REBUILD_QUIET_MS * 4);
  }

  /** A rebuild landed, so the next failure gets its retry back. */
  private cancelRebuildRetry(): void {
    this.rebuildRetried = false;
    if (this.rebuildRetry === null) return;
    window.clearTimeout(this.rebuildRetry);
    this.rebuildRetry = null;
  }

  /**
   * Adopt a new width by building a fresh grid and re-emitting the CELLS of
   * the old one — **the fix for ADR-002's reflow anchor, and for the four
   * rounds of it.**
   *
   * Two things are load-bearing and they are separate:
   *
   * **A rebuild, not a reflow.** `ghostty_terminal_resize` rewraps a live
   * page list and, having no anchor to keep, spends the blank rows below
   * the cursor and hands them back as history above it; the content sinks a
   * row or two per width round trip and never rises. A grid constructed at
   * the right width has no blanks to spend and no history to pull down, so
   * the question never arises.
   *
   * **From cells, not from bytes.** This used to re-feed the raw PTY bytes
   * out of a 1 MiB ring, and that is wrong however carefully it is done: a
   * byte stream is only true at the width it was written for. `serialize.ts`
   * has the measurement — zsh's `PROMPT_EOL_MARK` alone leaves a stranded
   * reverse-video `%` and eats a row *per prompt* when its
   * `COLUMNS-1`-spaces erase is replayed narrower, which is exactly what
   * the user kept recording. Reading the grid instead means what comes back
   * is what was on the screen, at any width, from a terminal of any age.
   *
   * No rewrap runs at all, not even a discarded one: the replacement grid
   * is BORN at the target geometry (`swapGrid`), so `ghostty_terminal_resize`
   * — the defect all six passes of ADR-002 orbit — is never entered.
   */
  private rebuildGrid(
    term: GhosttyTerminal,
    target: { cols: number; rows: number },
  ): void {
    // A grapheme continuation still being held is part of the stream, and
    // the grid has to have seen it before the grid is read.
    this.flushHeldTail();
    const startedAt = import.meta.env.DEV ? performance.now() : 0;

    const wanted = this.readModes(term);
    const offset = Math.max(0, Math.floor(term.getViewportY()));

    // Selection coordinates are absolute buffer rows and mean nothing
    // across a rebuild.
    try {
      term.clearSelection();
    } catch {
      /* nothing selected */
    }

    // READ EVERYTHING FIRST. Past this point the old grid is gone, and a
    // throw before it is a rebuild that never started — `applySettledWidth`
    // leaves the terminal exactly as it was.
    const alternate = this.snapshotAlternate(term);
    // Leaving the alternate screen restores the primary underneath it,
    // which is the only way to read the shell's scrollback while a TUI is
    // running. Safe to do to a grid that is about to be freed.
    if (alternate) term.write(decModeSequence(ALT_SCREEN_MODE, false));
    const primary = this.snapshotPrimary(term);
    const plan = planPrimary(primary);
    if (this.diag)
      diagNote(
        this.id,
        `rebuild ${target.cols}x${target.rows} (${primary.history.length}h+${primary.screen.length}s${alternate ? "+alt" : ""})`,
      );


    // The transaction, with attempts: build the replacement, write into
    // it, and only then retire the old grid. A trap parks the damaged
    // replacement (its pages are allocator poison — see
    // `quarantinedGrids`) and tries again on memory that parked grid now
    // blocks; the old grid is untouched until `finishSwap`, so every
    // failure path still has the user's terminal, intact, at its old
    // width.
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_REBUILD_ATTEMPTS; attempt++) {
      const swap = this.swapGrid(term, target);
      try {
        // Straight to the engine. Nothing synthetic is ever retained, because
        // nothing is retained at all any more.
        let mark: { x: number; y: number; scrollback: number } | null = null;
        for (let i = 0; i < plan.segments.length; i++) {
          const segment = plan.segments[i];
          // 512-byte chunks — the write shape every probe run validated. One
          // oversized write into a fresh grid has never been exercised, and
          // this path has earned its paranoia.
          if (segment)
            for (let o = 0; o < segment.length; o += 512)
              term.write(segment.slice(o, o + 512));
          // The emulator has just wrapped everything above the cursor at the
          // NEW width, so asking it where the cursor ended up is the one
          // measurement guaranteed to agree with the grid. Computing the row
          // here instead would mean re-deriving its wrap arithmetic, which is
          // the mistake this whole file is a reaction to.
          if (i === plan.cursorAfter) mark = this.readCursor(term);
        }
        if (mark) {
          const now = this.readCursor(term);
          const scrolled = now.scrollback - mark.scrollback;
          term.write(
            restoreCursorSequence(Math.max(0, now.y - (mark.y - scrolled)), mark.x),
          );
        }

        // The re-emitted stream carries no mode bytes at all, so every mode the
        // program set is restored here rather than "usually by the replay".
        // 1049 leads `RETAINED_DEC_MODES`, so this is also what re-enters the
        // alternate screen — and entering it clears it, which is why the frame
        // goes in afterwards.
        // Land the viewport BEFORE the mode repair can re-enter the
        // alternate screen: `?1049h` snapshots the primary viewport to
        // restore when the program exits, and a snapshot taken mid-history
        // hands the user a scrolled primary the moment the TUI quits.
        // (`Terminal.reset()` used to land this as a side effect; a grid
        // swap has to do it deliberately.)
        term.scrollToBottom();
        if (offset > 0) term.scrollToLine(offset);

        const repair = modeRepairSequence(wanted, this.readModes(term));
        if (repair) term.write(repair);
        if (alternate) {
          term.write(serializeAlternate(alternate, target.cols));
          // The frame is a rectangle and was written as one, so the cursor's
          // row is a plain count back from the last row drawn.
          term.write(
            restoreCursorSequence(
              Math.max(0, alternate.length - 1 - this.altCursor.y),
              Math.min(this.altCursor.x, Math.max(0, target.cols - 1)),
            ),
          );
        }
        this.finishSwap(swap);
        lastErr = null;
      } catch (err) {
        lastErr = err;
        this.parkDamagedGrid(term, swap);
        console.warn(
          `[terminal] rebuild attempt ${attempt}/${MAX_REBUILD_ATTEMPTS} trapped; damaged grid quarantined (${quarantinedGrids.length} total)`,
        );
        if (this.diag)
          diagNote(this.id, `rebuild attempt ${attempt} trapped: ${String(err)}`);
        continue;
      }
      break;
    }
    if (lastErr) {
      // The snapshot took the OLD grid out of the alternate screen to read
      // the primary under it. Going back in hands the TUI a blank frame,
      // which it repaints on its next output — better than leaving the
      // shell's scrollback where a full-screen program was.
      if (alternate) term.write(decModeSequence(ALT_SCREEN_MODE, true));
      throw lastErr;
    }

    this.repaint();
    // DEV-only, and gated the same way as `bridge.ts`: a rebuild lands
    // inside a user's gesture, so how long it takes is a number a spec has
    // to be able to assert rather than a number this file gets to claim.
    if (import.meta.env.DEV)
      performance.measure("phasr:terminal-rebuild", { start: startedAt });
  }

  /** Cursor position, plus the history depth it is relative to. */
  private readCursor(term: GhosttyTerminal): {
    x: number;
    y: number;
    scrollback: number;
  } {
    const wasm = term.wasmTerm;
    if (!wasm) return { x: 0, y: 0, scrollback: 0 };
    const cursor = wasm.getCursor();
    return {
      x: cursor.x,
      y: cursor.y,
      scrollback: wasm.getScrollbackLength(),
    };
  }

  /**
   * One engine cell → one `SnapshotCell`.
   *
   * `bg` of pure black is the engine's own encoding of "default background"
   * — its renderer skips the fill entirely for `(0,0,0)` — so it maps back
   * to `null` and is emitted as SGR 49, not as an explicit black. `fg` gets
   * the same treatment against the palette's default foreground, so
   * ordinary text stays ordinary text and follows a later theme change.
   *
   * `wide` is the previous cell's business: the right-hand half of a
   * double-width character is a cell of its own that must occupy a column
   * and emit nothing. Deriving it from the character before it is exact,
   * where reading the spacer's own `width`/`codepoint` would depend on how
   * the engine encodes an untouched cell.
   */
  private toSnapshotCell(
    cell: GhosttyCellLike,
    afterWide: boolean,
    defaultFg: { r: number; g: number; b: number },
  ): SnapshotCell {
    const fg = { r: cell.fg_r, g: cell.fg_g, b: cell.fg_b };
    const bg = { r: cell.bg_r, g: cell.bg_g, b: cell.bg_b };
    return {
      text: afterWide ? "" : String.fromCodePoint(cell.codepoint || 32),
      fg:
        fg.r === defaultFg.r && fg.g === defaultFg.g && fg.b === defaultFg.b
          ? null
          : fg,
      bg: bg.r === 0 && bg.g === 0 && bg.b === 0 ? null : bg,
      flags: cell.flags,
    };
  }

  private rowFromCells(
    cells: readonly GhosttyCellLike[],
    graphemeAt: ((col: number) => string) | null,
    defaultFg: { r: number; g: number; b: number },
    wrapped: boolean,
  ): SnapshotRow {
    const out: SnapshotCell[] = [];
    let afterWide = false;
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]!;
      const snapshot = this.toSnapshotCell(cell, afterWide, defaultFg);
      // Combining marks, emoji ZWJ sequences, anything the engine folded
      // into one cell: the codepoint alone would drop everything after the
      // base character.
      if (!afterWide && cell.grapheme_len > 0 && graphemeAt) {
        const cluster = graphemeAt(c);
        if (cluster) snapshot.text = cluster;
      }
      out.push(snapshot);
      afterWide = !afterWide && cell.width === 2;
    }
    return { cells: out, wrapped };
  }

  /** The alternate screen's frame, or `null` if the terminal is not on it. */
  private snapshotAlternate(term: GhosttyTerminal): SnapshotRow[] | null {
    const wasm = term.wasmTerm;
    if (!wasm || !wasm.isAlternateScreen()) return null;
    const defaultFg = wasm.getColors().foreground;
    const cursor = wasm.getCursor();
    this.altCursor = { x: cursor.x, y: cursor.y };
    const rows: SnapshotRow[] = [];
    for (let r = 0; r < term.rows; r++) {
      const cells = wasm.getLine(r);
      if (!cells) break;
      rows.push(
        this.rowFromCells(
          cells,
          (c) => wasm.getGraphemeString(r, c),
          defaultFg,
          // A frame is a rectangle: no row of it continues into the next.
          false,
        ),
      );
    }
    return rows;
  }

  /**
   * The primary screen and its history.
   *
   * Independent of where the user has scrolled to: `viewportY` is a
   * JS-side offset the RENDERER composes with, and the WASM terminal is
   * always at the live bottom — `getLine(r)` is active-screen row `r` and
   * `getScrollbackLine(i)` is history line `i`, whatever the scrollbar says.
   */
  private snapshotPrimary(term: GhosttyTerminal): GridSnapshot {
    const wasm = term.wasmTerm;
    if (!wasm) return { history: [], screen: [], cursor: { x: 0, y: 0 } };
    const defaultFg = wasm.getColors().foreground;
    const cols = term.cols;

    const total = wasm.getScrollbackLength();
    // The engine's `scrollbackLimit` is a budget in BYTES (it forwards to
    // ghostty's byte-denominated `max_scrollback`), which `scrollbackBytes`
    // now feeds correctly — the old "the engine ignores the setting"
    // reading here was this codebase measuring line counts against a byte
    // field: 60 and 5,000 bytes both floor to the allocator's minimum
    // pages, ~1,100 full rows. A finite LINE limit is still enforced at
    // the one place phasr controls, the rebuild; `UNLIMITED_SCROLLBACK`
    // (0) means only the rebuild's own time bound applies.
    const limit =
      this.options.scrollback > 0
        ? Math.floor(this.options.scrollback)
        : Number.POSITIVE_INFINITY;
    const keep = Math.min(MAX_HISTORY_ROWS, limit);
    const first = Math.max(0, total - keep);
    if (first > 0)
      console.info(
        `[terminal] rebuild carrying the last ${total - first} of ${total} history rows ` +
          `(bounded by ${keep === MAX_HISTORY_ROWS ? "the rebuild time budget" : "the scrollback setting"})`,
      );
    const history: SnapshotRow[] = [];
    // `wrapped` is LEADING — a row continues the one above — and
    // ghostty-web 0.4.0 cannot say for history rows (`IBuffer.getLine`
    // hardcodes `isWrapped: false`; the WASM exports no scrollback wrap
    // flag either — checked, all 14 `ghostty_terminal_*` exports), so it
    // is inferred: this row is a continuation when the PREVIOUS row was
    // written out to its last column. The false positive — a line exactly
    // the terminal's width, followed by an independent line — is
    // irreducible at this engine version; both directions of guessing and
    // the no-guess alternative were measured, and this one loses least
    // (see the two `test.fail` cases in terminal-reflow-anchor.spec.ts).
    let prevFull = false;
    for (let i = first; i < total; i++) {
      const cells = wasm.getScrollbackLine(i);
      if (!cells) continue;
      const row = this.rowFromCells(
        cells,
        (c) => wasm.getScrollbackGraphemeString(i, c),
        defaultFg,
        false,
      );
      history.push({ ...row, wrapped: i > first && prevFull });
      prevFull = looksWrapped(row, cols);
    }

    const screen: SnapshotRow[] = [];
    for (let r = 0; r < term.rows; r++) {
      const cells = wasm.getLine(r);
      if (!cells) break;
      screen.push(
        this.rowFromCells(
          cells,
          (c) => wasm.getGraphemeString(r, c),
          defaultFg,
          // The active screen DOES carry real wrap flags — LEADING
          // semantics (this row continues the one above), whatever the
          // engine's JSDoc says. Row 0 has nothing to continue; a screen-
          // top continuation of a history row is treated as a start, which
          // the history heuristic compensates for from its side.
          r > 0 && wasm.isRowWrapped(r),
        ),
      );
    }

    const cursor = wasm.getCursor();
    return {
      history,
      screen,
      cursor: {
        x: Math.max(0, cursor.x),
        y: Math.max(0, Math.min(cursor.y, Math.max(0, screen.length - 1))),
      },
    };
  }

  /**
   * Put the terminal on a fresh, empty grid of `target` — **resize first,
   * reset second, and never the other way round.**
   *
   * The obvious order is the other one, and it is what this did until a
   * user's terminal started blanking on every panel toggle: free the
   * buffer, then resize the empty grid, so the rewrap has nothing to
   * spend. It crashes. `ghostty_terminal_write` traps with
   * `RuntimeError: memory access out of bounds` part-way through the
   * replay; the rebuild aborts into its fallback and the user keeps
   * whatever landed before the trap. Measured in a browser against the
   * real app: SIX of six narrowing toggles failed, each one cutting the
   * retained history from 692 lines to 435, and with a more colourful
   * screen the page list came back damaged enough that `getLine` traps
   * too — so the renderer draws nothing and the terminal is simply empty
   * until the panel is closed again. That is the recording.
   *
   * The bug is ghostty-web 0.4.0's, and it is not about resizing. It is
   * about page memory allocated for one grid geometry being recycled for
   * another; a style table then runs off the end of the buffer it was
   * given. Two shapes of it are reachable from here, both bisected:
   *
   *   1. free a terminal that has been written to, then create a NARROWER
   *      one on the same WASM instance — a handful of SGR colours in the
   *      next 35 KB is enough to trap. This is what `reset()` before
   *      `resize()` does, every time a panel opens.
   *   2. resize a terminal that already holds a lot of styled content,
   *      then keep writing to it. Either direction, and it needs far more
   *      style variety — around 100 distinct SGR styles in a screenful.
   *
   * Resizing before the reset is the order that walks between them. The
   * resize lands on the live buffer, which is shape 2 — and then that
   * buffer is thrown away microseconds later, unread, so nothing is ever
   * written to the terminal it damaged. The free that follows hands back
   * pages that are ALREADY the target's width, so shape 1 never holds.
   * And the grid the replay actually lands in was created at the target
   * geometry and is never resized at all, which is the only state this
   * engine is reliably happy in.
   *
   * The cost is the rewrap the previous order existed to skip, now run
   * against live content and immediately discarded: 10-13 ms of a 16-26 ms
   * rebuild. Nothing about the anchor changes — the rewrapped buffer is
   * never looked at.
   *
   * Not a general cure. Shape 2 is reachable from a PLAIN resize with no
   * rebuild anywhere near it (`fit()` still resizes for a rows-only
   * change), so a screen with a few hundred distinct styles in it can
   * still break this engine. What this ordering removes is the shape
   * phasr was walking into on every single toggle, at every ordinary
   * level of colour. Twelve toggles across four fixtures — 7 to 32 styles,
   * 400 to 1200 lines — now return the scrollback to the same line count
   * every round trip, with nothing logged.
   *
   * Also, therefore, the ONE place a rebuild may call `resize`: it fires
   * `onResize` exactly once, which is the single `resize_task` a whole
   * panel toggle is allowed.
   */

  /**
   * Build the replacement grid BEFORE freeing the old one, and never call
   * `ghostty_terminal_resize` at all.
   *
   * The aged-session probe pinned the third shape of the engine's
   * page-memory defect: a grid created on just-recycled pages traps
   * (`memory access out of bounds`) part-way through having styled and
   * grapheme-bearing content written into it — the very content a rebuild
   * re-emits. The identical bytes into a live, never-recycled grid are
   * harmless. So the replacement is created while the old grid still owns
   * its pages, forcing the allocator to hand it fresh memory; the old grid
   * is freed only after the replacement holds everything.
   *
   * This also makes the rebuild a transaction. Every read happens before
   * the swap; every write lands in the new grid; the old grid is not
   * touched between the two. A trap mid-write leaves the OLD grid intact,
   * so `rollbackGrid` can put it back — which is what killed the 22-second
   * retry that used to snapshot a damaged page list, and the history it
   * used to lose doing so.
   */
  private swapGrid(
    term: GhosttyTerminal,
    target: { cols: number; rows: number },
  ): GridSwap {
    const t = term as unknown as GhosttyPrivateGrid;
    const swap: GridSwap = {
      stale: t.wasmTerm,
      oldCols: term.cols,
      oldRows: term.rows,
    };
    t.wasmTerm = t.ghostty.createTerminal(
      target.cols,
      target.rows,
      t.buildWasmConfig(),
    ) as GhosttyPrivateGrid["wasmTerm"];
    t.renderer?.clear?.();
    // The engine half of resize() finds wasmTerm already at the target and
    // early-returns; what still runs is the canvas, the renderer metrics
    // and the single onResize the PTY resize rides on.
    term.resize(target.cols, target.rows);
    term.viewportY = 0;
    return swap;
  }

  /**
   * A write into the replacement grid trapped. The old grid was never
   * touched, so put it back — and PARK the damaged grid rather than free
   * it: its pages are the poison, and freeing them re-arms the next
   * create. See `quarantinedGrids`.
   */
  private parkDamagedGrid(term: GhosttyTerminal, swap: GridSwap): void {
    const t = term as unknown as GhosttyPrivateGrid;
    quarantinedGrids.push(t.wasmTerm);
    t.wasmTerm = swap.stale;
    t.renderer?.clear?.();
    term.resize(swap.oldCols, swap.oldRows);
    term.viewportY = 0;
  }

  /**
   * The replacement holds everything; retire the old grid. Its scrollback
   * is erased first (`ED 3` — plain VT, no engine entry point), so the
   * engine walks its pages back page by page before the bulk free — the
   * free of a written grid is what seeds the recycled-page poison, and an
   * emptied grid has far less to seed with.
   */
  private finishSwap(swap: GridSwap): void {
    const stale = swap.stale as {
      free(): void;
      write?(data: string): void;
    };
    try {
      stale.write?.("\x1b[?1049l\x1b[0m\x1b[2J\x1b[3J\x1b[H");
    } catch {
      /* about to be freed regardless */
    }
    try {
      stale.free();
    } catch {
      /* a leak, not a correctness problem */
    }
  }

  /** The DEC private modes a rebuild has to carry over. See `reflow.ts`. */
  private readModes(term: GhosttyTerminal): Map<number, boolean> {
    const modes = new Map<number, boolean>();
    const wasmTerm = term.wasmTerm;
    if (!wasmTerm) return modes;
    for (const mode of RETAINED_DEC_MODES) {
      modes.set(mode, wasmTerm.getMode(mode, false));
    }
    return modes;
  }

  repaint(): void {
    if (this.disposed) return;
    const term = this.term;
    if (!term?.renderer || !term.wasmTerm) return;
    try {
      // Canvas 2D keeps its backing store across a re-parent (unlike a
      // WebGL context, which is why the previous backend had to clear its
      // texture atlas here), so this only really matters while the render
      // loop is paused. Scrollbar opacity 0: the free-running loop
      // owns the fade, and a one-shot repaint must not flash it visible.
      term.renderer.render(term.wasmTerm, true, term.getViewportY(), term, 0);
    } catch {
      /* layout settling */
    }
  }

  /**
   * ghostty-web runs an unconditional `requestAnimationFrame` loop from
   * `open()` to `dispose()` — every terminal repaints every frame forever,
   * including the ones parked offscreen. `pause()`/`resume()` come from
   * `patches/ghostty-web@0.4.0.patch`; the feature test keeps the backend
   * working (just hotter) if that patch is ever dropped.
   */
  setActive(active: boolean): void {
    this.active = active;
    if (this.disposed) return;
    this.perf?.setActive(active);
    const term = this.term;
    // No engine yet is not a missing patch — it is the ordinary state of a
    // surface whose chunk has not resolved, and `attach()` re-applies the
    // flag. Warning here spent the one-shot `pausedWarned` on a non-event,
    // so a genuinely unpatched build then went quiet for the rest of the
    // session.
    if (!term) return;
    // Runtime-guarded even though the patched `.d.ts` declares both: an
    // unapplied patch must degrade to "hot but correct", not to a crash.
    if (typeof term.pause !== "function" || typeof term.resume !== "function") {
      if (!this.pausedWarned) {
        this.pausedWarned = true;
        console.warn(
          "[terminal] ghostty-web has no pause()/resume() — parked terminals will keep rendering. Is patches/ghostty-web@0.4.0.patch applied?",
        );
      }
      return;
    }
    if (active) {
      term.resume();
      this.repaint();
    } else {
      term.pause();
    }
  }

  /**
   * A render that threw used to reach Sentry on its own: the loop had no
   * `catch`, so the exception escaped through `requestAnimationFrame`,
   * which Sentry's `browserApiErrors` integration wraps. Wrapping the loop
   * body — which is what stops one bad frame ending the terminal — closes
   * that path, so the report has to be made deliberately or the fix would
   * have bought a live terminal with a blind one.
   *
   * Once per surface: a renderer that fails every frame is one fault, not
   * sixty a second, and the count says how bad it got.
   */
  private reportFrameErrors(count: number, error: unknown): void {
    if (count <= this.reportedFrameErrors) return;
    const first = this.reportedFrameErrors === 0;
    this.reportedFrameErrors = count;
    if (this.diag) diagNote(this.id, `render frame threw (${count} total)`);
    if (!first) return;
    reportP0Error(
      `[terminal] ${this.id}: a render frame threw; the loop survived it`,
      error,
      { area: "terminal", operation: "render-frame", surfaceId: this.id },
    );
  }

  /**
   * Frames the loop has run, or `null` when this surface is not supposed
   * to be painting. See `TerminalSurface.renderTick` and
   * `lib/terminal/liveness.ts`.
   *
   * `getRenderStats` comes from the patch, so it is feature-tested like
   * `pause`/`resume`: an unpatched engine reports "not measurable" rather
   * than crashing the watchdog, and the watchdog then leaves it alone.
   */
  renderTick(): number | null {
    if (this.disposed || !this.active) return null;
    const stats = this.term?.getRenderStats?.();
    if (!stats || stats.paused || !stats.open || stats.disposed) return null;
    return stats.ticks;
  }

  kickRendering(): void {
    if (this.disposed || !this.active) return;
    const term = this.term;
    if (typeof term?.resume !== "function") return;
    this.lastKickAt = performance.now();
    try {
      // pause() first, for two reasons: it cancels a frame that is queued
      // but will never be delivered (the suspended-web-view case, where
      // the id is live and the callback is gone), and it makes the restart
      // hold even against the pre-fix `resume()` semantics, which
      // early-returned unless the terminal had been paused.
      term.pause?.();
      term.resume();
    } catch (err) {
      console.error(`[terminal] ${this.id}: could not restart the render loop`, err);
      return;
    }
    // The loop paints on its NEXT frame; this is what puts the current
    // buffer on screen now, and the only thing that helps at all if
    // animation frames have stopped app-wide.
    this.repaint();
    if (this.diag) diagNote(this.id, "render loop restarted");
  }

  /**
   * New output has arrived. If the loop has demonstrably not run for a
   * second while this surface was supposed to be painting, it is not
   * going to run again on its own — restart it, or the bytes just written
   * are invisible for the rest of the terminal's life.
   *
   * This is the arm of the watchdog that needs no user and no event: an
   * agent working while nobody is looking heals its own terminal. It costs
   * one property read and one subtraction per PTY chunk, and reaches
   * `kickRendering` only when something is actually wrong.
   */
  private healIfStalled(): void {
    if (!this.active || this.disposed) return;
    const stats = this.term?.getRenderStats?.();
    if (!stats) return;
    this.reportFrameErrors(stats.frameErrors, stats.lastFrameError);
    if (stats.paused || !stats.open || stats.disposed) return;
    // Never rendered at all yet: the first frame is still on its way.
    if (!stats.lastFrameAt) return;
    const now = performance.now();
    if (now - stats.lastFrameAt < STALL_MS) return;
    // A hidden page stops delivering frames legitimately, and a burst of
    // output would otherwise kick once per chunk for as long as it stays
    // hidden. The watchdog's `visible` trigger covers the way back.
    if (typeof document !== "undefined" && document.visibilityState !== "visible")
      return;
    if (now - this.lastKickAt < STALL_MS) return;
    console.warn(
      `[terminal] ${this.id}: no frame in ${Math.round(now - stats.lastFrameAt)}ms ` +
        "while output was arriving — restarting the render loop",
    );
    this.kickRendering();
  }

  // -------------------------------------------------------------------
  // I/O
  // -------------------------------------------------------------------

  write(data: string | Uint8Array): void {
    if (this.disposed) return;
    if (this.diag) diagWrite(this.id, data);
    this.perf?.output(data.length);
    if (!this.term) {
      this.pendingWrites.push(data);
      return;
    }
    // Output arriving into a terminal whose loop stopped is the one signal
    // that needs no user present. See `healIfStalled`.
    this.healIfStalled();
    // Literal strings come from phasr itself (status lines, log replay), not
    // from a PTY, so they are never a partial cluster.
    if (typeof data === "string") {
      this.flushHeldTail();
      this.writeToEngine(data);
      return;
    }

    let bytes = data;
    if (this.heldTail) {
      const merged = new Uint8Array(this.heldTail.length + bytes.length);
      merged.set(this.heldTail);
      merged.set(bytes, this.heldTail.length);
      bytes = merged;
      this.heldTail = null;
    }
    this.clearHeldTimer();

    const end = safeWriteEnd(bytes);
    if (end > 0) this.writeToEngine(bytes.subarray(0, end));
    if (end < bytes.length) {
      // `slice` (a copy), not `subarray`: the caller owns `data`'s buffer.
      this.heldTail = bytes.slice(end);
      this.heldTimer = window.setTimeout(() => {
        this.heldTimer = null;
        this.flushHeldTail();
      }, HELD_TAIL_MS);
    }
  }

  /**
   * Bytes accepted by `write()` and not yet parsed by the engine — the
   * "parse backlog" the perf HUD shows. The engine itself parses
   * synchronously inside `term.write`, so the only queues are ours: the
   * pre-attach `pendingWrites` and the held grapheme tail. Nonzero after
   * attach therefore means bytes are genuinely waiting.
   */
  private backlogBytes(): number {
    let sum = this.heldTail?.length ?? 0;
    for (const data of this.pendingWrites) sum += data.length;
    return sum;
  }

  /** Write whatever is being held, now. */
  private flushHeldTail(): void {
    this.clearHeldTimer();
    const tail = this.heldTail;
    this.heldTail = null;
    if (tail && tail.length > 0) this.writeToEngine(tail);
  }

  /**
   * The ONE place PTY bytes reach the emulator.
   *
   * It used to also retain them, in a 1 MiB ring, so a width change could
   * re-feed them into a fresh grid. It does not any more, and the deletion
   * is the fix rather than a tidy-up: bytes are only true at the width they
   * were written for, so re-feeding a four-day-old stream into a narrower
   * grid resurrects erased characters and moves the content down the screen
   * (`serialize.ts` has the measurement). A rebuild reads the CELLS now, so
   * there is nothing to keep — and 1 MiB per terminal, 8 MiB at the LRU
   * bound, stops being held for it.
   */
  private writeToEngine(data: string | Uint8Array): void {
    const term = this.term;
    // Before the engine lands, `write()` queues into `pendingWrites` and
    // replays through here on attach.
    if (!term) return;
    this.written = true;
    term.write(data);
  }

  private clearHeldTimer(): void {
    if (this.heldTimer !== null) {
      window.clearTimeout(this.heldTimer);
      this.heldTimer = null;
    }
  }

  input(seq: string): void {
    if (this.disposed) return;
    if (!this.term) {
      this.pendingInput.push(seq);
      return;
    }
    // `wasUserInput` MUST be true. ghostty-web's `input()` defaults to
    // false, which *writes the bytes into the screen* instead of firing
    // `onData` — every keymap chord would paint itself into the terminal
    // and never reach the PTY.
    this.term.input(seq, true);
  }

  onData(cb: (data: string) => void): SurfaceDisposable {
    this.dataCbs.add(cb);
    const live = this.term?.onData(cb);
    return {
      dispose: () => {
        this.dataCbs.delete(cb);
        live?.dispose();
      },
    };
  }

  onResize(
    cb: (size: { rows: number; cols: number }) => void,
  ): SurfaceDisposable {
    this.resizeCbs.add(cb);
    const live = this.term?.onResize(cb);
    return {
      dispose: () => {
        this.resizeCbs.delete(cb);
        live?.dispose();
      },
    };
  }

  focus(): void {
    if (this.disposed) return;
    if (!this.term) {
      this.pendingFocus = true;
      return;
    }
    this.term.focus();
  }

  // -------------------------------------------------------------------
  // Settings / theme
  // -------------------------------------------------------------------

  applySettings(settings: Partial<TerminalSurfaceSettings> | undefined): void {
    if (this.disposed) return;
    const next = buildSurfaceOptions(settings);
    this.options = next;
    if (!this.term) return;
    // Same diffing discipline the previous backend needed, for a different
    // mechanism: a `fontSize` write runs `handleFontChange()` (canvas
    // resize + full re-render) and `fontFamily` re-runs `measureFont()`.
    const written = applyChangedOptions(this.term.options, next);
    // `scrollback` is in the options bag but the engine only reads it at
    // terminal construction (`buildWasmConfig`) — `handleOptionChange` has
    // no case for it. A rebuild constructs a fresh terminal through that
    // config, so a changed limit is applied by scheduling one: same-width,
    // settle-debounced, transaction-protected. This restores the live
    // behaviour the previous engine had.
    // Gated on `written`: at boot the resolved settings replace the
    // construction defaults (10000 → the user's value) before any output
    // exists, and an empty terminal has nothing to truncate — while every
    // later rebuild reads the CURRENT setting at snapshot time regardless.
    // Only a live change to a terminal that already holds content needs a
    // rebuild of its own.
    if (written.includes("scrollback") && this.written) {
      this.pendingConfigRebuild = true;
      this.scheduleRebuild();
    }
    // `cursorStyle`/`cursorBlink` DO reach the renderer (unlike `scrollback`
    // and `theme`), but only as state: `setCursorStyle` just assigns, and
    // the render loop redraws the cursor's ROW only when the cursor moved
    // or is blinking. With blink off, switching block → bar left the old
    // block painted until the next byte of output. One full repaint settles
    // it. Font changes repaint themselves (`handleFontChange`).
    if (written.includes("cursorStyle") || written.includes("cursorBlink"))
      this.repaint();
  }

  applyTheme(theme: TerminalTheme): void {
    if (this.disposed) return;
    if (!applyChangedTheme(this.themeTarget, theme)) return;
    const renderer = this.term?.renderer;
    if (!renderer || !this.term?.wasmTerm) return;
    renderer.setTheme(theme);
    // setTheme only swaps the palette; nothing redraws until something
    // marks a row dirty, so a flip on an idle terminal would land only on
    // the next byte of output without this.
    renderer.render(this.term.wasmTerm, true, this.term.getViewportY(), this.term, 0);
  }

  // -------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------

  /** @param row 0-based absolute buffer row (scrollback included). */
  readLine(row: number): string | null {
    if (this.disposed || !this.term) return null;
    const line = this.term.buffer.active.getLine(row);
    return line ? lineToText(line).trimEnd() : null;
  }

  readViewport(): { offset: number; scrollback: number } {
    const term = this.term;
    if (this.disposed || !term) return { offset: 0, scrollback: 0 };
    // `getViewportY()` is fractional mid-smooth-scroll; the renderer floors
    // it before using it as a row offset, so report what the renderer sees.
    return {
      offset: Math.max(0, Math.floor(term.getViewportY())),
      scrollback: term.getScrollbackLength(),
    };
  }

  /**
   * The Phase 0 `getScrollbackLine` throughput microbench (spec criterion
   * 7, architect Q5) — F4's build-vs-patch decision is made against these
   * numbers. DEV-bridge-only; never called by shipped code.
   *
   * Two passes over the same sampled offsets:
   *
   *   - **fetch-only**: `getScrollbackLine` plus a cell walk — the floor
   *     for anything that reads history out of the engine.
   *   - **fetch + graphemes**: the same fetch plus text assembly with
   *     `getScrollbackGraphemeString` for cluster-bearing cells — what F4
   *     actually needs for correct match spans, per the spec: "the cheaper
   *     number alone would flatter it".
   *
   * A WASM/JS call that never crosses the IPC boundary, which is why this
   * lives here and in the e2e probe rather than in `perfbench.rs`.
   */
  benchScrollback(samples: number): ScrollbackBenchResult | null {
    const wasm = this.term?.wasmTerm;
    if (!wasm) return null;
    const depth = wasm.getScrollbackLength();
    if (depth <= 0) return null;
    const sampled = Math.max(1, Math.min(Math.floor(samples), depth));
    const stride = depth / sampled;

    // Untimed warm-up over both call shapes: without it the first timed
    // pass pays the JIT/wasm-boundary warm-up for both, and the second
    // pass measures FASTER than the strictly-cheaper first one did.
    for (let i = 0; i < Math.min(256, depth); i++) {
      const line = wasm.getScrollbackLine(i);
      if (!line) continue;
      for (let c = 0; c < line.length; c++) {
        if ((line[c] as GhosttyCellLike).grapheme_len > 0)
          wasm.getScrollbackGraphemeString(i, c);
      }
    }

    let cells = 0;
    const t0 = performance.now();
    for (let i = 0; i < sampled; i++) {
      const line = wasm.getScrollbackLine(Math.floor(i * stride));
      if (!line) continue;
      // Walk the cells so the fetch cannot be optimised away and the cost
      // includes touching what came back — the minimum any consumer does.
      for (let c = 0; c < line.length; c++) {
        if ((line[c] as GhosttyCellLike).codepoint !== 0) cells += 1;
      }
    }
    const fetchMs = performance.now() - t0;

    let chars = 0;
    const t1 = performance.now();
    for (let i = 0; i < sampled; i++) {
      const offset = Math.floor(i * stride);
      const line = wasm.getScrollbackLine(offset);
      if (!line) continue;
      let text = "";
      for (let c = 0; c < line.length; c++) {
        const cell = line[c] as GhosttyCellLike;
        if (cell.grapheme_len > 0) {
          text += wasm.getScrollbackGraphemeString(offset, c);
        } else if (cell.codepoint !== 0) {
          text += String.fromCodePoint(cell.codepoint);
        } else {
          text += " ";
        }
      }
      chars += text.length;
    }
    const graphemeMs = performance.now() - t1;

    const perLine = (ms: number) => (ms * 1000) / sampled;
    const perSec = (ms: number) => (ms > 0 ? (sampled * 1000) / ms : 0);
    return {
      depth,
      sampled,
      fetchMs,
      graphemeMs,
      fetchLinesPerSec: perSec(fetchMs),
      graphemeLinesPerSec: perSec(graphemeMs),
      fetchUsPerLine: perLine(fetchMs),
      graphemeUsPerLine: perLine(graphemeMs),
      cells,
      chars,
    };
  }

  /** @param row viewport row (0 = top visible line), not a buffer row. */
  cellRect(col: number, row: number): DOMRect | null {
    if (this.disposed) return null;
    const renderer = this.term?.renderer;
    if (!renderer) return null;
    const rect = renderer.getCanvas().getBoundingClientRect();
    const width = renderer.charWidth;
    const height = renderer.charHeight;
    if (width <= 0 || height <= 0) return null;
    return new DOMRect(
      rect.left + col * width,
      rect.top + row * height,
      width,
      height,
    );
  }

  // -------------------------------------------------------------------
  // Installables
  // -------------------------------------------------------------------

  installLinks(source: LinkSource): SurfaceDisposable {
    this.linkSource = source;
    if (this.term) this.wireLinks(this.term, source);
    // ghostty-web's `registerLinkProvider` has no unregister counterpart;
    // the providers die with the terminal, which is the only lifetime any
    // caller here uses.
    return noopDisposable();
  }

  private wireLinks(term: GhosttyTerminal, source: LinkSource): void {
    // `Terminal.open()` has already registered ITS OWN OSC8LinkProvider
    // and UrlRegexProvider, both of which call `window.open(uri)` with no
    // scheme validation on an OSC 8 target chosen by untrusted agent
    // output. There is no option to suppress them, so they are removed.
    if (!unregisterBuiltinLinkProviders(term)) {
      console.error(
        "[terminal] could not remove ghostty-web's built-in link providers — " +
          "unvalidated window.open() is still registered. Refusing to add ours.",
      );
      return;
    }
    term.registerLinkProvider(
      createOsc8LinkProvider(term as unknown as GhosttyLinkTerminal, source),
    );
    term.registerLinkProvider(
      createGhosttyLinkProvider(term as unknown as GhosttyLinkTerminal, source),
    );
  }

  installKeymap(
    map: (event: KeyboardEvent) => string | null,
  ): SurfaceDisposable {
    this.keymap = map;
    if (this.term) this.wireKeymap(this.term, map);
    return {
      dispose: () => {
        this.keymap = null;
        this.term?.attachCustomKeyEventHandler(() => false);
      },
    };
  }

  private wireKeymap(
    term: GhosttyTerminal,
    map: (event: KeyboardEvent) => string | null,
  ): void {
    term.attachCustomKeyEventHandler((event) => {
      // **INVERTED vs the usual convention.** A custom key handler
      // conventionally returns `false` to suppress the emulator's own
      // handling; ghostty-web's returns `true`
      // ("if (handler(e)) { e.preventDefault(); return; }" in
      // InputHandler.handleKeyDown). Returning the inverted value here
      // would send every chord to the PTY *and* let ghostty handle the
      // key as well — and would swallow every key the map declines.
      // Verified in e2e/terminal-keymap.spec.ts.
      if (event.type !== "keydown") return false;
      const seq = map(event);
      if (seq !== null) {
        term.input(seq, true);
        return true; // ghostty-web calls preventDefault() for us
      }
      return swallowsAppChord(event);
    });
  }

  /**
   * Replace ghostty-web's wheel handling with the conventional model.
   *
   * Stock behaviour turns every wheel tick over an alt-screen app into up
   * to five `\x1b[A`/`\x1b[B` and never reports the mouse at all — see
   * `backends/ghostty/wheel.ts` for the source it does that from and the
   * evidence about what Claude Code does with the result.
   *
   * `attachCustomWheelEventHandler` is a supported public hook and it runs
   * FIRST inside `handleWheel`, so returning `true` short-circuits the
   * whole thing; returning `false` lets ghostty-web's own (correct)
   * scrollback path run, smooth scrolling and all.
   */
  private wireWheel(term: GhosttyTerminal): void {
    const accumulator = new WheelAccumulator();
    term.attachCustomWheelEventHandler((event) => {
      const wasmTerm = term.wasmTerm;
      const renderer = term.renderer;
      if (!wasmTerm || !renderer) return false;

      const cellHeight = renderer.charHeight;
      const lines = accumulator.consume(
        event.deltaY,
        event.deltaMode,
        cellHeight,
        term.rows,
      );
      const cell = this.cellAt(event);
      const outcome = wheelOutcome({
        alternateScreen: wasmTerm.isAlternateScreen(),
        mouseTracking: wasmTerm.hasMouseTracking(),
        sgrMouse: wasmTerm.getMode(DEC_SGR_MOUSE, false),
        applicationCursor: wasmTerm.getMode(DEC_APPLICATION_CURSOR, false),
        col: cell.col,
        row: cell.row,
        lines,
        shift: event.shiftKey,
        alt: event.altKey,
        ctrl: event.ctrlKey,
      });

      if (outcome.kind === "scrollback") return false;
      if (outcome.kind === "send") term.input(outcome.seq, true);
      return true;
    });
  }

  /**
   * Double-click = word, triple-click = logical line — phasr's, not
   * ghostty-web's.
   *
   * Not an `installX()` on the surface contract for the same reason the
   * wheel isn't: it is not optional behaviour a caller chooses, it is what
   * a terminal does with a mouse. See `backends/ghostty/selection.ts` for
   * the upstream bug this replaces.
   */
  private wireSelection(term: GhosttyTerminal): void {
    this.selection = installGhosttySelection(
      this.element,
      term as unknown as GhosttySelectionTerminal,
      { copy: (text) => copySelectionText(text, term.textarea) },
    );
  }

  /** 0-based cell under a pointer event, clamped to the grid. */
  private cellAt(event: { clientX: number; clientY: number }): {
    col: number;
    row: number;
  } {
    const renderer = this.term?.renderer;
    if (!renderer) return { col: 0, row: 0 };
    const rect = renderer.getCanvas().getBoundingClientRect();
    const width = renderer.charWidth;
    const height = renderer.charHeight;
    if (width <= 0 || height <= 0) return { col: 0, row: 0 };
    const clamp = (v: number, max: number) =>
      Math.max(0, Math.min(max, Math.floor(v)));
    return {
      col: clamp((event.clientX - rect.left) / width, this.cols - 1),
      row: clamp((event.clientY - rect.top) / height, this.rows - 1),
    };
  }

  installClipboard(): SurfaceDisposable {
    this.clipboardWanted = true;
    if (this.term && !this.clipboard) {
      this.clipboard = installGhosttyClipboard(
        this.element,
        this.term as unknown as GhosttyClipboardTerminal,
      );
    }
    return {
      dispose: () => {
        this.clipboardWanted = false;
        this.clipboard?.dispose();
        this.clipboard = null;
      },
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clipboard?.dispose();
    this.clipboard = null;
    this.selection?.dispose();
    this.selection = null;
    this.dataCbs.clear();
    this.resizeCbs.clear();
    this.pendingWrites.length = 0;
    this.pendingInput.length = 0;
    this.cancelRebuild();
    this.cancelRebuildRetry();
    this.clearHeldTimer();
    this.heldTail = null;
    this.perf?.dispose();
    this.perf = null;
    if (this.diag) diagDispose(this.id);
    try {
      this.term?.dispose();
    } catch {
      /* already gone */
    }
    this.term = null;
    this.element.parentNode?.removeChild(this.element);
  }
}

/**
 * Does this ⌘-chord belong to the APP rather than to the terminal?
 *
 * The previous engine ignored meta-modified keys entirely — that is why
 * `keymap.ts` exists — so today every ⌘-chord the keymap doesn't claim
 * bubbles up to phasr's own handlers. ghostty-web does the opposite: any
 * key it can encode gets `preventDefault()` **and `stopPropagation()`**
 * (`InputHandler.handleKeyDown`), which silently kills every
 * document-level bubble-phase shortcut in the app the moment a terminal
 * has focus. ⌘K (Command Palette) is the first casualty; the menus in
 * `WorkspaceActionsMenu`, `OpenInMenu`, `SyncButton`, `RunCommandPicker`
 * and both sidebar menus listen the same way.
 *
 * Returning `true` from the custom handler stops ghostty encoding the key
 * but does NOT stop propagation (it only calls `preventDefault()`), so the
 * event still reaches those listeners — i.e. the old behaviour, restored.
 *
 * ⌘C / ⌘V / ⌘X are the exception: `preventDefault()` on their keydown
 * suppresses the browser's own clipboard action, and phasr's copy/paste
 * rides on the resulting DOM `copy`/`paste` events. ghostty-web already
 * early-returns for ⌘C/⌘V untouched; ⌘X it does not, which is why it is
 * listed here too.
 */
function swallowsAppChord(event: KeyboardEvent): boolean {
  if (!event.metaKey) return false;
  return event.code !== "KeyC" && event.code !== "KeyV" && event.code !== "KeyX";
}

/**
 * Cell size for a font, without an engine.
 *
 * A byte-for-byte port of ghostty-web's own `Renderer.measureFont()`
 * (`dist/ghostty-web.js`, "Font Metrics Measurement"). It has to be exact,
 * not merely close: `fit()` uses this before the engine attaches and the
 * engine's own metrics afterwards, and a disagreement of one pixel would
 * make the grid change the moment the engine lands — i.e. a spurious
 * SIGWINCH into a process that has just started drawing.
 *
 * Cheap enough to call per fit: one detached 2D context and one
 * `measureText("M")`, which is what the engine does on every font change.
 */
function measureCell(
  options: ResolvedSurfaceOptions,
): { width: number; height: number } | null {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;
  ctx.font = `${options.fontSize}px ${options.fontFamily}`;
  const m = ctx.measureText("M");
  const width = Math.ceil(m.width);
  const ascent = m.actualBoundingBoxAscent || options.fontSize * 0.8;
  const descent = m.actualBoundingBoxDescent || options.fontSize * 0.2;
  return { width, height: Math.ceil(ascent + descent) + 2 };
}

/** Neutral options → ghostty-web's option bag. The only mapping here. */
export function toGhosttyOptions(
  options: ResolvedSurfaceOptions,
  ghostty?: Ghostty,
): ITerminalOptions {
  return {
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    cursorBlink: options.cursorBlink,
    cursorStyle: options.cursorStyle,
    // Only applies to string writes in ghostty-web; PTY output arrives as
    // bytes and a real tty already emits CRLF, so this is belt-and-braces
    // for the few places that write literal strings.
    convertEol: options.convertEol,
    smoothScrollDuration: options.smoothScrollDuration,
    // BYTES, not lines: ghostty-web passes this verbatim into the WASM
    // config's `scrollbackLimit`, which is ghostty's byte-denominated
    // `max_scrollback`. Handing it the line count is the bug that capped
    // every terminal at ~1,100 rows of history. See `scrollbackBytes`.
    scrollback: scrollbackBytes(options.scrollback),
    theme: options.theme,
    // No `lineHeight`: ghostty-web derives the cell box from the font
    // metrics and has no such option. phasr uses 1.0, which is what its
    // metrics already produce.
    ...(ghostty ? { ghostty } : {}),
  };
}
