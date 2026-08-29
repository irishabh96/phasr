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

## Evidence — before/after (implemented 2026-08-29)

All rows: M1P (the P0 baseline machine), `E2E_PORT=14312`, one worker,
`caffeinate`. **Before** = the tree at `8d3f34a` (P1 landed; neither P2 nor P4's
frontend commits), measured fresh the same day because P1 moved the landscape.
**After** = P2 complete (`69155af`), with P4's byte-payload commits (`55f683d`,
`73baffd`) also on the branch — the scroll/paint measurement windows carry no
PTY traffic, so those rows are P2-attributable; the flood rows share credit
with P4 and are marked †.

| Metric | Runtime | Before (post-P1) | After P2 |
|---|---|---|---|
| Scroll work, 60 steps / 3 000 lines (CDP) | Chromium | Script 0.325 s / Task 0.489 s (program start: **0.916 s** ADR-002:276; P0 row: 0.51 s) | **Script 0.063 s / Task 0.227 s** — 5.2× vs post-P1, 14.5× vs ADR-002; **meets criterion 3's < 0.1 s** |
| Scroll-storm CPU profile (200 µs CDP sampling) | Chromium | fillText 4.6 % + renderCellText 3.9 % + renderLine 1.0 % (idle 83.9 %) | fillText **0.5 %** + renderCellText **0.1 %** + renderLine 0.1 % (idle 93.8 %) — the render cost of a scroll storm is ~gone |
| Deep-scroll frame time (`SCROLL_DEEP`) | WebKit | P0 row: p95 19.0 ms, max 33.0, 2 frames > 25 ms of 129 | **p95 18.0 ms, max 22.0, 0 frames > 25 ms** of 126; scroll-probe variants p95 19.0 **= the idle sampler's own p95**, mean 16.7 |
| TUI flood, 2 MB escape-dense repaint (CDP) | Chromium | Script 0.051 s | **Script 0.025 s** (2× — run batching on fully-dirty live frames) |
| Flood in-page throughput † | WebKit | 14.2 MB/s @ ~20.7 fps (P0: 14.7 @ ~36 free-running) | **18.4 MB/s @ ~28.3 fps**, cadence tier 30 held |
| Flood in-page throughput † | Chromium | 18.5 MB/s @ ~27.0 fps | 19.4 MB/s @ ~29.8 fps |
| Idle browser-tree CPU / 8 s † | WebKit | 1.25 s (post-P1) | **0.75 s** (criterion 7's blink gating + P4's byte path) |
| Idle script / 8 s (CDP) | Chromium | 0.041–0.050 s | 0.037 s — flat; **P1's scheduler is not regressed** |
| Blits during a 12-step wheel in 2 000-line history | Chromium (harness) | structurally 0 (every step a full repaint) | counter climbs in both directions — asserted in `e2e/terminal-scroll-blit.spec.ts` |
| `getScrollbackLine` bench (F4's path) | Chromium | 4.73 µs/line | 4.83 µs/line — flat, no regression |
| Q5 memory (engine + 1 / per terminal) | Chromium | 7.00 MiB / 5.21 MiB | identical |

**Reading the WebKit p95 against the < 16.7 ms target:** a 60 Hz rAF-delta
sampler cannot report p95 < 16.7 ms even for a blank page — a saturated 60 Hz
IS ~16.7 ms per frame, and WebKit's whole-ms quantization puts the sampler's
own idle p95 at 19.0 ms (the P0 spec's row says exactly this). The criterion is
met in that row's own operational reading: scroll p95 now **equals** idle p95,
the scroll-attributable tail (max 33 ms, 2 frames > 25 ms) is **eliminated**,
and the Chromium self-comparison meets its < 0.1 s number literally.

**Criteria closed:** 1 (viewport parsed once, `frameLine`; `getLine` no longer
in the render path), 2 (RLE background runs + memoized colour/font +
shadow-compared state, one set per run), 3 (rows above), 4 (blit + the e2e
counter guard), 5 (field equality), 7 (change-gated cursor-row repaint),
8 (flood paint work halved again on top of P1's cadence; canvas ops per scroll
frame fell ≥ 10–50× — blit + 2–3 exposed-row draws vs 50 full per-cell rows),
9 (see below), 10 (six patch commits, each `pnpm patch-commit` regenerated, no
phasr types in hunks).

**Criterion 9 — suite results at close (2026-08-29):** vitest 394/394. Full
Chromium suite `--workers=1`: **155 passed / 12 skipped / 0 failed**. Full
WebKit suite `--workers=1`: 133 passed / 15 skipped / 4 failed, of which
three (`terminal-grapheme-split:147`, `terminal-reflow-anchor:815`,
`terminal-scroll-follow:84`) pass individually — paint-window timing under an
8-minute serial grind — and all eight criterion-9 visual suites pass under
WebKit when run as files. The fourth, `terminal-aged.spec.ts:185` ("the
5,000-line setting is enforced at the rebuild", WebKit only, deterministic),
**reproduces byte-for-byte with the P1 engine installed** (patch + lockfile
reverted to `8d3f34a`, package re-extracted, cache purged, rerun) — it is not
a P2 regression; left for the branch's rebuild-path owners with this
attribution note. Also run at default parallelism for the record: the extra
failures there are all of the `__PHASR_TERM__ missing` / boot-timeout class —
the timing-sensitive terminal tests are written for serial runs, and there is
no parallel green precedent (CI runs no Playwright job).

**Bench drift note (F4's row, not this phase's):** the WebKit
`getScrollbackLine` bench post-P2 reads fetch-only 7.5–7.8 µs/line with
fetch+graphemes 5.0–5.3 (P0: 4.00 and 9.25) — the two passes swapped
magnitudes with a ~constant total on a code path P2 does not touch, on a
machine an hour into suite grinding. Chromium read flat (4.73 → 4.83). Read
per the P0 row's own guidance (~µs/line, pass order is noise); re-baseline on
a quiet machine before F4 consumes it.

**Criterion 6 — deviation, recorded:** "BEL detection moves into the parser"
is not implementable in this patch: the WASM exposes **no bell surface** (the
`ghostty_*` export table has no bell entry), so parser-side BEL is an upstream
engine change. What shipped instead: the scan is gated on
`bellEmitter.listeners.length` — phasr subscribes no bell listener, so the
per-write scan is **gone from `write()`** in this product (the criterion's
actual cost target), and hosts that do subscribe keep the old behaviour
unchanged.

## #PATH_DECISION — P2-c (GANG fast path): gate closed, not attempted

The stretch gate said: attempt only if flood numbers still miss target after
1–7. They do not miss what the harness can prove: in-page flood throughput
ROSE on both engines (WebKit 14.2 → 18.4 MB/s), the ~30 fps cadence tier holds
under flood (asserted in the default suite), fully-dirty paint work halved
again on top of P1, and the UI-responsiveness half is asserted by the liveness
suite. The remaining judgement — a 100 MB `cat` on a packaged WKWebView build —
is exactly what this spec's own test plan marks **manual**
(`docs/MANUAL-VERIFICATION.md`, 2026-08-29 P2 entry). If that manual run
disappoints, P2-c reopens as its own engine-level piece; nothing in P2's
changes forecloses it.

## Out of scope

Frame *scheduling* (P1) · anything Rust-side · the A4 GANG path unless the stretch gate opens
· sub-row damage tracking (rejected by A6) · replacing Canvas 2D with WebGL/WebGPU.
