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
