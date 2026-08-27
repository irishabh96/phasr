# Spec: Perf Phase 2 — Renderer hot path (incl. amendments A4, A6)

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** P (performance) · **Ships as:** 0.4.2 · **Size:** 3–5 days
**Depends on:** P0 (baselines), P1 (scheduling — P2.3's value depends on it)
**Type:** ghostty-web patch work — own commits, upstreamable
**Provenance:** derived from a local iTerm2 source read, 2026-08-27.

## Objective

Make a frame cheap. This is the biggest code-level win in the program: today a fully-dirty
frame on a 50×200 grid costs roughly **500 000 cell parses and 10 000 object allocations**,
before a single glyph is drawn.

## The gap, read out of the installed patched dist

Line anchors below are **verified against the currently installed, patched**
`node_modules/ghostty-web/dist/ghostty-web.js` (3 271 lines). They differ from the original
plan's anchors because the v0.4.1 scroll program moved code; the plan's numbers are noted
where they drifted.

1. **`getLine()` is O(rows² × cols).** `getLine(A)` (`dist:241`) calls `getViewport()`
   (`dist:225`) *per row*; `getViewport()` re-parses the entire grid and `{...spread}`s fresh
   objects, defeating its own cell pool. Every rendered row pays for the whole grid.
2. **Per-cell canvas state churn.** `ctx.font` is rebuilt from a template string and
   assigned **per cell** (`dist:1567`, plan cited 1538); `ctx.fillStyle` is set per cell from
   a freshly-built `rgb(...)` string via `rgbToCSS` (`dist:1547`, `:1576`; plan cited 1548);
   `String.fromCodePoint` runs per cell. No run batching, no glyph cache.
3. **Scrollback rows still cost a WASM call each.** In the row loop (`dist:1498–1512`), any
   row above the live screen is fetched with a per-row `getScrollbackLine(F)` call
   (`dist:1502–1505`).
4. **Active scrolling still forces a full-canvas redraw.** `dist:1424` sets the full-redraw
   flag when the viewport's **top absolute row** changes — i.e. on a real scroll.
5. **Small per-frame waste**: `JSON.stringify` ×2 to compare the hovered link range
   (`dist:1452`, plan cited 1433); a per-write `includes(7)` BEL scan over up to 32 KiB of
   chunk (`dist:2495`, plan cited 2454); the cursor row repainted every frame while blink is
   on (`dist:1428`, `(s || this.cursorBlink) && vF === 0`), and `cursorBlink` defaults to
   `true` (`src/lib/terminal/options.ts:84`).

### Correction to the original plan — item already delivered

The plan's Gap-2 item "dirty tracking is bypassed entirely while scrolled back — every row
redrawn every frame" describes **pre-0.4.1** behaviour. The v0.4.1 patch fixed it: the row
loop now honours the engine's dirty flags while scrolled, at a shifted position —
`dist:1496–1497`:

```js
(vF > 0 ? B || t >= vF && A.isRowDirty(t - vF) : B || A.isRowDirty(t)) || k.has(t) || M.has(t)
```

with an in-patch comment explaining that upstream "masked the misdraw by repainting every
row every frame while scrolled, which is exactly the cost the change above removes."

So **"scrolled back and still" is already ~free.** What remains for this phase is items 3
and 4: the per-row WASM fetch, and the full redraw during *active* scrolling. Do not re-do
work that shipped in 0.4.1; measure first.

## User story

- As a developer scrolling deep scrollback or watching an agent repaint a TUI at speed, I
  want frames to be cheap, so scrolling is smooth and a flood does not make the app
  unresponsive.

## Acceptance criteria

1. **Viewport parsed once per frame.** The renderer obtains the viewport a single time and
   indexes rows out of it; `getLine(t)` is not called per row in the render path. A
   fully-dirty frame is ~`rows`× cheaper (≈ 50× on a 50-row grid).
2. **Run batching + state caching.** Rows are walked in runs of identical style;
   `ctx.font` and `ctx.fillStyle` are set **once per run**, not per cell. Colour→`rgb()`
   strings and flags→font strings are memoized.
3. **Scroll frame p95 < 16.7 ms in deep scrollback**, measured on WebKit (P0 apparatus). The
   Chromium self-comparison for the 60-step/3000-line scroll drops from **0.916 s** script
   (ADR-002:276) to **< 0.1 s**.
4. **Active scrolling blits.** During a scroll, the unchanged region is moved with a canvas
   self-`drawImage` and only newly exposed rows are drawn. Canvas operations per scroll frame
   — each one a WKWebView GPU-process IPC round-trip — fall **10–50×**.
5. **Hover compare is field equality.** Both `JSON.stringify` calls per frame are gone
   (`dist:1452`).
6. **BEL detection moves into the parser.** The per-write `includes(7)` scan over up to
   32 KiB (`dist:2495`) is removed from `write()`.
7. **Clean cursor row is not repainted between blink ticks.** A blinking cursor on an
   otherwise idle terminal costs one row repaint per blink transition, not one per frame.
8. **Flood frame cost falls ~50×** against the P0 baseline (self-comparison via
   `PHASE0_PROBE` / `SCROLL_PROBE`), and a `cat` of a 100 MB file keeps the UI interactive.
9. **No visual regressions.** `e2e/terminal-theme.spec.ts`, `terminal-selection.spec.ts`,
   `terminal-links.spec.ts`, `terminal-grapheme-split.spec.ts`, `terminal-scrollback.spec.ts`,
   `terminal-scroll-follow.spec.ts`, `terminal-wheel.spec.ts` and `terminal-reflow-anchor.spec.ts`
   all pass, under both Chromium and WebKit. **Two-pass rendering must be preserved** (see
   the constraint below).
10. **Patch hygiene**: dist changes in their own commits; `patches/ghostty-web@0.4.0.patch`
    regenerated via pnpm; no phasr-specific types in the hunks.

## Hard constraint — do not collapse the two-pass renderer

`renderLine()` (`dist:1527`, documented in the comment above it) draws **all cell
backgrounds first, then all text and decorations**. This is not an accident:

> "for proper rendering of complex scripts like Devanagari where diacritics (like vowel
> sign ि) can extend LEFT of the base character into the previous cell's visual area. If we
> draw backgrounds and text in a single pass (cell by cell), the background of cell N would
> cover any left-extending portions of graphemes from cell N-1."

Run batching must batch **within** each pass. `e2e/terminal-grapheme-split.spec.ts` is the
regression guard.

## #PATH_DECISION — A6: full-frame redraw beats per-rect damage work

iTerm2's Metal path has **no damage regions at all**: it redraws the full viewport every
frame, and dirty tracking only decides *whether* a frame happens
(`SessionView.m:1029–1036`). Cheap full frames come from run batching, a two-tier glyph cache
(direct-indexed ASCII array + LRU paged atlas), and RLE'd background rects.

**Decision: spend on making a frame cheap (criteria 1, 2, and the glyph-atlas stretch), not
on finer-grained damage tracking.** phasr keeps its row-level dirty tracking — it is already
built, already correct after the 0.4.1 fix, and it is the "whether a frame happens" half that
P1 leans on — but no work goes into sub-row or rect-level damage.

## Stretch goals — attempt only if P0 numbers still miss target after 1–7

_(Labelled P2-a/b/c to avoid collision with the program's spikes S1 and S2.)_

- **P2-a — Glyph atlas** on an offscreen canvas: `drawImage` per cell instead of `fillText`.
  Two-tier, per A6: a direct-indexed array for ASCII, an LRU paged atlas for the rest.
- **P2-b — OffscreenCanvas in a worker** (Safari 16.4+): the webview analog of iTerm2 drawing
  off the main thread. Large change; only if main-thread pressure persists.
- **P2-c — A4: the GANG bulk-output fast path.** For coalesced runs of plain text and CRLF,
  iTerm2 computes where the cursor will land and writes every line destined to scroll off
  **directly into scrollback, never touching the grid**; only the final screenful takes the
  normal path (`VT100ScreenMutableState+TerminalDelegate.m:248–380`). This is why
  `cat bigfile` is nearly free there. It is an **engine-level** change (ghostty-web patch or
  upstream Zig), so: attempt **only after 1–7 land** and **only if flood numbers still miss
  the 100 MB target**. Record the decision either way.

## Implementation notes — verified entry points

| Piece | Location (installed patched dist unless noted) |
|---|---|
| `getViewport()` — the O(grid) re-parse | `dist/ghostty-web.js:225` |
| `getLine(A)` — calls the above, per row | `dist/ghostty-web.js:241` |
| `render()` head: full-redraw flag, viewport-move check | `dist/ghostty-web.js:1404–1424` |
| Cursor-row quick paint (blink cost) | `dist/ghostty-web.js:1428–1437` |
| Selection + hover dirty-row accumulation | `dist/ghostty-web.js:1438–1452` |
| Hover `JSON.stringify` ×2 | `dist/ghostty-web.js:1452` |
| Dirty-row decision loop (post-0.4.1, honours flags while scrolled) | `dist/ghostty-web.js:1496–1497` |
| Row render loop + per-row `getScrollbackLine` | `dist/ghostty-web.js:1498–1512` |
| `renderLine()` two-pass | `dist/ghostty-web.js:1527` ff. |
| Per-cell background fill / `rgbToCSS` | `dist/ghostty-web.js:1547`, `:1554`, `:1576` |
| Per-cell `ctx.font` template-string assignment | `dist/ghostty-web.js:1567` (cursor variant `:1662`) |
| `write()` + per-write BEL scan | `dist/ghostty-web.js:2495` |
| Frame stats surface | `dist/ghostty-web.js:2846` `getRenderStats()` |
| Scroll animation rAF | `dist/ghostty-web.js:2210` |
| Host-side scroll/anchor logic | `src/lib/terminal/backends/ghostty.ts`, `src/lib/terminal/reflow.ts` |
| Patch file | `patches/ghostty-web@0.4.0.patch` |

## Parity targets this phase owns

| Axis | Target |
|---|---|
| Scroll | frame p95 < 16.7 ms in deep scrollback |
| Flood | `cat` of a 100 MB file keeps the whole UI interactive |

(Full table in `specs/perf-p0-measurement-baseline-spec.md`.)

## Test / evidence plan

- **vitest**: any host-side helper extracted from this work (run segmentation, style
  memoization keys) gets direct unit tests. Existing `src/lib/terminal/*.test.ts` stay green.
- **Playwright, both engines**: the visual regression suite named in criterion 9, run under
  the default config **and** `pnpm test:e2e:webkit`. WebKit is mandatory here — Chromium's
  Skia raster path and canvas text metrics are different, which is the entire reason the
  WebKit config exists.
- **Probes**: `SCROLL_PROBE=1` (`e2e/scroll-probe.spec.ts`) and `PHASE0_PROBE=1`
  (`e2e/terminal-phase0.spec.ts`) before/after, recorded in the P0 baseline table.
- **Mocked-IPC limitation:** the harness feeds bytes directly to the surface, so it measures
  paint honestly — but it runs in a browser, not a WKWebView. The 100 MB `cat` criterion and
  the "is scrolling smooth" judgement are **manual**, on a packaged build, per
  `docs/MANUAL-VERIFICATION.md`.

## Out of scope

Frame *scheduling* (P1) · anything Rust-side · the A4 GANG path unless the stretch gate opens
· sub-row damage tracking (rejected by A6) · replacing Canvas 2D with WebGL/WebGPU.
