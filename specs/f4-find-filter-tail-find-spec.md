# Spec: Track F4 — Find / filter / tail-find

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** F (features) · **Ships as:** 0.6.0 · **Size:** ~5 days
**Depends on:** perf Phase 3 landed. **Independent of F1, F2, F3** and of the ghostty-web
patch — this is host-side work over the engine's existing scrollback API.
**Provenance:** derived from a local iTerm2 source read, 2026-08-27 (`FindContext` shape).

## Objective

Search over phasr's **unlimited** scrollback without ever blocking a frame, and keep results
live while an agent is still streaming.

## Why "never blocks a frame" is the whole design

phasr ships unlimited scrollback (`UNLIMITED_SCROLLBACK_BYTES = 1_073_741_824`,
`src/lib/terminal/options.ts:40` — a 1 GiB wasm-heap budget, deliberately not u32-max because
wasm32's `usize` IS u32). A naive `for (i = 0; i < scrollbackLength; i++)` over a day-old
agent session is a multi-second main-thread stall, and every scrollback line costs a WASM
call: `getScrollbackLine(offset)` (`node_modules/ghostty-web/dist/index.d.ts:359`, `offset 0
= oldest`), with `getScrollbackLength()` at `:353`.

## User story

- As a developer searching a 10 000-line agent transcript, I want results as they are found
  and a UI that never freezes, so a search on a huge buffer is usable rather than a hang.
- As a developer searching while an agent is *still* running, I want new matches to appear as
  new output arrives, so I do not have to re-run the search.
- As a developer, I want to see only the lines that match, and click one to jump to it.

## Acceptance criteria

1. **Time-sliced resumable search.** One bounded slice per tick with a **~0.1 s budget**,
   carrying a cursor between ticks. A search over the largest reachable scrollback never
   produces a frame longer than the P2 budget (frame p95 < 16.7 ms is not violated by a
   search in progress).
2. **Progress is visible.** A progress indicator shows how much of the buffer has been
   searched; results stream in as they are found rather than appearing all at once at the end.
3. **Cancellable and restartable.** Typing another character cancels the in-flight pass and
   starts a new one without leaking the old cursor or double-reporting matches.
4. **Tail-find.** After a full pass completes, subsequent passes search **only appended
   lines**. For a streaming agent, results stay live with no re-scan of history. Asserted:
   with a completed pass, appending 100 lines containing 3 matches adds exactly 3 results and
   does not re-emit earlier ones.
5. **Filter mode** renders a **side list of matching lines** — not a rewritten terminal
   buffer. Clicking a row jumps the viewport to that row. (iTerm2 builds a derived
   `LineBuffer` for this; a side list is cheaper and fits our UI.)
6. **Smart case by default**: an all-lowercase query is case-insensitive; a query containing
   an uppercase character is case-sensitive. Toggleable.
7. **Regex toggle.** An invalid regex shows an inline error and searches nothing — it does
   not throw, and it does not fall back to a literal search silently.
8. **Highlighting reuses the existing selection/hover paint path** rather than adding a new
   overlay. Highlights survive scrolling and are cleared when the search closes.
9. **Results are stable across a resize.** A rows-only resize keeps results; a width change
   triggers a grid rebuild (`ResizePlan = "rebuild"`, `src/lib/terminal/reflow.ts:23`) after
   which results are either re-located or **visibly invalidated** — never left pointing at
   wrong rows. (Same constraint F2 faces; see that spec's reflow section.)
10. **No dropped-byte or perf regression.** The 0.4.2 targets still hold with a search
    running: idle cost, echo latency, and the flood target are unaffected while a search is
    in progress or a tail-find is armed.

## #PATH_DECISION — side list, not a derived buffer

iTerm2's filter mode constructs a derived `LineBuffer` containing only matching lines and
swaps the session's display to it. Rejected here for two reasons:

- **Cost.** Building a derived buffer means materializing matching lines into a second engine
  buffer across the IPC/WASM boundary; a side list holds only `(absoluteRow, text, matchSpan)`
  tuples in JS.
- **Fit.** phasr's terminal is one pane among several in an app that already has list UIs. A
  side list composes with the existing layout; a swapped buffer does not.

**Decision: filter mode is a side list with jump-to-row, in the host, over engine-fetched
lines.**

## #PATH_DECISION — search the engine's lines, not the raw log

An alternative would be to search the per-task log on the Rust side
(`src-tauri/src/commands/orchestrator.rs:168` `read_task_log`) — it holds the raw byte stream,
unbounded and older than the scrollback. Rejected for v1: the log is *bytes*, including escape
sequences and content the terminal has since erased, so matches would not correspond to what
the user can see, and row resolution would be impossible. Search what is on screen and in
scrollback; the log stays a diagnostic artifact.

Note also that perf Phase 3 adds log rotation, which caps its history — a further reason not
to build a user-facing feature on it.

## #PLAN_UNCERTAINTY — cost of `getScrollbackLine` per line

The 0.1 s slice budget is a *time* budget, so it self-tunes to whatever the per-line cost
turns out to be — but the resulting **lines-per-tick** number determines whether a full pass
over a large buffer takes 2 seconds or 2 minutes, and therefore whether tail-find is a nice
optimisation or the only thing that makes the feature usable.

Measure before designing the UI's progress affordance: fetch N scrollback lines through
`getScrollbackLine` and record lines/second under both Chromium and WebKit (P0's apparatus).
If the rate is poor, the mitigations to consider, in order: (a) a batched
`getScrollbackRange`-style addition to the ghostty-web patch — but note that is engine-patch
work this track was scoped to avoid; (b) an incrementally-maintained host-side text index
built as output arrives, trading memory for search speed; (c) capping search depth with an
explicit "searched the last N lines" affordance.

**An architect should see the measured number before (a) is authorized**, because it converts
F4 from independent work into patch work with S1-style sequencing constraints.

## Implementation notes — verified entry points

| Piece | Location |
|---|---|
| Scrollback length | `node_modules/ghostty-web/dist/index.d.ts:353` `getScrollbackLength(): number` |
| Scrollback line fetch | `dist/index.d.ts:359` `getScrollbackLine(offset): GhosttyCell[] \| null` — `offset 0 = oldest` |
| Grapheme access in scrollback (for correct match spans) | `dist/index.d.ts:402`, `:409` |
| Scrollback budget | `src/lib/terminal/options.ts:40` `UNLIMITED_SCROLLBACK_BYTES` |
| Surface API | `src/lib/terminal/surface.ts` — `TerminalSurface` (:114) |
| Backend | `src/lib/terminal/backends/ghostty.ts` |
| Selection primitives (highlight spans, char classes) | `src/lib/terminal/selection.ts` — `classifyChar` (:40), `runAtColumn` (:62), `logicalLineRange` (:97); `ColumnRange` (:50), `RowRange` (:81) |
| Existing selection e2e | `e2e/terminal-selection.spec.ts` |
| Scroll-to-row / viewport control | `src/lib/terminal/backends/ghostty.ts`; existing behaviour covered by `e2e/terminal-scroll-follow.spec.ts`, `terminal-scrollback.spec.ts` |
| Reflow policy (criterion 9) | `src/lib/terminal/reflow.ts:23,39` |
| Debounce for query input | `src/lib/hooks/useDebouncedValue.ts` |
| Keymap layer (⌘F etc.) | `src/lib/terminal/keymap.ts` + `keymap.test.ts`; e2e `e2e/terminal-keymap.spec.ts` |

**Keymap warning:** binding ⌘F here goes through the same two-layer trap that broke key
bindings three times before — the terminal engine ignores meta keys and the webview does not
run macOS text-editing actions. Ask which layer owns the binding before writing a handler;
`src/lib/terminal/keymap.ts` is where that question is already answered.

## Test / evidence plan

- **vitest** (`pnpm test`) — the primary suite, and this feature is unusually well-suited to
  it because the search engine is a pure function over a line-provider interface:
  - slice budget respected (fake clock, fake provider);
  - cursor resumption produces the same result set as an unsliced search;
  - cancellation mid-pass leaks nothing and double-reports nothing;
  - tail-find over appended lines (criterion 4);
  - smart case (criterion 6) and regex validation (criterion 7);
  - match spans correct across wide/grapheme cells.
- **Playwright** (`e2e/harness.ts`): the UI — open find, type, see streaming results and
  progress, toggle filter mode, click a row and land on it, highlights render. Run under
  `pnpm test:e2e:webkit` for the highlight paint. The harness writes bytes into a **real**
  surface, so the scrollback provider under test is the real engine — this is one of the few
  tracks the mocked-IPC harness covers well.
- **Probe**: extend `SCROLL_PROBE=1` / `PHASE0_PROBE=1` runs with "search in progress" to
  prove criterion 1 and 10 against P0's baseline.
- **Limitation:** the harness cannot produce a *day-old* buffer at realistic scale cheaply.
  The largest-buffer case (criterion 1's headline claim) needs a manual run on a packaged
  build with a long-lived session; add the `docs/MANUAL-VERIFICATION.md` entry.

## Out of scope

Searching across sessions or repositories · searching the on-disk task log · persisting
searches · search-and-replace · saved/named searches · regex capture-group extraction ·
building an engine-side search primitive (that is the patch work the uncertainty section
gates) · F5's smart selection.
