# Manual verification

Checks that **no automated suite in this repo can reach**. The Playwright suite drives
the real UI against a *mocked* IPC layer — it proves a flow fires the right command with
the right arguments, and nothing about the Rust side, the PTY, the OS, or real SQLite.
Everything below needs a human at a real build.

Run a real build first (`pnpm tauri dev`, or a bundled build where noted).

---

## Terminal clipboard — ADR-002 Q2 (0.4.0 gate)

Copy-on-select rewrites the clipboard at **mouseup**, which masks a dead ⌘C.
This isolates them:

1. Drag-select text in a terminal of the installed `.app`.
2. In another app, copy some *different* text.
3. **⌘Tab back to Phasr — do not click** (a click clears the selection).
4. Check **Edit ▸ Copy** is enabled, press **⌘C**, paste in Notes.
   - Terminal text → ⌘C works (rung 1; Q2 closed).
   - Other text → ⌘C is a no-op: run
     `localStorage.setItem("phasr.terminal.clipboardMirror","1")` in the
     inspector, reload, repeat (rung 2). Record the rung.
5. **Edit ▸ Paste** into a terminal pastes exactly once, not twice.

## Key mappings (branch: keymap work, 2026-08-04)

The keymap table is unit-tested byte-for-byte, but only a live PTY proves the agent and
the shell actually interpret those sequences.

### In an agent terminal running Claude Code

- [ ] **⇧↵** inserts a newline in the prompt instead of submitting it.
- [ ] **⌘⌫** clears the prompt line back to the start.
- [ ] **⌘←** / **⌘→** jump the caret to line start / end.
- [ ] **⌥←** / **⌥→** move by word; **⌥⌫** deletes the previous word.
- [ ] **⌘K** still opens the command palette (app shortcut not swallowed by the keymap).
- [ ] **⌘C** / **⌘V** still copy/paste via the native Edit menu.

### In a session terminal running zsh

- [ ] The same chords behave exactly as they do in iTerm with the natural-text-editing
      preset (this is the `hello.itermkeymap` parity check).
- [ ] `⌃A`/`⌃E`/`⌃U` still work directly (we didn't shadow them).
- [ ] Open `vim`, press **⇧↵** in insert mode: ESC+CR exits insert and opens a line.
      Known and accepted — scoping ⇧↵ to the agent terminal is a 2-line change if it bites.

### In app inputs (new-task form, commit message, settings fields)

- [ ] **⌘⌫** deletes to the start of the line; the field's React state updates (type
      something else afterwards — no reverted text).
- [ ] **⌘←/→** and **⇧⌘←/→** move and extend the selection to the line boundary.
- [ ] In a multi-line textarea these operate per **line**, not on the whole value.

### Cmd+Click links

- [ ] `echo https://example.com` in a terminal, then **⌘-click** it → opens in the
      default browser. A **plain** click only focuses the terminal.
- [ ] Produce a compiler error with a path (e.g. `pnpm typecheck` on a broken file) and
      **⌘-click** `src/…/file.ts:12` → opens in the configured editor at that file.
- [ ] With no default editor configured, ⌘-clicking a path shows the "No default editor
      configured" toast rather than failing silently.
- [ ] ⌘-click a path that doesn't exist → an honest error toast (the Rust `launch_app`
      rejects with "path does not exist"), no crash.

### Forms

- [ ] **⌘↵** in the new-task modal submits it, from *any* field, exactly once.

---

## Repository notes (branch: notes work, 2026-08-04)

Rust tests cover the SQL; e2e covers the flows against mocks. These are the gaps.

- [ ] **Persistence across relaunch (bundled build).** Create a note, quit the app fully,
      relaunch → the note is still there. Proves migration `0012` applies to a real,
      pre-existing user DB.
- [ ] **Repository-wide visibility, for real.** Create a note from a terminal in
      workspace A; open workspace B of the same repository → the note is listed with A's
      provenance. Open a *different* repository → it is not.
- [ ] **Repository removal soft-deletes.** Remove the repository, then inspect the DB:
      ```sh
      sqlite3 ~/Library/Application\ Support/<bundle-id>/phasr.sqlite \
        "SELECT id, deleted_at FROM repository_notes WHERE repository_id = '<id>';"
      ```
      Rows must still be present, every one with a non-null `deleted_at`.
- [ ] **Re-add is a clean slate (decided behavior).** Re-add the same repository → its old
      notes do *not* reappear, and the tombstones above are still in the table.
- [ ] **Dead provenance.** Create a note from an ad-hoc terminal, quit, relaunch → the
      provenance label still renders and the note is intact (the PTY id is unresolvable
      by construction — that is not a bug).
- [ ] **Concurrent edit.** Open the same repository in two windows, edit the same note in
      both, save the second → "changed in another window — reload and retry", and the
      first writer's text survives. No silent clobber.
- [ ] **Big paste.** Paste ~10k characters into a note → the panel scrolls, the app stays
      responsive, the note saves.
- [ ] **Light theme.** Switch to light and check the notes panel: the delete confirm's
      danger button, and a forced save-error strip, both read clearly (this is where the
      `--color-danger-text` token earns its place).
- [ ] **⌘⇧N** opens the rail on Notes and focuses the composer — from a workspace *and*
      from repo home, including while a terminal has focus.

---

## Terminal engine (ghostty-web, 2026-08-21)

ghostty-web is the **only** terminal engine. There is no backend flag and no second
engine to A/B against: `phasr.terminal.backend` and `VITE_TERMINAL_BACKEND` were
removed along with the previous engine, and rollback is a git revert rather than a
`localStorage` key — see `docs/adr/ADR-002-terminal-engine.md`.

Everything below is the release gate. **Q1 is closed; Q2 is the one spike question
that still needs a human.**

### ADR-002 Q1 — WASM under `tauri://localhost` — **CLOSED 2026-08-21**

Closed in the field rather than by probe: a packaged `/Applications/Phasr.app` ran
live terminals carrying real PTYs. WebKit does fetch the inlined
`data:application/wasm` URL from a custom-scheme document, `WebAssembly.compile` is
permitted, and the patched `ghostty-web` paints. The CSP failure this ADR spent two
sections predicting never materialised — there is no CSP in `tauri.conf.json` and
none was needed.

Re-check only if the bundling or the wasm-loading path changes:

- [ ] `pnpm tauri build`, open the `.app`, open a workspace.
- [ ] The terminal paints and accepts input.
- [ ] Webview console shows **no** `[terminal] ghostty engine failed to load`.
- [ ] If it ever regresses: note the CSP violation verbatim. The fix is either a
      `tauri.conf.json` CSP addition or shipping `ghostty-vt.wasm` from `public/` and
      passing its URL to `Ghostty.load(wasmPath)` in `preloadGhosttyEngine()`.

### ADR-002 Q2 — native Edit ▸ Copy / Paste (needs a real macOS menu bar)

ghostty-web has **no** `copy`/`cut` listener and its selection lives on a canvas, so
`Editor::canCopy()` may be false. Paste already has two listeners upstream plus ours.

- [ ] Drag-select terminal output → **Edit ▸ Copy** → paste into any other app. Works?
- [ ] **Edit ▸ Paste** into a shell terminal inserts the clipboard exactly once
      (not twice — three paste listeners exist and only ours should fire).
- [ ] ⌘C / ⌘V / ⌘X behave the way they do in iTerm / Terminal.app.
- [ ] If copy fails: `localStorage.setItem("phasr.terminal.clipboardMirror","1")`,
      reload, retry. **Record which rung was needed** — that is the answer to Q2.
- [ ] Note: ghostty **auto-copies on selection** (iTerm copy-on-select). Confirm this
      is acceptable; it is not phasr's current behaviour and is not opt-out-able.

### The behaviour matrix — the terminal features this branch had to re-implement

- [ ] ⌘-click a URL in agent output → opens in the default browser, once.
- [ ] ⌘-click a `src/foo.ts:12` → opens in the configured editor at the right file.
- [ ] Plain click on a link does nothing but place the caret.
- [ ] ⌘⌫ / ⌘← / ⌘→ / ⌥← / ⌥→ / ⌥⌫ / ⇧↵ inside Claude Code (the full keymap list above).
- [ ] **⌘K opens the Command Palette with the terminal focused.** ghostty-web
      `stopPropagation()`s every key it can encode; this is the regression that costs
      every document-level bubble shortcut in the app.
- [ ] Tab-switch ×20 between workspaces — no blank terminal, no lost scrollback.
- [ ] Window maximize, then restore. The grid is REBUILT at the new width (never
      reflowed) and the content stays where it was; the agent redraws at the right width.
- [ ] ⌘+ / ⌘− / ⌘0 with the terminal focused — font changes, grid reflows, nothing
      leaks into the PTY.
- [ ] Live theme toggle — the **grid** relights, not just the chrome.
- [ ] Resize the window slowly with 3 terminals open. No dropped fit, no stuck grid.
- [ ] **Start a task in a fresh directory** to exercise the trust-dialog path
      (`pty/handle.rs`, `run_initial_writes`) — the dialog eats text and treats Enter
      as "accept", which is why the prompt waits for its own echo before submitting.
- [ ] Open 9+ terminals to force an LRU eviction; the evicted one re-attaches with
      replay on next mount and its process is untouched.

### Perf — the real gate, and the only one that counts

`e2e/terminal-phase0.spec.ts` numbers are **Chromium**, and phasr's scroll history is a
WKWebView GPU-process-IPC problem Chromium does not reproduce. This is where the
release is actually decided.

- [ ] Scroll deep scrollback (3000+ lines). Is it smooth?
- [ ] Watch an agent repaint its TUI at speed. Does it keep up?
- [ ] **Idle CPU with 1 visible terminal, in Activity Monitor.** Chromium measured
      ghostty at ~23× the previous engine's idle script time because its rAF loop
      free-runs and a *visible* terminal cannot be paused. If that reproduces on
      WKWebView it is a battery regression and a blocker on its own.
- [ ] Idle CPU with 8 terminals open but only 1 visible (proves `setActive`/`pause()`).

---

## Always worth re-checking on a bundled build

- [ ] CSP: the bundled build (not dev) is where a too-strict policy bites — sign-in,
      external links, and any network call still work.
- [ ] Field styling after the `@layer base` fix: inputs, textareas, and selects across
      the app (new-task form, settings, run commands, history search, sign-in) render
      with the intended glass treatment and no double borders.

---

## 2026-08-28 — Perf Phase 0: measurement apparatus + Activity Monitor baselines

Phase 0 (`specs/perf-p0-measurement-baseline-spec.md`) landed the tools this
file's perf section has always needed. What a human at the GUI now has:

- **Dev perf HUD**: `localStorage.setItem("phasr.perf.hud","1"); location.reload()`
  (or `__PHASR_PERF__.enable()`) overlays keystroke→paint last/p50/p95, fps,
  bytes/s and parse backlog on every terminal. Dev builds only; cannot render
  in a bundled build.
- **IPC end-to-end bench**: `PHASR_IPC_BENCH=1 pnpm tauri dev` self-measures
  the real Rust→WKWebView channel hop (eval vs fetch path, base64+JSON vs raw)
  and prints `IPCBENCH` lines to the launching terminal, then exits.

**Activity Monitor baselines (spec criterion 5) — every row needs a human at
the GUI with a bundled build; UNRECORDED as of this entry.** The implementing
agent ran headless and could not drive the packaged app. Machine context for
whoever fills this: M1 Pro MBP 16 GB, 120 Hz display; the WebKit-proxy idle
figure to beat is 2.28 s of process-tree CPU per 8 s with one visible terminal.

| Case | % CPU (phasr process) | Date | Build |
|---|---|---|---|
| 1 visible terminal, idle | _unrecorded_ | | |
| 8 terminals open, 1 visible, idle | _unrecorded_ | | |

---

## 2026-08-29 — Perf Phase 1: damage-driven frame scheduling

Phase 1 (`specs/perf-p1-frame-scheduling-spec.md`) replaced the engine's
free-running ~60 fps rAF chain with a damage-driven scheduler: frames paint
only when requested (writes, blink, scroll/selection/hover, resize), the
chain degrades to a **~1 Hz heartbeat** after ~3 s idle (or while the window
is hidden/backgrounded), and floods run at ~30 fps. What only a human at the
GUI can verify:

- [ ] **The headline number**: Activity Monitor on a bundled build, 1 visible
      terminal at idle. Target ≤ 0.5% of a core (spec criterion 7); fill the
      Phase 0 table above while at it. The WebKit-proxy idle figure went from
      2.28 s to 1.25 s of browser-tree CPU per 8 s — and that residual is
      dominated by the probe's own 60 Hz rAF sampler, which a packaged build
      does not run: the engine itself sat at the ~1 Hz heartbeat (Chromium
      CDP script time 0.559 s → 0.050 s per 8 s). The packaged number should
      now be dominated by the app, not the terminal.
- [ ] Idle with the app **backgrounded** (⌘-tab away, window still visible):
      CPU should drop to ~0 within a few seconds — this is the Tauri
      `onFocusChanged` → `setBackgrounded` path, which no e2e can drive.
      Refocusing repaints immediately (no 1 s heartbeat lag visible).
- [ ] Cursor blink: blinks only in the focused terminal; an unfocused
      terminal's cursor is steady; blink stops while the app is
      backgrounded. Focus flips between two visible terminals move the
      blink with them.
- [ ] A TUI (claude, htop) after 5+ minutes untouched: first keypress paints
      instantly, no visible wake-up hitch, no watchdog console warnings.
- [ ] Streaming agent behind another app for a while, then revealed: content
      is current the moment it is revealed (occlusion floors the cadence,
      and the reveal repaints at once).

---

## 2026-08-29 — Perf Phase 2: renderer hot path (blit, run batching, one parse per frame)

Phase 2 (`specs/perf-p2-renderer-hot-path-spec.md`) made frames cheap: the
viewport is parsed once per frame instead of once per row, rows draw as runs
(one fillRect / one canvas-state change per run instead of per cell), blank
cells skip fillText, and an active scroll moves the surviving canvas region
with a self-`drawImage`, repainting only the newly exposed rows
(`getRenderStats().blits` counts these). What only a human at a packaged
WKWebView build can verify:

- [ ] **The flood headline (GANG gate follow-up)**: `cat` a 100 MB file in a
      terminal. The whole UI must stay interactive — switch tabs, scroll
      another terminal, type into the composer while it runs. The harness
      proxy says yes (in-page flood 18.4 MB/s at a held ~30 fps on the WebKit
      proxy, paint work per fully-dirty frame halved again on top of P1) but
      the mocked-IPC harness runs in a browser, not a WKWebView. If this
      disappoints, the spec's P2-c (GANG bulk-output fast path) reopens.
- [ ] **Scroll feel at depth**: fill tens of thousands of lines, wheel and
      drag-scroll through deep history at speed. Judgement call: smooth as
      iTerm2 on the same machine, no visible tearing at the blit seam, no
      shimmer at the top/bottom edges where exposed rows are drawn fresh.
      (Chromium/WebKit proxies show scroll frames indistinguishable from
      idle now; WKWebView's GPU-process IPC is the one this program actually
      targets and no suite can reach it.)
- [ ] **Blit correctness where eyes beat pixels-diff**: while scrolled into
      history with a selection held, keep output streaming (the anchored
      write path) and scroll further — the selection wash and the scrollback
      text must move together, no ghost rows, no doubled scrollbar. Then
      hover a URL in scrolled history and scroll: the underline must track
      its link.
- [ ] **Cursor blink economy** (criterion 7): an idle focused terminal shows
      a clean 530 ms blink (repaint per transition, not per frame); an
      unfocused one a steady cursor. DECTCEM: `printf '\e[?25l'` hides the
      cursor immediately, `\e[?25h` brings it back — the hide must not leave
      a frozen cursor cell behind.
- [ ] **Devanagari / grapheme spot check on the real webview**: `echo
      "नमस्ते किताब"` — vowel signs render intact (the two-pass constraint the
      run batching had to preserve), selection across it keeps the glyphs
      whole, at both 1x and retina.

---

## 2026-08-29 — Perf Phases 3 & 4: the PTY pipe (zero drop, then cheaper per byte)

Phase 3 (`specs/perf-p3-backpressure-zero-drop-spec.md`) made the byte stream
lossless: a bounded reader queue so a flood pushes back through the kernel to
the child, and a per-subscriber `LagRecovery` that refills anything the
broadcast dropped out of the per-task log by byte offset — `RecvError::Lagged`
is `continue` nowhere any more. Phase 4
(`specs/perf-p4-pipe-shrink-spec.md`) made each byte cheaper: chunks are
refcounted (`bytes::Bytes`) instead of copied into the replay buffer and again
per subscriber, big chunks cross the IPC as raw payloads with no base64 or
JSON envelope, the first read after a quiet gap flushes immediately, hidden
terminals coalesce on a 50 ms window, and an LRU-evicted terminal tears its
Rust forwarder down.

The automated evidence is Rust-side and quoted in both specs (80 MiB flood,
204 lagged events, 6.4 MB refilled, **0 unrecovered bytes**, delivered hash ==
log hash; the IPC bench through a real `Channel`). **The mocked-IPC e2e
harness cannot reach any of it** — it never spawns a PTY and never crosses an
IPC, so it proves only that the app handles the payload shape. What needs a
human at a packaged build:

- [ ] **The zero-drop claim, end to end** (P3's own entry): `cat` a 100 MB
      file in a packaged build. The UI must stay interactive throughout, and
      when it finishes the last screen must match `tail` of the same file —
      no hole, no truncation, no wrapped-wrong rows. This is the one that
      matters; every other box here is speed.
- [ ] **Echo feel** (P4 criterion 6, target p95 ≤ 1 frame + 10 ms): type into
      an idle shell and into a booted agent TUI. Keystrokes should feel
      immediate, not merely fast — the leading-edge flush removed up to 8 ms
      that used to sit in front of every echo, and only a human can say
      whether the remaining latency reads as instant on a 120 Hz display.
- [ ] **Eight agents streaming, one visible** (P4 criteria 7 and 8): start
      eight, look at one, leave it for a few minutes. Activity Monitor should
      show the app near the one-terminal idle figure, not eight times it.
      Fill the Phase 0 table above. Then reveal each of the other seven in
      turn: content must be current the moment it is revealed, with nothing
      missing from the middle of its output.
- [ ] **LRU eviction still costs only scrollback, never the process.** Open
      more terminals than `phasr.terminal.maxCached` (default 8), then come
      back to the oldest. Its agent must still be running and still
      responding — the forwarder was torn down, the child was not — and the
      terminal repopulates from replay. Console shows one
      `[terminal] evicted …` line per eviction and no errors.
- [ ] **Raw transport on the real webview.** This is the class of gap that let
      a 404 template URL ship: the Rust sender and the JS receiver have never
      met in any automated test. In a packaged build (not `tauri dev` — the
      CSP differs), run something dense and non-UTF-8: `cat` a binary file,
      then a full-screen TUI. Bytes must arrive verbatim — no replacement
      characters, no dropped escape sequences, no stalled repaints. A silent
      failure here looks like a terminal that stops updating under load.
- [ ] **Desync is visible if it ever happens.** Not reproducible by hand
      (it needs the log to rotate past an unread gap, ~96 MiB behind), so
      this is a "if you ever see it" note rather than a step: the screen
      clears and prints one dim `[phasr: N bytes of output were lost …]`
      line. If that ever appears in normal use, the log retention window is
      the thing to raise — it is not a rendering bug.
