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
  applyChangedOptions,
  applyChangedTheme,
  buildSurfaceOptions,
  type ResolvedSurfaceOptions,
} from "@/lib/terminal/options";
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
/** ghostty-web reserves this much width for its own overlay scrollbar. */
const SCROLLBAR_WIDTH = 15;

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
  private linkSource: LinkSource | null = null;
  private keymap: ((event: KeyboardEvent) => string | null) | null = null;
  private clipboardWanted = false;
  private clipboard: SurfaceDisposable | null = null;
  private selection: SurfaceDisposable | null = null;
  private active = true;
  private pausedWarned = false;

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
    const metrics = this.term?.renderer?.getMetrics() ?? measureCell(this.options);
    if (!metrics || metrics.width === 0 || metrics.height === 0) return false;

    const style = window.getComputedStyle(this.element);
    const px = (v: string) => Number.parseInt(style.getPropertyValue(v)) || 0;
    const width =
      this.element.clientWidth -
      px("padding-left") -
      px("padding-right") -
      SCROLLBAR_WIDTH;
    const height =
      this.element.clientHeight - px("padding-top") - px("padding-bottom");
    if (width <= 0 || height <= 0) return false;

    const cols = Math.max(MIN_COLS, Math.floor(width / metrics.width));
    const rows = Math.max(MIN_ROWS, Math.floor(height / metrics.height));

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
    const term = this.term;
    // Runtime-guarded even though the patched `.d.ts` declares both: an
    // unapplied patch must degrade to "hot but correct", not to a crash.
    if (typeof term?.pause !== "function" || typeof term.resume !== "function") {
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

  // -------------------------------------------------------------------
  // I/O
  // -------------------------------------------------------------------

  write(data: string | Uint8Array): void {
    if (this.disposed) return;
    if (this.diag) diagWrite(this.id, data);
    if (!this.term) {
      this.pendingWrites.push(data);
      return;
    }
    // Literal strings come from phasr itself (status lines, log replay), not
    // from a PTY, so they are never a partial cluster.
    if (typeof data === "string") {
      this.flushHeldTail();
      this.term.write(data);
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
    if (end > 0) this.term.write(bytes.subarray(0, end));
    if (end < bytes.length) {
      // `slice` (a copy), not `subarray`: the caller owns `data`'s buffer.
      this.heldTail = bytes.slice(end);
      this.heldTimer = window.setTimeout(() => {
        this.heldTimer = null;
        this.flushHeldTail();
      }, HELD_TAIL_MS);
    }
  }

  /** Write whatever is being held, now. */
  private flushHeldTail(): void {
    this.clearHeldTimer();
    const tail = this.heldTail;
    this.heldTail = null;
    if (tail && tail.length > 0) this.term?.write(tail);
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
    // `scrollback` is in the options bag but `handleOptionChange` has no
    // case for it — the write is silently ignored, so scrollback is
    // apply-on-next-open. Stated in the settings copy.
    const written = applyChangedOptions(this.term.options, next);
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
    this.clearHeldTimer();
    this.heldTail = null;
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
    scrollback: options.scrollback,
    theme: options.theme,
    // No `lineHeight`: ghostty-web derives the cell box from the font
    // metrics and has no such option. phasr uses 1.0, which is what its
    // metrics already produce.
    ...(ghostty ? { ghostty } : {}),
  };
}
