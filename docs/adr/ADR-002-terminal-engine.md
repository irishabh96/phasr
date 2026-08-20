# ADR-002: Terminal engine — Phase 0 spike, the ghostty backend, and B1's VT engine

## Status

**Accepted — 2026-08-20. ghostty-web is the only terminal engine; the previous engine is
gone.**

- Accepted: `TerminalSurface` abstraction (kept), `ghostty-web` as the ONLY
  backend, and B1's `alacritty_terminal` engine **feature-gated and not wired
  into the live path**.
- **Phases 7 and 8 collapsed into one step, 2026-08-20**, on the user's call
  after hands-on use of a real build rather than on a benchmark. See
  "2026-08-20 — hands on, three bugs, and the the previous engine removal" at the end of
  this document, which is the section to read first: it corrects Q4 and
  supersedes the flag-based rollback below.
- **Q1 CLOSED 2026-08-21** in the field: a packaged `/Applications/Phasr.app`
  runs live terminals, so the WASM does load, compile and paint under
  `tauri://localhost` in a real bundle. See the 2026-08-21 section at the end.
- **Still open:** spike question 2 (it needs a built `.app` and a human).

**Prior status, for the record:** partially accepted 2026-08-19 — ghostty
behind a flag, default OFF, with the default flip explicitly not decided.

Plan of record: `~/.claude/plans/give-me-possible-ways-ticklish-lagoon.md`.

## Context

Every terminal in phasr was the previous engine. The migration plan proposed moving the
engine to Ghostty — in the webview via `ghostty-web` (Route A), plus a Rust-side
VT engine as a passive observer (B1). Phase 0 is a five-question spike that can
kill it.

Three of the five are answerable in Chromium. Two are not. This ADR answers
three with measurements and marks two OPEN with the exact steps to close them —
rather than answering all five badly.

---

## Phase 0 — the five spike questions

### Q1. Does WASM resolution work under `tauri://localhost` in a packaged app?

**ANSWERED — YES. Mechanism 2026-08-20 on WKWebView; end-to-end 2026-08-21 in a
real packaged build running live PTYs. No CSP change was needed.**

> `scripts/wkwebview-wasm-probe.swift` stands up a real `WKWebView` with a
> custom `tauri:` URL-scheme handler serving the **real built `dist/`**, and
> runs the same call `preloadGhosttyEngine()` makes:
>
> ```
> Q1 {"stage":"origin","origin":"tauri://localhost","href":"tauri://localhost/"}
> Q1 {"stage":"extracted","dataUrlBytes":564089}
> Q1 {"stage":"fetched","status":200,"wasmBytes":423045}
> Q1 {"stage":"compiled","exports":77}
> Q1 {"ok":true,"stage":"ghostty-load","ctor":"q","terminal":"constructed"}
> ```
>
> So WebKit **will** `fetch()` a `data:application/wasm` URL from a
> custom-scheme document and `WebAssembly.compile` the result, and the real
> patched `ghostty-web` then loads and constructs a `Terminal`. The
> "WKWebView might refuse the data: URL" failure mode this ADR predicted did
> not materialise.
>
> **What this still does not settle:** the probe uses its own
> `WKWebViewConfiguration`, whereas wry builds its own and serves assets
> through its own scheme handler; and it proves the WASM *loads*, not that a
> terminal paints and carries a live PTY. The manual steps below remain the
> gate. See `docs/RELEASE-0.4.0.md` §5.

**Original analysis (still accurate on the shape of the question):**

**OPEN — but the question changed shape, and the new shape is easier.**

The premise was `import.meta.url`-relative resolution. That is **not what
`ghostty-web@0.4.0` does.** Reading `node_modules/ghostty-web/dist/ghostty-web.js`:

```js
static async load(A) {
  if (A) return q.loadFromPath(A);
  const B = new URL("data:application/wasm;base64,AGFzbQ…");   // 564,139 bytes
  …
  g.push(B.href, "./ghostty-vt.wasm", "/ghostty-vt.wasm");
  for (const C of g) try { return await q.loadFromPath(C) } catch …
}
```

The 416 KB `.wasm` is **inlined as a `data:application/wasm;base64,…` URL** in
the ESM bundle (line 17 of `dist/ghostty-web.js` is 564 KB on its own). There is
no path resolution on the default path at all; `loadFromPath` does
`await fetch(dataUrl)` → `WebAssembly.compile` → `instantiate`. The relative
`./ghostty-vt.wasm` and `/ghostty-vt.wasm` entries are only fallbacks that are
never reached when the inline URL works.

So the real question is **CSP**, not paths: does the packaged app's
`connect-src` permit `fetch()` of a `data:` URL, and does `script-src` permit
`WebAssembly.compile` (some CSPs require `wasm-unsafe-eval`)? Neither is
observable in Chromium under `pnpm dev`, and phasr's CSP history says this is
exactly where things break (`docs/MANUAL-VERIFICATION.md` calls CSP on a bundled
build "the Clerk landmine").

**Steps to close Q1** (corrected 2026-08-19 — the original step 1 was not
executable: `localStorage` in the packaged app is a different origin
(`tauri://localhost`) from the dev server, so nothing you set before the build
is visible to it):

1. `pnpm tauri build`, then open
   `src-tauri/target/release/bundle/macos/Phasr.app`. **Not `tauri dev`** — that
   loads `http://localhost:1420`, a different origin with different rules.
2. Sign in and open a workspace. (There is no way around the sign-in: every
   route that constructs a terminal is behind it, which is why no automated
   step can reach this.)
3. Switch the engine from inside the app: ⌘K → **"Use the Ghostty terminal
   engine"**. That writes the `localStorage` key on the right origin and
   reloads. It is the same path `ops.spec.ts` exercises.
4. If the terminal never paints, check the webview console for
   `[terminal] ghostty engine failed to load`.
5. If it is CSP: add `data:` to `connect-src` and `'wasm-unsafe-eval'` to
   `script-src` in `src-tauri/tauri.conf.json`. **Note there is no CSP today**
   — see the 2026-08-19 run below — so this is a fallback, not the expectation.
6. Fallback if `data:` cannot be allowed: copy `node_modules/ghostty-web/ghostty-vt.wasm`
   into `public/` and pass its URL to `Ghostty.load(wasmPath)` in
   `preloadGhosttyEngine()` — one argument, already supported. **Required, not
   optional, if the data: URL fails**: no `.wasm` file is emitted into `dist/`
   or into the bundle today, so ghostty-web's `./ghostty-vt.wasm` and
   `/ghostty-vt.wasm` fallbacks resolve to nothing and would 404.

### Q2. Does native Edit ▸ Copy / Paste reach a ghostty terminal?

**OPEN for copy. Very likely already fine for paste.** The plan's "ghostty-web
registers no DOM clipboard listeners" is **half wrong** — verified in `dist/`:

| Event | ghostty-web@0.4.0 | Consequence |
|---|---|---|
| `paste` | **Two listeners** — `InputHandler.attach()` on the container, and `Terminal.open()` on the hidden `<textarea>` | Edit ▸ Paste has a target |
| `copy` / `cut` | **None anywhere** | Edit ▸ Copy has nothing to copy from |

Two further facts that change the analysis:

- `Terminal.open()` sets **`contenteditable="true"`** on the container (plus a
  `beforeinput` preventDefault). An editable host is what WebKit's
  `Editor::canPaste()` wants, so paste is plausibly already live.
- The selection is drawn on a `<canvas>`. There is **no DOM selection**, so
  `Editor::canCopy()` is false and macOS will grey out / no-op Edit ▸ Copy.

**Shipped: rung 1.** `backends/ghostty/clipboard.ts` installs capture-phase
`copy` / `cut` / `paste` on `surface.element`. Capture matters twice: it runs
before both of ghostty-web's paste listeners, and `stopPropagation()` then
guarantees exactly one paste rather than two.

**Implemented but OFF: rung 2.** `installSelectionMirror()` writes the terminal
selection into ghostty-web's hidden textarea and `select()`s it, making
`canCopy()` true. This is not speculative — ghostty-web already does exactly
this in its own `contextmenu` handler so right-click-copy works. It is off by
default because Chromium dispatches `copy` either way, so enabling it here would
be shipping an untested input-path change. Flip it at runtime with
`localStorage.setItem("phasr.terminal.clipboardMirror","1")` — deliberately a
runtime switch so the manual pass can answer Q2 in one session instead of one
build per rung.

**Rung 3 (custom `MenuItem`s emitting a Tauri event) is NOT implemented and must
not be without asking** — we would then own copy/paste for every `<input>` in
the app.

**Steps to close Q2:** in a built `.app`, drag-select terminal output, then Edit
▸ Copy, then paste elsewhere. If nothing lands, set `clipboardMirror` and
reload, and repeat. Record which rung was needed.

**Unrelated behaviour change worth knowing about:** ghostty-web **auto-copies on
selection**. `SelectionManager` calls `copyToClipboard(getSelection())` on every
mouseup that ends a selection and on every double-click. That is iTerm's
copy-on-select, it is not phasr's current behaviour, and it is not opt-out-able.

### Q3. Does the custom key handler suppress default handling like the previous engine's?

**NO — the semantics are INVERTED. Answered with a live test, and with a
mutation test proving the test has teeth.**

`ghostty-web@0.4.0`, `InputHandler.handleKeyDown`:

```js
if (this.customKeyEventHandler && this.customKeyEventHandler(A)) {
  A.preventDefault();
  return;
}
```

Return **`true`** to suppress. the previous engine is the opposite: return **`false`** to
suppress. `dist/index.d.ts` even says so ("Returns true to prevent default
handling") — the plan's assumption of parity was wrong.

Evidence — `e2e/terminal-keymap.spec.ts`, parameterized over both backends:

```
KEYMAP ghostty Meta+Backspace:  [""]     ⌘⌫  → ^U
KEYMAP ghostty Meta+ArrowLeft:  [""]     ⌘←  → ^A
KEYMAP ghostty Meta+ArrowRight: [""]     ⌘→  → ^E
KEYMAP ghostty Alt+ArrowLeft:   ["b"]    ⌥←  → ESC b
KEYMAP ghostty Alt+ArrowRight:  ["f"]    ⌥→  → ESC f
KEYMAP ghostty Shift+Enter:     ["\r"]   ⇧↵  → ESC CR
KEYMAP ghostty plain:           ["h","i","\r"] ordinary typing still works
18 passed
```

Mutation test — using the previous engine's polarity in the ghostty backend:

```
8 failed
  ghostty backend › ⌘⌫ kill-line reaches the PTY exactly once
  ghostty backend › ⌘← line start …
  ghostty backend › ⌘→ line end …
  ghostty backend › ⌥← word back …
  ghostty backend › ⌥→ word fwd …
  ghostty backend › ⇧↵ insert newline …
  ghostty backend › an UNMAPPED key still reaches the PTY (the inverted-return trap)
  ghostty backend › a mapped chord does not also emit the emulator's default
```

with `expect(sentBytes)` receiving `["", ""]` — i.e. the chord is swallowed and
ordinary typing dies too. Both halves of the trap, exactly as predicted.

**A second, worse finding fell out of the same investigation.** For any key it
can encode, ghostty-web calls `A.preventDefault(), A.stopPropagation()`. the previous engine
*ignores meta-modified keys entirely* — which is precisely why `keymap.ts` exists
— so today every ⌘-chord the keymap declines bubbles up to phasr's own handlers.
Under ghostty it does not, and **⌘K stops opening the Command Palette the moment
a terminal has focus**. `CommandPalette.tsx` listens on `document` in the bubble
phase, and so do `WorkspaceActionsMenu`, `WorkspaceSidebarMenu`,
`RepositorySidebarMenu`, `OpenInMenu`, `SyncButton` and `RunCommandPicker`.
(Window **capture**-phase listeners — `_app.tsx`'s ⌘+/⌘−/⌘0/⌘T — are unaffected;
they run first.)

Fixed by `swallowsAppChord()` in `backends/ghostty.ts`: return `true` for every
⌘-chord the keymap does not claim, which stops ghostty's encoding without
stopping propagation (the custom-handler path only calls `preventDefault()`).
⌘C / ⌘V / ⌘X are excluded — `preventDefault()` on their keydown would suppress
the browser clipboard action the rung-1 handlers ride on. Regression test:
`terminal-keymap.spec.ts` → "an app ⌘-chord still reaches the app with the
terminal focused", on both backends.

### Q4. Canvas-2D throughput

> **WITHDRAWN — 2026-08-20. Do not quote the table below.**
>
> A later benchmark run established that Playwright's default headless
> Chromium **has no GPU**: WebGL is served by ANGLE over SwiftShader, a CPU
> rasterizer. the previous engine's renderer IS WebGL, so every the previous engine number here was
> measured against a software rasterizer and every comparison flattered
> ghostty (Canvas 2D, which does not care). The rows are kept only so the
> mistake is visible; the comparison itself is invalid and the A/B harness
> that produced it was deleted with the previous engine. The ghostty-only figures
> (`IDLE_8S`, and the `PHASE0_PROBE=1` probe generally) are still valid as
> self-comparisons across runs.

**DIRECTIONAL ONLY. THIS DOES NOT CLEAR ANY GATE.**

Playwright drives Chromium: Skia, GPU rasterization, out-of-process compositor.
phasr ships on WKWebView, whose synchronous GPU-process IPC is the actual cause
of the "terminal scroll is never smooth" history that WebGL was brought in to
fix. Chromium cannot reproduce it. Recorded so a *regression* is visible, never
to claim a pass.

`e2e/terminal-phase0.spec.ts`, `PHASE0_PROBE=1`. Both backends fed byte-for-byte
identical streams (`tuiFrame(seed)`, the same generator `perf-probe.spec.ts`
uses, calibrated against 49 MB of real phasr PTY logs).

| Phase | previous + WebGL | ghostty + Canvas 2D | Read |
|---|---|---|---|
| `PTY_BULK_TUI_2MB` | Script 0.073 s, **Task 0.864 s** | Script 0.076 s, **Task 0.252 s** | ghostty ~3.4× less total main-thread time |
| `IDLE_8S` (1 visible terminal) | Script **0.018 s** | Script **0.420 s** | ghostty burns ~23× more script at idle |
| Scroll, 60 wheel steps over 3000 lines | Script 0.082 s, **Task 5.899 s** | Script **0.916 s**, Task 1.237 s | ghostty 11× more JS, 4.8× less total task |

Three readings, none of them a verdict:

1. **Throughput favours ghostty**, materially. Parsing into WASM plus a dirty-row
   canvas repaint costs less total main-thread time than the previous engine's parse + WebGL
   path, even with no glyph atlas.
2. **Idle cost favours the previous engine, badly.** ghostty-web free-runs a
   `requestAnimationFrame` loop from `open()` to `dispose()`. 0.420 s of script
   over 8 s is ~5% of a core to render one terminal that is not changing. Parked
   terminals are handled (`setActive(false)` → the patched `pause()`), but a
   *visible* one cannot be, so this is a floor. On a laptop it is battery.
3. **The scroll row is where Chromium is least informative.** the previous engine's 5.9 s of
   Task against 0.08 s of Script is almost entirely non-JS — raster, composite,
   GPU IPC. That is the exact axis WKWebView behaves differently on, in both
   directions.

**Frame-delta figures are deliberately not compared across backends.** The probe
counts how often `rAF` fires, and ghostty-web's own always-on rAF loop keeps the
frame pump saturated, inflating its count and shrinking every delta (310 frames
vs 192 over the same wall time). Each backend's frame numbers are comparable only
to themselves across runs. The probe prints this caveat next to the numbers so a
future reader cannot pick them up by accident.

### Q5. Per-terminal WASM linear memory at `scrollback: 10000`

**ANSWERED. ~5.2 MiB per terminal, and it does not depend on `scrollback`.**

One `Ghostty` instance is loaded for the whole app and passed to every
`Terminal` through `ITerminalOptions.ghostty`, so there is **one**
`WebAssembly.Memory`, not N. Measured through a DEV-only
`window.__PHASR_GHOSTTY__.wasmBytes()` (gated exactly like `bridge.ts`), with
terminals created through the real app path (⌘T):

```
Q5 engine+1 terminal (empty):  7.06 MiB, surfaces=1
Q5 after ⌘T #1: 12.25 MiB, surfaces=2
Q5 after ⌘T #2: 17.50 MiB, surfaces=3
Q5 after ⌘T #3: 22.69 MiB, surfaces=4
Q5 after ⌘T #4: 27.94 MiB, surfaces=5
Q5 after ⌘T #5: 33.13 MiB, surfaces=6
Q5 after ⌘T #6: 38.38 MiB, surfaces=7
Q5 after ⌘T #7: 43.56 MiB, surfaces=8
Q5 filling one terminal with 10 000 lines: 43.56 → 43.63 MiB (+0.06 MiB)
```

- **Engine + first terminal: 7.06 MiB.**
- **Each additional terminal: +5.21 MiB**, dead flat across seven of them.
- **Filling a terminal's scrollback costs ~nothing** (+0.06 MiB for 10 000
  lines): Ghostty allocates its page pool up front, so an "empty" terminal
  already costs its steady-state size. Good property — the number is bounded and
  predictable rather than growing with session length.
- **`scrollback` does not move it.** Re-measured at 200 and at 10 000 (a 50×
  span): identical, 5.21 MiB per terminal both times. ghostty-web *does* forward
  the option to `ghostty_terminal_new_with_config` as `scrollbackLimit`, so this
  is Ghostty's allocation strategy, not a plumbing bug.

**Consequence for the LRU bound (`cache.ts`, currently 8): ~7 + 8 × 5.2 ≈ 48 MiB
of WASM heap at the cap**, plus one canvas per terminal. That is acceptable and
the bound stays at 8. Note this is *WASM heap only* — JS objects and canvas
backing stores are additional and are not measured here.

---

## Phase 5 — the ghostty backend

Shipped behind `localStorage["phasr.terminal.backend"]`, then
`VITE_TERMINAL_BACKEND`, **defaulting to `the previous engine`**. A user who set nothing saw
no change. (That flag is gone as of 2026-08-20 — see the final section.)

### Where ghostty-web's source contradicted the plan's gap table

The gap table was derived from source and mostly held. Four corrections:

| Plan said | Source says |
|---|---|
| "Never register upstream's OSC 8 provider" | **Not achievable by omission.** `Terminal.open()` registers `new OSC8LinkProvider(this)` **and** `new UrlRegexProvider(this)` unconditionally, with no opt-out. They have to be *removed* after `open()` — `unregisterBuiltinLinkProviders()` empties `linkDetector.providers`. That reaches through a private field, so it returns a boolean and the backend refuses to register ours if it fails. |
| "`scrollback` not in the options Proxy" | It **is** in the bag (`scrollback: A.scrollback ?? 1e4`). `handleOptionChange` simply has no `case "scrollback"`, so a post-`open()` write is silently ignored — no warning, unlike `theme`. Same net effect (apply-on-next-open), different and quieter mechanism. |
| "No DOM clipboard listeners" | True for `copy`/`cut`. **False for `paste`**, which has two listeners. See Q2. |
| `attachCustomKeyEventHandler` parity | Inverted. See Q3. |

Everything else in the table was accurate: no `options.linkHandler`; OSC 8 is a
provider; `ILink.range` is 0-based **end-inclusive** with no `decorations`;
`provideLinks(y)` gets a 0-based absolute row; a runtime `theme` write warns and
does nothing; no `refresh()`; an always-on rAF loop with no pause API.

### Two findings the table did not have

1. **`IBufferLine.translateToString()` cannot be used for anything positional.**
   `getChars()` returns `""` for codepoint 0 — a never-written cell, and the
   trailing half of a double-width grapheme. So `\x1b[10G` + text yields a string
   whose index 0 is grid column 9, and every link span would land on the wrong
   columns. The link binding builds its text one character per cell (`lineToText`
   in `backends/ghostty/links.ts`). ghostty-web's own `UrlRegexProvider` works
   around this the same way, which is the tell that `translateToString` is not
   the intended positional API.
2. **`Terminal.dispose()` leaks a `document` listener.** `dispose()` sets
   `isOpen = false` *before* calling `cleanupComponents()`, and cleanup guards
   the `mouseup` removal on `this.isOpen` — so
   `document.removeEventListener("mouseup", this.handleMouseUp)` never runs. One
   leaked closure on `document` per disposed terminal, which the LRU makes
   routine. Fixed in `patches/ghostty-web@0.4.0.patch`.

### The security regression is real and reachable — demonstrated

Upstream's OSC 8 provider activates with a bare
`window.open(uri, "_blank", "noopener,noreferrer")` and **no scheme validation**;
so does `UrlRegexProvider`, whose regex matches `mailto:`, `ftp://`, `ssh://`,
`git://`, `tel:`, `magnet:`, `gemini://`, `gopher://` and `news:` — none of which
phasr's `isOpenableUrl` (http/https only) will ever pass, and none of which
phasr's own detector even matches. Terminal output is whatever an agent printed.

`e2e/terminal-links.spec.ts` is the gate. It records **both** exfiltration
routes — Tauri's `plugin:opener|open_url` invoke and the webview's own
`window.open` — and asserts zero on each:

```
OSC8 SEEN [ghostty]: [{"cmd":"plugin:opener|open_url","args":{"url":"https://en.wikipedia.org/…"}}]
HOSTILE javascript [ghostty]: opener=[] window.open=[]
HOSTILE file       [ghostty]: opener=[] window.open=[]
PLAINTEXT ftp://evil.example/x [ghostty]: opener=[] window.open=[]
PLAINTEXT mailto:a@b.c         [ghostty]: opener=[] window.open=[]
12 passed   (6 previous, 6 ghostty — identical assertions)
```

Mutation test, with `unregisterBuiltinLinkProviders` disabled:

```
2 failed
  ghostty backend › plain-text ftp: URL is not openable
  ghostty backend › plain-text mailto: URL is not openable
    Expected: []
    Received: ["mailto:a@b.c"]        ← window.open, straight past isOpenableUrl
```

Note the **OSC 8** hostile cases still passed under that mutation, because
`LinkDetector.cacheLink` keys OSC 8 links by hyperlink id and the last provider
registered wins the slot — ours. The plain-text cases have no such collision,
which is what makes the removal load-bearing rather than belt-and-braces. Worth
recording: the OSC 8 half of that protection is an accident of upstream's cache
keying and must not be relied on.

### The off-by-one, in both directions

Neutral span is 0-based **half-open** `[startCol, endCol)`. The two backends
disagree on both ends, in opposite directions:

| Backend | start | end |
|---|---|---|
| previous | `startCol + 1` (1-based) | `endCol` (inclusive) |
| ghostty | `startCol` (0-based) | `endCol - 1` (inclusive) |

Both translations are exported and unit-tested against the **real** detector
rather than a hand-written span (`backends/ghostty/links.test.ts`,
19 tests), including a cross-backend test asserting the two select
character-for-character identical text on the same line.

### Bundle cost, measured both ways

`ghostty-web` is reached only through `import("ghostty-web")` inside
`backends/ghostty.ts`. Measured by temporarily converting that to a static
import and rebuilding:

| | eager chunk (`useRepositories-*.js`) | separate async chunk |
|---|---|---|
| dynamic import (shipped) | **473.46 kB** (gzip 123.89 kB) | `ghostty-web-*.js` **638.45 kB** (gzip 185.23 kB) |
| static import | **1,111.77 kB** (gzip 309.21 kB) | — |

**+638 kB raw / +185 kB gzip** would otherwise land on every user's eager path,
including everyone on the default backend. The workspace route chunk
(`_workspaceId-*.js`) is 77.85 kB either way — the adapter itself is noise; the
inlined WASM is the whole cost.

### Other decisions

- **The engine is async, the factory is not.** `createTerminalSurface()` is
  called from a `useEffect` in three components. `GhosttySurface` exists
  immediately with a real `element`, queues writes/input/focus, and replays them
  on attach; `factory.ts` starts the load at module scope when ghostty is
  selected, so the queue is normally empty. If the engine does land late, the
  PTY is spawned at 80×24 and the post-attach `fit()` fires `onResize` →
  `resize_task`, so the agent gets the right width one round trip late rather
  than never.
- **Our own `fit()`, not ghostty-web's `FitAddon`.** The addon holds a 50 ms
  `_isResizing` lockout after every resize and silently drops any fit inside it.
  phasr fits on a settle timer after a drag — exactly the call that would be
  dropped.
- **`input(seq, true)`.** ghostty-web's `input()` defaults `wasUserInput` to
  **false**, which *writes the bytes into the screen* instead of firing
  `onData`. Every keymap chord would paint itself into the terminal and never
  reach the PTY.
- **Canvas 2D retires the ~16-WebGL-context cap by construction.** The
  persistent-container trick in `cache.ts` survives, but its justification
  changes: there is no GPU context to lose, so the reason is now purely "keep
  the emulator, its scrollback and its live PTY channel alive across a React
  unmount".
- **Licences.** `THIRD-PARTY-NOTICES.md` (new) carries ghostty-web (MIT, Coder),
  Ghostty (MIT, Mitchell Hashimoto + contributors — its code is what the inlined
  WASM is), the previous engine, the derived-source notice for
  `backends/ghostty/osc8Provider.ts`, and the patch notice. phasr has **no
  in-app attribution surface today** (the About panel is
  `PredefinedMenuItem::about` with no licence list); when one is added it should
  render that file.
- **`patches/ghostty-web@0.4.0.patch`** adds `pause()`/`resume()` around the rAF
  loop and fixes the dispose-time `document` listener leak. Both are intended
  for upstreaming. `setActive()` feature-detects them so an unapplied patch
  degrades to "hot but correct", not to a crash.

### e2e coverage, parameterized over both backends

*(Historical: the parameterization was removed with the previous engine on 2026-08-20.
`expectBackend()` survives as a "a real emulator was built" gate.)*

`harness.ts` seeded `localStorage["phasr.terminal.backend"]` via
`addInitScript` — the real user-facing escape hatch, not a test-only door —
and `expectBackend()` asserted `data-terminal-kind` so a backend that failed
to construct could not silently run the suite as the previous engine twice and report a
green A/B.

| Spec | Coverage |
|---|---|
| `terminal-links.spec.ts` | link parity + the hostile-scheme gate (12 tests) |
| `terminal-keymap.spec.ts` | the iTerm chord table end-to-end + app-shortcut passthrough (18 tests) |
| `terminal-theme.spec.ts` | live theme flip, asserted on composited pixels (2 tests) |
| `ops.spec.ts` ⌘=/⌘−/⌘0 | settings write → live reflow → `resize_task`, zero PTY leakage (2 tests) |
| `terminal-phase0.spec.ts` | Q4/Q5 probes, `PHASE0_PROBE=1` |

Full suite: **115 passed, 6 skipped, 0 failed.**

---

## B1 — the Rust VT engine

Feature-gated (`--features vt-alacritty`), **not in `default`**, and **not wired
into `PtyHandle::spawn`**. `pty/handle.rs` keeps its `TuiMarkerScanner` and
echo-verification byte scanning, and there is no `inspect_terminal` command:
those are the "cash the wins" step and they change live agent-launch behaviour,
which needs its own verification pass.

### Engine choice: `alacritty_terminal` 0.26, decided on cost, validated on the corpus

`zig` is **not installed** on this machine (`which zig` → not found), and
`libghostty-vt` needs Zig 0.16.x on PATH for *any* `cargo check` — not just for
a release build. Installing a second language toolchain is not a unilateral
decision, so `alacritty_terminal` 0.26 (Apache-2.0, `Send`, mature, cargo-only)
was implemented behind the trait instead.

**What swapping to `libghostty-vt` later costs:** a new `vt/ghostty.rs`
implementing the same seven trait methods, `vt-ghostty = ["dep:libghostty-vt"]`
in `Cargo.toml`, a CI job on `macos-14` with Zig on PATH, and one `cfg` at the
single construction site. `vt/thread.rs` already builds the engine *on* the VT
thread from a closure, so a `!Send + !Sync` engine needs no `unsafe impl Send`
and no architectural change; `vt/replay.rs` and `vt/conformance.rs` re-run
unmodified. That is the entire reason the seam was built first.

### Conformance against the real corpus

`pump_pty_output` already appends every raw PTY byte to
`<app_data>/logs/<id>.log`. **47 MB across 27 logs** of genuine Claude / codex /
gemini streams existed on disk with no capture work. `vt/conformance.rs` replays
them; every test is a no-op on a machine with no corpus (fresh checkout, CI).

**Device queries are present and answered** — the failure mode that hangs a TUI
with nothing in any log:

```
CONFORMANCE b8734c3b-…log  fed=4194304 replies=  5  24x80 alt=1 mouse=1 focus=1 bp=1 cursor=0
CONFORMANCE 4263a9e8-…log  fed=4194304 replies= 15  24x80 alt=1 mouse=1 focus=1 bp=1 cursor=0
CONFORMANCE 6ab5a833-…log  fed=3808962 replies= 75  24x80 alt=1 mouse=1 focus=1 bp=1 cursor=1
CONFORMANCE 9c3e506f-…log  fed=  58612 replies=492  24x80 alt=1 mouse=1 focus=1 bp=1 cursor=0
CONFORMANCE SUMMARY: 687 reply bytes across 12 of 12 logs
```

Every log contains device queries and every one is answered. Backed by unit
tests that pin the exact replies (`\x1b[5;9H\x1b[6n` → `\x1b[5;9R`), including
across an `advance()` split.

**Chunk-boundary conformance — a real divergence, characterized rather than
hand-waved.** This is what the harness was for.

- At **realistic PTY chunk sizes (512 B – 64 KiB)** — which is the entire range
  phasr can produce, since a read is 4096 B and Phase 3's coalescer only makes
  chunks bigger — the final grid is **identical across the whole corpus**.
  Asserted (`grid_is_independent_of_realistic_chunk_boundaries`).
- At **pathological 1–64 byte chunks** it is not always identical:

  ```
  BOUNDARY b8734c3b-…log  chunk=3  rows-differing=1/24
  BOUNDARY b8734c3b-…log  chunk=7  rows-differing=2/24
  BOUNDARY 6a8f8cdd-…log  chunk=7  rows-differing=1/24
  BOUNDARY a19a1920-…log  chunk=3  rows-differing=1/24
  BOUNDARY SUMMARY: worst case 2 row(s) differ at a pathological chunk size
  ```

  Deterministic (identical across repeated runs), narrow, and always a
  one-column shift inside a spinner/status line, e.g.

  ```
  row 15 differs:
    a: "──⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents─────────        C"
    b: "──⏵⏵ bypass permissions on (shift+tab to cycle) ·← for agents──────────        C"
  ```

  Origin bisected to byte 16104 of `a19a1920-…log`, a read boundary landing
  inside a multi-byte UTF-8 grapheme (`·` = C2 B7 adjacent to `↓` = E2 86 93).
  Note `chunk = 1` — which splits *everywhere* — does **not** diverge, and a
  minimal `a·b`-split-at-every-byte unit test passes, so this is not naive
  UTF-8 carry; it needs a boundary at one specific offset.

  Reported and bounded rather than gated, because it is unreachable from
  phasr's read path, and because `modes` — the only thing B1 consumes for
  readiness — is **identical in every case**, which *is* asserted. The bound is
  `worst <= 2`, so a material regression fails the build.

**Readiness: state vs byte-scanning, on real traffic.**

```
READINESS <12 logs>  bytes-said=1  state-says=1  (alt=1 mouse=1 focus=1)  cursor-hidden-in-stream=1
READINESS SUMMARY: agree=12 disagree=0
```

The two agree on all 12 logs — which is the honest result, and worth stating
plainly: **on this corpus the byte scanner is not currently wrong.** Its value is
in the failure modes the corpus does not contain: a mode set and later cleared
(a substring match can never see that), a marker dropped by a `Lagged` broadcast
(`handle.rs:512`, `:548`), and `\x1b[?25l` from a shell prompt theme — note
`cursor-hidden-in-stream=1` on all 12 logs, i.e. the sequence that
`handle.rs:560-561` admits can false-positive is present in every single one.
Unit tests pin the improvement directly
(`hiding_the_cursor_is_not_a_tui_takeover`,
`alt_screen_and_mouse_modes_are_real_state_not_substrings`).

### CI

A third job, `vt`, runs `cargo check --features vt-alacritty` and
`cargo test --features vt-alacritty vt::`. Without it, a feature-gated module
that is not in `default` can break on an unrelated PR and nobody finds out until
someone turns the flag on.

---

## Explicitly NOT decided here

- ~~**Phase 7 (default flip).**~~ and ~~**Phase 8 (delete the previous engine).**~~ — both
  DONE on 2026-08-20, together, by the user's decision after using a real
  build. What cleared it was hands-on use, not a number; see the final
  section. The idle-CPU concern is unchanged and still real.
- **Wiring B1 into the live path** (replacing the byte scanning, adding
  `inspect_terminal`). Both change agent-launch behaviour.
- **`libghostty-vt`.** Blocked on a decision about installing Zig.

## Rollback

**Since 2026-08-20: `git revert`.** The runtime flag, the second backend and
its dependencies are gone, so there is no longer a switch to flip — which is
the deliberate trade the user made for a single code path. What makes the
revert cheap is that `TerminalSurface` is still in place and nothing outside
`src/lib/terminal/backends/` knows which emulator is running.

*(Previously: `localStorage.setItem("phasr.terminal.backend",<previous>)` — no
release, no restart beyond a reload.)*

B1 is behind a cargo feature that is off by default and touches nothing at
runtime.

## Verification run for this ADR

```
pnpm typecheck                                                        ✓
pnpm build                                                            ✓
pnpm test                                    29 files, 252 tests      ✓
pnpm exec playwright test                    115 passed, 6 skipped    ✓
cargo check  --manifest-path src-tauri/Cargo.toml                     ✓
cargo test   --manifest-path src-tauri/Cargo.toml   213 passed        ✓
cargo check  --manifest-path src-tauri/Cargo.toml --features vt-alacritty  ✓
cargo test   --manifest-path src-tauri/Cargo.toml --features vt-alacritty vt::  21 passed  ✓
node .claude/skills/tauri-backend/scripts/check-command-contract.mjs --all
                                             OK: 81/81 commands       ✓
```

`pnpm lint` is pre-existing broken (`eslint: command not found`, no config) and
was not run.

---

## End-to-end verification run — 2026-08-19: both flows, side by side

The question this run answers is not "does the suite pass" but **"are the two
backends at parity, and where exactly are they not"**. Everything below was
observed on this machine; anything not observed is marked as such.

### How the A/B was actually run

The parameterized terminal specs already cover both backends themselves. The
rest of the suite — `ops`, `forms`, `notes`, `notes-todo`, `design`,
`base-branch`, `app.smoke` — boots a real workspace **with a real terminal in
it** and would otherwise only ever exercise the default. So `harness.ts` gained
one env override:

```ts
E2E_TERMINAL_BACKEND=ghostty pnpm exec playwright test   // every spec, that emulator
```

It seeds the same `localStorage["phasr.terminal.backend"]` key, and it is
**set-if-absent** rather than an unconditional write. That is load-bearing: an
`addInitScript` re-runs on every load *including the reload
`setTerminalBackend()` triggers*, so an unconditional write silently undoes the
Command Palette's engine switch and makes the rollback path look broken. (It
did, on the first attempt — that failure was the harness, not the product.)
An explicit `options.backend` still wins, so the parameterized specs are not
flipped out from under their own `expectBackend` assertion.

### Per-spec, per-backend results

Whole suite, twice. `P` = passed, `F` = failed, `S` = skipped.

| Spec | previous | ghostty |
|---|---|---|
| `app.smoke.spec.ts` | 1P 0F | 1P 0F |
| `base-branch.spec.ts` | 6P 0F | 6P 0F |
| `design.spec.ts` | 12P 0F | 12P 0F |
| `forms.spec.ts` | 29P 0F | 29P 0F |
| `notes-todo.spec.ts` | 8P 0F | 8P 0F |
| `notes.spec.ts` | 7P 0F | 7P 0F |
| `ops.spec.ts` | 21P 0F | 20P **1F** |
| `perf-probe.spec.ts` | 0P 0F 1S | 0P 0F 1S |
| `scroll-probe.spec.ts` | 0P 0F 1S | 0P 0F 1S |
| `terminal-keymap.spec.ts` | 9P 0F | 9P 0F |
| `terminal-links.spec.ts` | 6P 0F | 6P 0F |
| `terminal-lru.spec.ts` (new) | 2P 0F | 2P 0F |
| `terminal-phase0.spec.ts` | 0P 0F 4S | 0P 0F 4S |
| `terminal-selection.spec.ts` (new) | 2P 0F | 2P 0F |
| `terminal-theme.spec.ts` | 2P 0F | 2P 0F |
| **Total** | **120 passed, 0 failed, 6 skipped** | **119 passed, 1 failed, 6 skipped** |

**The one divergence is not a divergence.** `ops.spec.ts` → "the Command
Palette switches the terminal engine and back" opens with
`expectBackend(page, <previous engine>) // the product default`. Forcing the suite onto
ghostty contradicts that assertion by construction — the test exists to prove
the *default* and the rollback, and it passes on its own and inside the the previous engine
pass. It is the only test in the suite that cannot be parameterized.

Timing is not a differentiator either: across the 101 tests that pass on both,
ghostty totals **193.3 s vs the previous engine's 195.5 s (−1.1 %)**, and the largest
per-test deltas (±1 s) are the known-flaky `base-branch` cases, not terminal
work.

`base-branch.spec.ts` — pre-existing flake, **re-characterized rather than
chased**. It passed 6/6 in both final full-suite runs. Run *in isolation* it is
much worse than the "fail, pass, pass" previously recorded: 3 runs per backend
gave failures of 3, 1, 1 (the previous engine) and 1, 1, 1 (ghostty), always
`expect(listbox).toBeHidden()` still visible after 5 s, and **a different test
each time**. Equal rates on both backends, no terminal involvement: unrelated,
and its rate is a function of parallelism, not of the emulator.

### New coverage this run added

**`terminal-lru.spec.ts`** — the LRU had unit tests over fake surfaces and
nothing end to end. It now drives the shipped policy
(`localStorage["phasr.terminal.maxCached"] = 1`), fills a real terminal,
navigates away so it parks, and asserts on both backends:

```
LRU[previous]   eviction log: ["[terminal] evicted agent:ws-agent (over 1 cached); its process is untouched and the next mount re-attaches with replay"]
LRU[previous]   open_task_terminal x2
LRU[previous]   pre-eviction scrollback survived: false
LRU[ghostty] eviction log: ["[terminal] evicted agent:ws-agent (over 1 cached); …"]
LRU[ghostty] open_task_terminal x2
LRU[ghostty] pre-eviction scrollback survived: false
```

i.e. the surface really is destroyed (it disappears from the `__PHASR_TERM__`
registry), **no `stop_*` / `delete_workspace` / `archive_workspace` command is
ever issued** — the PTY is never asked to die — the next mount builds a *new*
surface (different `data-terminal-id`) and re-attaches through the ordinary
`open_task_terminal` path, whose Rust side is `subscribe_with_replay`, and
output emitted after the round trip renders. Identical on both backends,
including the documented cost: the pre-eviction scrollback is gone.

Caveat, stated because the test cannot: this is the **frontend** half. The
harness mocks IPC, so "the PTY survived" is proven only as "nothing in the app
asked it to stop". The Rust half is `subscribe_with_replay`'s own unit tests.

**`terminal-selection.spec.ts`** — turns the ADR's source-derived
copy-on-select claim into an observation:

```
SELECTION[previous]   clipboard after drag = "PHASR-CLIPBOARD-SENTINEL"
SELECTION[ghostty] clipboard after drag = "ELECT-THIS-LINE-0123"
```

**This is a real, user-visible divergence and it is not covered by any other
test.** On the previous engine a drag-selection leaves the pasteboard alone. On ghostty the
selection is written to the clipboard on mouseup — silently overwriting
whatever the user had there, with no opt-out. Now asserted on both sides, so
if upstream makes it opt-out-able (or phasr suppresses it) the change is
visible instead of silent.

### Do the ghostty keymap tests have teeth? Yes — re-proved by mutation

Q3's inverted semantics are the highest-risk parity surface, so "9 passed on
ghostty" is worth nothing unless the assertions can fail. `backends/ghostty.ts`
was temporarily given the previous engine's polarity (`return false` for a mapped chord,
`!swallowsAppChord(event)` otherwise):

```
9 failed   ← every ghostty test, including the ⌘K app-chord regression test
9 passed   ← every the previous engine test, untouched
```

The mutation is backend-local and so is the failure, which is the proof that
the ghostty half of the spec drives the ghostty path rather than silently
running the previous engine twice. Source restored byte-identically afterwards
(`diff -q` clean, no markers left), and the full suite re-run green after.

### Real PTY, not mocked IPC — what actually ran

| | Result |
|---|---|
| `cargo test` (default features) | **213 passed, 0 failed, 1 ignored** |
| `cargo test -- --ignored` | **1 passed** — `pty::runtime::tests::e2e_real_claude_prompt_submits` |
| repeat runs of that test | **5/5 passed** (4.2–4.9 s each), 6/6 including the first |
| `cargo test --features vt-alacritty vt::` | **21 passed** |
| `pnpm test` (vitest) | 29 files, **252 passed** |
| `pnpm typecheck` | clean |

The ignored test is the one that matters here, and **it is not a stub**: it
spawns the real `claude` CLI (v2.1.235, installed at `~/.local/bin/claude` and
logged in) through the production command in a fresh temp dir, over a real
PTY. The captured stream shows it hitting the first-run trust dialog and
answering it the way the user would, then the prompt being submitted:

```
Quick safety check: Is this a project you created or one you trust?
❯ 1. Yes, I trust this folder
…Yes, I trust this folder ✔
╭─── Claude Code v2.1.235 ───…
…esc to interrupt          ← the assertion: text was SUBMITTED, not just typed
```

**Why this is the right test for Phases 3 and 4.** The readiness protocol
(`watch_after_typing`, `wait_for_tui`) consumes `broadcast::Receiver<PtyEvent>`
— i.e. it reads **post-coalescer** chunks (`COALESCE_BYTES = 32 KiB`,
`COALESCE_WINDOW = 8 ms`, `handle.rs`). Phase 3 therefore changed the chunk
boundaries directly underneath the marker scanner and the echo matcher, and
this test is the only thing that exercises that against a real agent. It
passes, repeatedly.

**What it does *not* cover, stated plainly.** Phase 4's base64 is a
`serialize_with` on `PtyEvent::Output`; the Rust test reads the enum
in-process and never serializes, and the Playwright harness synthesizes base64
on the JS side and decodes it with `decodePtyChunk`. Each half is covered;
**the two halves have never met in one process.** Only a running Tauri build
serializes a real PTY's bytes and hands them to a real emulator. That is a
genuine gap, not a formality — it is exactly the shape of bug the mocked-IPC
harness is known to miss.

### `vt/conformance.rs` against the real corpus — reproduced exactly

```
CONFORMANCE b8734c3b-….log fed=4194304 replies=  5  24x80 alt=1 mouse=1 focus=1 bp=1 cursor=0
CONFORMANCE 4263a9e8-….log fed=4194304 replies= 15  …
CONFORMANCE 6ab5a833-….log fed=3808962 replies= 75  …
CONFORMANCE session:e8c3dd09-….log fed=3665247 replies=  5  …
CONFORMANCE 6a8f8cdd-….log fed=2402975 replies= 15  …
CONFORMANCE 5f7641a3-….log fed=1219143 replies= 20  …
CONFORMANCE af02aab0-….log fed= 869114 replies=  5  …
CONFORMANCE bdb3cd01-….log fed= 832463 replies= 35  …
CONFORMANCE a19a1920-….log fed= 483365 replies=  5  …
CONFORMANCE 082aa784-….log fed= 317431 replies=  5  …
CONFORMANCE session:96486f13-….log fed= 265676 replies= 10  …
CONFORMANCE 9c3e506f-….log fed=  58612 replies=492  …
CONFORMANCE SUMMARY: 687 reply bytes across 12 of 12 logs
READINESS   SUMMARY: agree=12 disagree=0
BOUNDARY    SUMMARY: worst case 2 row(s) differ at a pathological chunk size
```

**687 reply bytes across 12 of 12 logs — byte-identical to the run recorded
above.** Same per-log counts (5 / 15 / 75 / 5 / 15 / 20 / 5 / 35 / 5 / 5 / 10 /
492), same readiness agreement, same boundary bound. The harness is
deterministic, which is what makes its `worst <= 2` assertion a usable gate.

### Q4 / Q5 re-measured on an idle machine — reproduced

| Probe | previous | ghostty | vs. the earlier run |
|---|---|---|---|
| `PTY_BULK_TUI_2MB` | Script 0.075 s, Task 0.868 s | Script 0.087 s, Task 0.276 s | matches (0.073/0.864 vs 0.076/0.252) |
| `IDLE_8S` | Script **0.015 s**, Task 0.941 s | Script **0.477 s**, Task 1.390 s | matches (0.018 vs 0.420) |
| Scroll | Script 0.079 s, Task 5.459 s | Script 0.930 s, Task 1.252 s | matches (0.082/5.899 vs 0.916/1.237) |
| Q5 | — | 7.06 MiB engine+1, **+5.21 MiB** per terminal, +0.06 MiB for 10 000 lines | identical to the digit |

Two things this adds. First, the idle-CPU concern is **reproducible, not
noise**: ~30× the script time to render one terminal that is not changing, and
ghostty is worse on *total* task time at idle too (1.39 s vs 0.94 s over 8 s),
which the earlier run did not record. Second, Q5 is stable to the digit across
runs and across a 50× scrollback span. Chromium still cannot clear any gate;
this is regression-detection data only.

### Q1 — narrowed by three observations, still OPEN

Measured on the real `pnpm build` output and on the real
`pnpm tauri build` bundle (both produced during this run;
`Phasr.app` and `Phasr_0.3.7_aarch64.dmg` built cleanly in 2 m 17 s):

1. **No `.wasm` file is emitted anywhere.** `find dist -name '*.wasm'` → empty;
   same inside `Phasr.app`. The built `ghostty-web-DswLBeJK.js` contains
   exactly one `new URL("data:application/wasm;base64,…")` and two
   `ghostty-vt.wasm` strings — the fallbacks, which have nothing to resolve to.
   The data: URL is the only route, and if it fails there is no second chance
   without the `public/` fix above.
2. **The chunk is embedded in the packaged binary and referenced relatively.**
   `strings src-tauri/target/release/phasr` lists
   `/assets/ghostty-web-DswLBeJK.js` alongside every other chunk (Tauri v2
   embeds the frontend in the executable rather than in `Contents/Resources`),
   and the importing chunk uses `import("./ghostty-web-DswLBeJK.js")` — a
   relative specifier that resolves against
   `tauri://localhost/assets/…`, exactly like every chunk the app already
   loads successfully today.
3. **There is no CSP to violate.** `src-tauri/tauri.conf.json` has
   `"security": { "csp": null }`, `index.html` carries no
   `<meta http-equiv="Content-Security-Policy">`, and `tauri` 2.11.2's
   `AppManager::csp()` returns `self.config.app.security.csp.clone()` in
   release, so `inject_csp` is never called. The `connect-src data:` /
   `wasm-unsafe-eval` failure mode this ADR predicted **cannot be triggered by
   phasr's own configuration**.

**What is still not known, and cannot be known from here:** whether WKWebView
itself will `fetch()` a `data:application/wasm` URL from a `tauri://localhost`
document and compile the result. That is a WebKit behaviour, not a
configuration, and nothing in Chromium or in a static bundle can answer it.

**The built `.app` was deliberately not launched.** Two reasons, both
disqualifying: it would open a GUI window that nothing here can drive, and —
decisively — **every route that constructs a terminal is behind sign-in**, so
even a launched app parked at the sign-in screen would never load
`factory.ts`'s preload, never fetch the data: URL, and produce no evidence
either way. Launching a release build would also point at the user's real
application data. A human at the app is required; the corrected steps are in
Q1 above.

### Found in passing: in-app link navigation is dead under the dev server

Not a terminal issue, but it surfaced while building the LRU test and it
matters for every future e2e:

`useExternalLinkOpener` installs a **capture-phase `window` click listener**
that intercepts any `<a href>` whose *resolved* `href` starts with `http://` or
`https://` and sends it to the OS. Under the dev server every in-app
`<Link to="/repositories/…">` resolves to
`http://localhost:1420/repositories/…`, so it matches. Observed directly:

```
SIDEBAR CLICK → opener invokes: [{"cmd":"plugin:opener|open_url",
                                  "args":{"url":"http://localhost:1420/repositories/repo-1/workspaces/ws-done"}}]
SIDEBAR CLICK → url:            http://localhost:1420/…/ws-agent   ← never moved
```

The app hands its own route to the OS and does not navigate. `preventDefault`
was traced to `useExternalLinkOpener.ts:13`; zero `history.pushState` calls
follow the click.

- **A packaged build is not affected**: the document is `tauri://localhost`, so
  `anchor.href` is `tauri://localhost/repositories/…`, the scheme guard returns
  early, and the `<Link>` works. (Derived from the guard's own source, not
  observed — see above for why the built app was not launched.)
- **`pnpm tauri dev` *is* affected**, because `devUrl` is
  `http://localhost:1420`. Clicking a workspace there should open a browser tab
  instead of switching workspace.
- **The e2e blind spot is the important part.** `ops.spec.ts` → "selecting a
  workspace navigates to it" passes only because it clicks in the window
  *before* the `useEffect` installs the listener; at any later point the same
  click is a no-op. Any future spec that navigates by clicking a link will
  silently do nothing. `terminal-lru.spec.ts` therefore navigates through the
  Command Palette, which navigates programmatically.

Not fixed here — it is outside this ADR's scope and the fix (scheme check
against the *document's own origin* rather than a literal `http` prefix) is a
one-line change that deserves its own review.

### Bottom line

**The two backends are at parity on every assertion the suite makes**, and the
suite now includes the LRU round trip and the chord table proved to have teeth
on the ghostty path. The known divergences are the ones this ADR already
names — copy-on-select (now observed rather than inferred), idle CPU
(reproduced), and apply-on-next-open `scrollback` — plus nothing new.

That still does not clear Phase 7. Parity in Chromium is necessary and not
sufficient; the renderer question is a WKWebView question, and Q1 and Q2 both
remain open on a human at a built `.app`.

### Commands run for this section

```
E2E_TERMINAL_BACKEND=<previous>   pnpm exec playwright test    120 passed, 6 skipped, 0 failed
E2E_TERMINAL_BACKEND=ghostty pnpm exec playwright test    119 passed, 6 skipped, 1 failed (see above)
PHASE0_PROBE=1 pnpm exec playwright test e2e/terminal-phase0.spec.ts   4 passed
pnpm typecheck                                            ✓
pnpm test                                    29 files, 252 tests      ✓
pnpm build                                                ✓
pnpm tauri build                             Phasr.app + .dmg         ✓
cargo test --manifest-path src-tauri/Cargo.toml           213 passed, 1 ignored
cargo test --manifest-path src-tauri/Cargo.toml -- --ignored   1 passed (real `claude`)
cargo test --manifest-path src-tauri/Cargo.toml --features vt-alacritty vt::   21 passed
```

`pnpm lint` is still pre-existing broken (`eslint: command not found`, no
config) and was not run.

---

## 2026-08-20 — hands on, three bugs, and the the previous engine removal

The user ran a real build for the first time and reported five problems. Two
were fixed before this section (in-app row clicks, sidebar dots). The other
three were all in the terminal, and all three turned out to be
`ghostty-web@0.4.0` rendering/input behaviour rather than phasr wiring. On the
strength of using it, the user also decided to delete the previous engine outright — which
collapses Phases 7 and 8.

Every claim below was checked. Where the diagnosis handed to this work was
wrong, that is stated.

### A. The wheel typed arrow keys into the agent

**Confirmed, and worse than the hypothesis.** `handleWheel`:

```js
if ((this.wasmTerm?.isAlternateScreen()) ?? !1) {
  const dir = g.deltaY > 0 ? "down" : "up",
        n = Math.min(Math.abs(Math.round(g.deltaY / 33)), 5);
  for (let i = 0; i < n; i++)
    dir === "up" ? this.dataEmitter.fire("\x1B[A") : this.dataEmitter.fire("\x1B[B");
}
```

Three facts, each established rather than assumed:

1. **Claude Code IS on the alternate screen.** Driving the real CLI in a pty
   (`claude` in a trusted directory, 120×40) it emits, in order:
   `\x1b[?2004h \x1b[?1004h \x1b[?2031h` **`\x1b[?1049h`** `\x1b[?1000h
   \x1b[?1002h \x1b[?1003h \x1b[?1006h`. So `TUI_MARKERS` in
   `src-tauri/src/pty/handle.rs` attributing `?1049h` to "codex, copilot,
   opencode" and only mouse tracking to claude understates it — claude sets
   both. (The marker list is still correct as a readiness signal; nothing
   needed changing there.) In a *fresh* directory the trust dialog appears
   first and none of these are emitted until it is answered.
2. **What the arrows actually do to claude.** Five `\x1b[A` into a live
   session opens the prompt-history overlay (`─── History 100/100 ───`) and
   replaces the input line with an old prompt. That is the user's "it scrolls
   the text inside claude": it was editing their prompt, not scrolling
   anything.
3. **What claude does with real mouse wheel events.** `\x1b[<64;40;20M` ×10
   into an empty session: **0 bytes back, nothing changes** — which is why the
   wheel appeared to do nothing on the previous engine. The same ten events into a session
   *with a transcript* (`claude --continue`): **4,846 bytes back, 33 lines
   changed, the transcript scrolled up**. So claude does handle the wheel; it
   simply had nothing to scroll in the first test.

the previous engine never sent those arrows, because `CoreBrowserTerminal.bindMouse()`
routes the wheel to `coreMouseService` whenever the app requested wheel events
and only falls back to cursor keys when it did not — and then **one** per
event, DECCKM-aware. That is the contract phasr shipped before the swap, and
`backends/ghostty/wheel.ts` restores it exactly:

| Terminal state | What we send now | Stock ghostty-web sent |
|---|---|---|
| mouse tracking on (claude, `vim` with `set mouse`, htop) | one SGR (`\x1b[<64;C;RM`) or X10 mouse event per tick | 0–5 arrow keys |
| alt screen, no mouse tracking (`less`, `vim`) | ONE arrow, `\x1bOA` under DECCKM else `\x1b[A` | 0–5 arrow keys, always CSI |
| normal screen | nothing — ghostty-web's own scrollback path runs | (already correct) |

The DECCKM half is not pedantry: real `less` sets `\x1b[?1049h\x1b[?1h`, and in
a pty it scrolls one line for `\x1bOB` and **does nothing at all** for
`\x1b[B`. Stock ghostty-web's wheel could not scroll `less` either.

Installed through `attachCustomWheelEventHandler`, a supported public hook that
runs first inside `handleWheel` — no dist patch. Sub-line trackpad deltas are
accumulated (`WheelAccumulator`) the way `CoreMouseService.consumeWheelEvent`
does, so a slow drag scrolls smoothly instead of in bursts.

**Honest note on what the user asked for.** They asked for the wheel to scroll
"the terminal logs". While claude owns the alternate screen there is no
scrollback to show — the primary screen's history is not reachable without
leaving the alt screen — so the wheel now scrolls *claude's own transcript*,
which is what every real terminal does and what the previous engine did. It does not inject
keys, and it never touches the prompt. The one thing no terminal can do is
show the pre-claude shell output while claude is running.

### The flicker — measured, not inferred

The hypothesis on offer was "repaint storm driven by the injected arrows" vs
"always-on rAF loop fighting repaint-on-scroll". Neither is the mechanism.

- The second has no mechanism in the source at all: `animateScroll` only
  mutates `viewportY` and fires events; the single `startRenderLoop` rAF is
  the only thing that paints. There is nothing to fight.
- The real cause: **ghostty-web ignores DEC mode 2026 (synchronized output).**
  The string `2026` does not appear anywhere in its bundle, and the render
  loop paints whatever is in the grid every frame. Claude brackets every
  repaint with `\x1b[?2026h` … `\x1b[?2026l` (visible in the pty capture), and
  a frame split across two PTY reads — normal, chunks break at read
  boundaries — was therefore painted half-applied. The erase half of an
  erase-then-redraw is a blank screen.

Measured in the app: with the terminal full of text, feeding
`\x1b[?2026h\x1b[2J\x1b[H` and sampling 80 ms later gave mean brightness
**0.1** (blank) against **104.6** painted — identical to the unsynchronized
control. The arrows made this constant rather than causing it: every arrow is
another full-screen repaint, so a wheel gesture produced a burst of frames,
each of which could tear.

Fixed in `patches/ghostty-web@0.4.0.patch`: the render loop skips painting
while mode 2026 is set, bounded by a 150 ms deadline so an app that sets the
mode and then hangs cannot freeze the display. After the fix the same probe
reads midSync **104.6** (old frame held), afterTimeout **0.0** (the bound
releases), afterSync **104.5**. `e2e/terminal-sync.spec.ts` asserts all four.

### B. Selection colours

**Confirmed, with one correction to the diagnosis.** The background half was
exactly as described: `renderCellBackground` returned early after filling
`selectionBackground`, so a selected cell never got its own background and our
translucent `--ansi-selection` composited with the line fill instead of the
cell.

The foreground half was **not** "`selectionForeground` is undefined and canvas
silently ignores the invalid `fillStyle`". The renderer merges the theme over
its own defaults (`this.theme = { ...defaults, ...A }`, in the constructor and
in `setTheme`), so `selectionForeground` was always defined — it was
`"#1e1e1e"`. Selected glyphs were really being repainted near-black on a dark
terminal, which is why selected output was unreadable rather than
unchanged. Measured on composited pixels with the patch reverted in
`node_modules`: selected bright-white text sampled **(30,30,30)**, i.e. exactly
`#1e1e1e`, and a selected blue-background run sampled **(69,36,28)** — the
wash over black, with the blue gone.

The patch adopts the previous engine's model: paint the cell's own background, composite the
selection colour over it, and leave the glyph alone unless a theme explicitly
sets `selectionForeground` (whose default is now removed, and whose meaning is
documented in the `.d.ts`). After: the same blue run samples **(132,155,212)**
against a predicted **(133,156,212)** for "blue with a 0.28 coral wash", and
selected full-block glyphs are byte-identical to unselected ones
(**(254,254,254)**) — the wash is the cell background and the glyph sits on top
of it, which is what the previous engine's WebGL renderer does too.
`e2e/terminal-selection.spec.ts` asserts both, computing the prediction from
`--ansi-selection` rather than a hardcoded colour.

### C. the previous engine removed

Deleted: the previous backend's modules, their tests, the
three npm dependencies of the previous engine, the
the previous engine stylesheet import and the the emulator's viewport scrollbar CSS, the
`localStorage["phasr.terminal.backend"]` flag and `VITE_TERMINAL_BACKEND`, the
factory's branch, both Command Palette engine-switch entries, the backend
parameterization across e2e (including the `expectBackend(page, <previous engine>)` "the
product default" assertion), and `e2e/terminal-bench.spec.ts` — a 620-line A/B
harness whose only purpose was comparing two engines, and whose headless
numbers were invalid anyway (see the Q4 withdrawal above).

`TerminalSurface` **stays**, along with the single-member
`TerminalBackendKind` and `data-terminal-kind`. It is what made this swap safe
and what makes the next one a diff. `grep -rn the previous engine src/ e2e/ package.json`
now returns only comments that explain why something is the way it is.

Renamed with the engine: the dispose helpers are now `disposeMainTerminal` / `disposeSessionTerminal`.

**Found while removing it, and fixed:** `useMacTextEditingKeys` excluded
terminals by testing a helper-textarea class check.
ghostty-web's hidden textarea has no such class, so with the engine swapped
that guard silently stopped matching and ⌘⌫ / ⌘← / ⌘→ were being handled as
text-field edits against the terminal's hidden textarea — in capture phase,
before the terminal saw them. It now matches phasr's own
`[data-testid="terminal-surface"]` container, which no engine change can
invalidate.

### Verification run

```
pnpm typecheck                                                        ✓
pnpm build                                                            ✓
pnpm test                                    28 files, 246 tests      ✓
pnpm exec playwright test                    106 passed, 5 skipped    ✓
cargo check --manifest-path src-tauri/Cargo.toml                      ✓
cargo test  --manifest-path src-tauri/Cargo.toml   213 passed, 4 ignored  ✓
node .claude/skills/tauri-backend/scripts/check-command-contract.mjs --all
                                             OK: 81/81 commands       ✓
```

`pnpm lint` is pre-existing broken (no eslint binary / config) and was not run.

Each new test was also run against the pre-fix code and observed to FAIL:

| Test | Pre-fix observation |
|---|---|
| `terminal-wheel.spec.ts` (mouse events) | 3 wheel ticks → **12 × `\x1b[A`** to the PTY |
| `terminal-selection.spec.ts` (wash) | selected blue bg **(69,36,28)**, selected text **(30,30,30)** |
| `terminal-sync.spec.ts` (2026) | mid-frame brightness **0.1** vs 104.6 painted |
| `ops.spec.ts` (in-app row click) | URL never changes — the click went to the OS opener |

### Still open, unchanged

Q1 (WASM under `tauri://localhost`) and Q2 (native Edit ▸ Copy) still need a
built `.app` and a human. Removing the previous engine does not change either, but it does
raise the stakes on Q1: there is no longer a second engine to fall back to if
the WASM cannot load in a packaged build. `docs/MANUAL-VERIFICATION.md` is the
checklist.

---

## 2026-08-21 — Q1 answered in the field, and the grapheme-split flicker

### Q1 is CLOSED. The WASM loads in a real packaged build.

The user ran `/Applications/Phasr.app` — a bundled build, installed 2026-08-21
00:53, whose binary contains `ghostty-web` — with **working terminals carrying
live PTYs**. That is the end-to-end evidence the probe could not supply: not a
`WKWebViewConfiguration` we built ourselves, but wry's own scheme handler and
the app's own CSP, serving the real `dist/`.

So every hop in the chain is now confirmed on real hardware: WebKit fetches the
inlined `data:application/wasm` URL from a custom-scheme document,
`WebAssembly.compile` is permitted, the patched `ghostty-web` constructs a
`Terminal`, and it paints a live shell. **The CSP failure mode this ADR spent
two sections predicting never materialised** — there is no CSP in
`tauri.conf.json`, and none was needed.

The release-blocking gate on Q1 is therefore lifted. `docs/RELEASE-0.4.0.md` §5
and `docs/MANUAL-VERIFICATION.md` should stop treating it as unknown. **Q2**
(native Edit ▸ Copy) is untouched by this and still needs a human.

### The flicker that survived the four earlier fixes

Reported still-present on a ⌘T session terminal after the 80×24 spawn fix, the
DEC 2026 latch fix, the replay-duplication fix and the grid-settle fix. A
24-frame screen recording showed a zsh prompt line alternating between two
renderings, and one frame with an inverse-video box over its first segment.

**The proposed cause — a frame painted while the parser sits mid-SGR — is
wrong, and was measured to be wrong.** Splitting a prompt inside
`\x1b[38;2;57;` … `197;207m` and inside `\x1b[1;36m` produces frames with
*fewer characters*, each correctly coloured; it never produces a fully-drawn
line with its colours missing. The parser is a state machine and a half-read
escape sequence yields **no cell at all**, so there is nothing for a frame to
paint wrongly. Also ruled out by direct pixel measurement, each on both
engines: `\x1b[27m`/`22m`/`23m`/`24m`/`29m` (all correct — an earlier reading
that SGR 27 leaked was a measurement artifact of counting default-foreground
*text* as an inverse *fill*), multi-parameter SGR, `fit()`/`resize`,
`repaint()`, and ⌘+/⌘−/⌘0 font changes.

**The real mechanism is a chunk boundary, but through the grapheme cluster,
not the SGR run.** The prompt carries `☁️` — U+2601 CLOUD **plus U+FE0F
VARIATION SELECTOR-16**, captured byte-for-byte from `zsh -l` under phasr's own
environment:

```
\x1b[1;33m☁️  \x1b[0m\x1b[1;33m(ap-south-1)\x1b[0m
```

Unlike an escape sequence, the base codepoint **is** a complete, paintable
cell: U+2601 alone is a one-cell monochrome dingbat drawn in the cell's
foreground, while U+2601 U+FE0F is a **two-cell colour bitmap that ignores
`fillStyle` entirely**. They are different glyphs, different widths and
different colours. The renderer's rAF loop is independent of `write()`, so a
frame landing between the two chunks paints the dingbat and corrects it a frame
later. Measured in the recording: the cloud is 135 ink px / 27 chromatic px in
the good frames and 46 / 0 in the bad ones — exactly the two glyphs, measured
independently on a canvas.

This is **not** the DEC 2026 bug: synchronized output is a program *asking* to
be double-buffered, and the fix there was to skip painting. Here nothing asks,
and there is no incomplete parser state to defer on.

#### Fix: hold the ambiguous tail, do not widen the coalescer

`src/lib/terminal/graphemeTail.ts` + `GhosttySurface.write()`. A chunk's
trailing bytes are held back **only** when a following chunk could still change
what they mean: an incomplete UTF-8 sequence, a trailing ZWJ, or a trailing
codepoint a variation selector is allowed to follow. They are written when the
rest arrives, or after 50 ms if the writer genuinely stopped mid-cluster.

Widening the Rust coalescer's 32 KiB / 8 ms window would also have worked and
was rejected: it adds latency to **every** keystroke echo to fix a case that is
one codepoint wide. Deferring the paint while the parser is mid-sequence — the
other candidate — does not address this at all, because the parser is *not*
mid-sequence; the cell is finished and simply not yet final.

The `Emoji=Yes` ranges are deliberately tight. Box drawing (U+2500–U+257F),
block elements (U+2580–U+259F) and Braille (U+2800–U+28FF) are what a TUI frame
is *made of*, and holding one of those per chunk would put a frame of latency
on every repaint. ASCII is never held, so keystroke echo is untouched.

`e2e/terminal-grapheme-split.spec.ts` asserts on composited pixels that **no**
animation frame ever shows the base codepoint alone, plus two guards: a writer
that stops mid-cluster still gets its glyph, and box drawing is not delayed.
Pre-fix it fails on both engines (3–4 frames painted the dingbat); post-fix
36/36 under Chromium and 36/36 under WebKit.

#### What is still unexplained

In the recording the *whole* prompt line — not just the cloud — reads as
default foreground in the bad frames, and one frame carries an inverse-video
box over the leading segment. That box is cells with `INVERSE` and no colour
(its background measures 225,234,241, and `--color-text-primary` is `#e6edf3`;
`renderCellBackground` swaps fg into bg for an inverse cell). Block-level
analysis rules out a video-codec artifact — 0 of 29 macroblocks lost chroma
while keeping luma, and a codec skips unchanged blocks with their chroma
intact — so it is a real render. **It did not reproduce** under either engine
while replaying the captured stream byte-for-byte at its real inter-chunk
timings, so its trigger is not in the byte stream alone. Closing it needs the
instrumented packaged app, not the mocked-IPC harness.

---

## 2026-08-21 (later) — the whole-line decolouring, and three hypotheses killed

Two more recordings, both from the packaged build that **contains** the
`graphemeTail` fix. So the `☁ → ▲` substitution here is not a grapheme cluster
split across chunks, and the grapheme fix does not cover this case.

Quantified rather than eyeballed, on the prompt-row band: healthy frames are
**mean chroma 79.7, 86.9% of ink pixels chromatic**; the bad windows are
**mean 5.5–6.0, 0.0% chromatic**, and each lasts a **full second**. Two
separate episodes, on two separate ⌘T opens, in two different workspaces. A
full second at 16 ms frames is not a race — the terminal is *in* that state.

### Killed: "the shell prints a plain prompt then a styled one"

Captured `zsh -l` in the recording's own worktree
(`48f9c3e5-…`, `phasr/hello-2`) with phasr's exact environment — `TERM`,
`COLORTERM`, `TERM_PROGRAM=kitty`, the env filter from `pty/shell.rs` — and
with the SIGWINCH phasr's settle timers produce. The prompt is emitted
**exactly once, fully coloured**:

```
\r\x1b[0m\x1b[27m\x1b[24m\x1b[J\r\n\x1b[1;36m48f9c3e5-…\x1b[0m on \x1b[1;35m…
```

There is no uncoloured pass. **It is not the user's shell.**

### Killed: "the palette resolves empty, so indexed colours fall back"

This was the leading theory and it is wrong, by measurement. `parseColorToHex`
in `ghostty-web` understands only `#rgb`, `#rrggbb` and `rgb(r, g, b)`, and
returns 0 for anything else. Feeding the real ⌘T path a palette of `rgba()`,
`oklch()`, named colours and CSS Color 4 `rgb(r g b)` gives **76.4% chromatic,
mean 49.4** — not 0%. A zero palette makes the engine fall back to **its own**
defaults, so the terminal stays colourful and merely stops matching phasr.

**A broken palette produces DIFFERENT colours, never NO colours.** Nothing in
the theme path can produce the observed state. (`--ansi-*` are plain hex, and
`readTerminalTheme` has hex fallbacks, so the palette was never empty anyway —
measured correct at rest and at each of three ⌘T opens.)

### Killed: "it reproduces on a freshly opened terminal"

Three ⌘T session terminals opened in sequence at runtime, each fed the captured
boot stream at its real inter-chunk timings, all render **87–88% chromatic,
mean ~100** — matching the recording's healthy baseline. No bad window, on
either engine.

Also excluded by reading the code: nothing re-emits VT-rendered text
(`session_terminal.rs` forwards raw `PtyEvent`s), `rgbToCSS` cannot produce an
invalid `fillStyle` from pooled JS cells, and `renderCellText` has no
`theme.foreground` path — a cell renders default white only if the WASM
resolved it that way.

### What that leaves

The cells carry default attributes although the bytes carried SGR. Every step
between those two facts has now been excluded outside the packaged app, and the
one environment that reproduces it is the one with **no instrumentation at
all**: `bridge.ts` is gated on `import.meta.env.DEV`, so a shipped `.app`
exposes nothing. Three recordings could only ever be measured in pixels.

`src/lib/terminal/diagnostics.ts` closes that. OFF by default (one
`localStorage` read per surface):

```js
localStorage.setItem("phasr.diag.terminal", "1"); location.reload();
// reproduce, then:
copy(JSON.stringify(window.__PHASR_TERM_DIAG__.dump(), null, 2));
```

Per surface it reports creation order (so "the Nth terminal" is answerable),
create/attach timestamps, the grid the engine was opened at, **the theme the
WASM palette was built from** and which entries `ghostty-web` cannot parse,
resize events, and the first 8 KB of PTY output escaped — with
`headHasSgrColour`, which answers "did the SGR reach this surface" without a
screen recording. That single field splits the remaining space in two: bytes
arrived with colour (engine/renderer) or they did not (delivery).

**Q2** (native Edit ▸ Copy) remains the only open spike question.
