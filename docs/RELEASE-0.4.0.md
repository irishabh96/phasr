# Release 0.4.0 — the Ghostty terminal engine

**Status: NOT RELEASED. Q1 is CLOSED (§5); remaining: the Q2 clipboard check (§5) and one decision (§7).**

This document plans the release. It does not perform it. Follow
[`RELEASING.md`](../RELEASING.md) for the mechanics — this file only supplies
what is specific to 0.4.0 and must be read alongside it, not instead of it.

Background: [`docs/adr/ADR-002-terminal-engine.md`](adr/ADR-002-terminal-engine.md).

---

## 1. What is in this release

Seven commits on `phasr/ghostty-terminal-engine`. The headline is that phasr's
terminal is a different emulator; everything else is a fix the user hit while
using it.

| Commit | Change |
|---|---|
| `3218ef1` | Remove workspace status dots from the sidebar |
| `e1eec6f` | **Replace the terminal engine with ghostty-web** |
| `4e93fd9` | Cursor settings (shape + blink) and word/line click selection |
| `52de98e` | Give the revealed terminal the keyboard on a tab switch |
| `6ea5411` | Stop clipping descenders in the sidebar workspace name and branch |
| `56e4a75` | Multi-agent load harness (test-only, `#[ignore]`d, `PHASR_LOAD=1`) |
| `1b726e4` | Drop a file on a terminal and get its path |

### Draft release notes

> **Phasr 0.4.0 — a new terminal engine**
>
> Every terminal in phasr now runs on **Ghostty**, via
> [`ghostty-web`](https://github.com/coder/ghostty-web). The previous emulator
> has been removed; there is one code path.
>
> **What you should notice**
>
> - **Faster bulk output.** Heavy TUI redraws cost roughly a third of the
>   main-thread time they used to.
> - **Selection is a proper wash again.** Selected output keeps its own
>   colours instead of being inverted, and selected text keeps its own colour
>   instead of being repainted near-black.
> - **Double-click selects a word, triple-click selects a line** — including
>   on spaces, punctuation and box-drawing characters, which previously did
>   nothing at all.
> - **Cursor shape and blink are now settings.** Settings ▸ Appearance ▸
>   Terminal. Block, bar or underline. Defaults are unchanged, so your
>   terminal does not move just because the control appeared.
> - **Switching tabs gives the terminal the keyboard.** Previously the
>   terminal was visible and correctly sized but typing did nothing until you
>   clicked it — and clicking often did not help either.
> - **Drop a file onto a terminal** and its path is typed in. It goes to the
>   terminal you dropped it on, not to whichever agent happened to be active.
> - **The sidebar no longer slices the bottom off letters** like g, y, p and q
>   in workspace names and branch names.
>
> **Behaviour change worth knowing about**
>
> - **Selecting terminal text now copies it to the clipboard immediately**
>   (iTerm-style copy-on-select). This comes from the new engine and is not
>   currently opt-out-able. It overwrites whatever was on your clipboard.
>
> **Under the hood**
>
> - Terminal output is carried from the backend as raw bytes rather than as a
>   lossy UTF-8 string, so non-UTF-8 output is no longer corrupted.
> - Terminal links are hardened: only `http`/`https` can be opened, and the
>   upstream engine's unvalidated `window.open` handlers are removed. See
>   ADR-002.
> - Daily local database snapshots (`~/.phasr/backups`, 7 kept) — **new in
>   this release**, see §6.
> - Third-party licence notices now ship inside the app (§7).

---

## 2. Version bump

Three files carry the version and are **not** derived from each other. A
fourth updates itself.

| File | Field | 0.3.7 → |
|---|---|---|
| `package.json` | `"version"` | `0.4.0` |
| `src-tauri/tauri.conf.json` | `"version"` | `0.4.0` |
| `src-tauri/Cargo.toml` | `[package] version` | `0.4.0` |
| `src-tauri/Cargo.lock` | `name = "phasr"` entry | regenerates on the next `cargo` command — commit the result |

```sh
# from the repo root, at release time (RELEASING.md step 1)
sed -i '' 's/"version": "0.3.7"/"version": "0.4.0"/' package.json src-tauri/tauri.conf.json
sed -i '' '0,/^version = "0.3.7"$/s//version = "0.4.0"/' src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml   # refreshes Cargo.lock
git commit -am "v0.4.0"
```

> **Careful with `Cargo.lock`.** Two entries read `version = "0.3.7"` — one is
> phasr, one is an unrelated crate that happens to share the number. Let cargo
> rewrite the file; do not hand-edit it.

**Not bumped in this branch.** `RELEASING.md` sequences the bump as the first
step of *cutting* a release on `master`, and the release is still blocked on
§5. Bumping now would produce a branch that calls itself 0.4.0 before it has
passed its gate, and a revert if the gate fails.

---

## 3. Upgrade safety — the checklist

The hard requirement: **anyone on 0.3.4, 0.3.5, 0.3.6 or 0.3.7 who updates
must not break.** This is not asserted, it is tested — see
`src-tauri/src/store/pool.rs`, module `version_compat`.

### Why the bar is this high

`82695bb` exists because a downgrade already aborted on launch:

```
Failed to setup app: migration error: migration 14 was previously
applied but is missing in the resolved migrations
```

sqlx refuses to open a database whose `_sqlx_migrations` table names a version
the binary does not ship. The panic happens inside the Tauri setup hook, which
runs in an `extern "C"` callback, so it hits `panic_cannot_unwind` and **aborts
before a window ever appears**. There is no in-app recovery from that state.

### Findings

| # | Surface | Verdict | Evidence |
|---|---|---|---|
| 1 | SQLite migrations | **SAFE** | 0.4.0 adds **zero** migrations. Its resolved set is 0001–0014, byte-identical to 0.3.7. Tested both directions. |
| 2 | `user_settings` (`cursorStyle` / `cursorBlink`) | **SAFE** | Both columns date from migration `0001`, `NOT NULL DEFAULT`. The new UI can only write `block` / `bar` / `underline`, which is exactly the set 0.3.x's own `normalizeCursorStyle` already accepts. |
| 3 | Cloud sync | **SAFE** | `src-tauri/src/sync/mod.rs` is untouched by this branch. No new field enters the payload. |
| 4 | App-data layout | **SAFE** | No new files or directories. |
| 5 | `localStorage` | **SAFE** | Two additive keys, both read inside `try`/`catch` with total fallbacks. |
| 6 | IPC / PTY wire format | **SAFE** | Base64 is a `serialize_with` on the IPC event only. Nothing persists it. |
| 7 | Third-party attribution | **FIXED** | Notices now ship inside the `.app`. |

### 1. Migrations — SAFE, tested

Migration sets per shipped tag (from `git ls-tree`):

| Version | Migrations | Latest |
|---|---|---|
| v0.3.4 | 12 | `0012_repository_notes` |
| v0.3.5 | 13 | `0013_notes_done_state` |
| v0.3.6 | 13 | `0013_notes_done_state` |
| v0.3.7 | 14 | `0014_machine_id_and_local_path_guard` |
| **0.4.0** | **14** | **`0014` — unchanged** |

`version_compat::every_shipped_0_3_x_database_upgrades_to_this_build` builds a
database with each version's *actual* migration subset, writes a repository
row into it, then opens it with the real `init_pool` and asserts the row
survived and the settings are readable. All four pass.

`version_compat::this_build_adds_no_migration_beyond_0_3_7` is the guard that
keeps this true: if anyone adds a migration, it fails with

> this build applied 15 migrations; 0.3.7 shipped 14. A new migration means
> 0.3.7 can no longer open a 0.4.0 database.

Both were **mutation-tested** — dropping a throwaway `0015_*.sql` into
`src-tauri/migrations/` makes all three fail, so they are not vacuous.

### 2. `user_settings` — SAFE

`cursor_style TEXT NOT NULL DEFAULT 'block'` and
`cursor_blink INTEGER NOT NULL DEFAULT 1` were in `0001_initial.sql`, and in
the cloud schema (`supabase/migrations/0001_initial.sql`) as `text` and
`boolean` with the same defaults and **no CHECK constraint**.

0.4.0 gains a *control* for them, not a column. The control offers exactly
`block | bar | underline`, and master's `normalizeCursorStyle` (in the removed
`xterm.ts`) accepted exactly that set with a `"block"` fallback — character for
character the same function as the new
`src/lib/terminal/options.ts::normalizeCursorStyle`. Neither throws on an
unexpected value; both fall back to `block`.

So a row written by 0.4.0 is readable by 0.3.x **and renders as intended**, not
merely without crashing.

### 3. Cloud sync — SAFE

The scenario that matters: 0.4.0 on one machine, 0.3.6 on another.

- `src-tauri/src/sync/mod.rs` does not appear in `git diff master..HEAD`. The
  push payload, the pull, and `CloudUserSettingsRow` are unchanged.
- The only values 0.4.0 can newly push are `cursor_style ∈ {bar, underline}`
  (it could already push `block`). The cloud column is untyped `text`, and
  0.3.6 normalises on read.
- No column is added, renamed or dropped on either side.

**Neither device can corrupt or reject the other's payload.**

### 4. App-data layout — SAFE

`~/Library/Application Support/sh.phasr.desktop/` still contains exactly
`phasr.sqlite` and `logs/`. `src-tauri/src/lib.rs` gains only module
declarations — two of them `#[cfg(test)]`. The `vt` module reads log files for
its test corpus and writes none; its engine is behind the non-default
`vt-alacritty` cargo feature and is not wired into `PtyHandle::spawn`.

### 5. `localStorage` — SAFE

Shipped 0.3.x only ever wrote `phasr.diff.viewMode` and `phasr.machine`.

**`phasr.terminal.backend` never shipped.** It was introduced and removed
inside this branch, so there is no stale key on any user's machine to ignore.
(It would be harmless anyway — nothing reads it.)

Added: `phasr.terminal.maxCached` and `phasr.terminal.clipboardMirror`. Both
are read inside `try`/`catch` and fall back to a default on garbage, on absence
and on storage being unavailable. `localStorage` has no schema, so a downgrade
simply ignores them.

### 6. IPC / PTY wire format — SAFE

`PtyEvent::Output.chunk` is now base64. This is a **serde `serialize_with`
attribute on the IPC event only**.

The on-disk log is written by `pump_pty_output` as
`log.write_all(&bytes)` — raw PTY bytes, before any framing decision — exactly
as master did with `log_file.write_all(slice)`. `read_task_log` reads those raw
bytes and applies `String::from_utf8_lossy`, unchanged.

**`<task>.log` is byte-identical in format across 0.3.x and 0.4.0.** A log
written by either is readable by the other. Nothing base64 reaches disk or the
network.

### 7. Third-party attribution — FIXED in this branch

**Was a real gap.** `THIRD-PARTY-NOTICES.md` existed only in the git
repository. The `.app` and the DMG contained no licence text at all, while
shipping two MIT works — `ghostty-web` (Coder) and the Ghostty WASM (Mitchell
Hashimoto and contributors). MIT requires the notice to be "included in all
copies or substantial portions of the Software"; a DMG is a copy.

Fixed by adding to `src-tauri/tauri.conf.json`:

```json
"licenseFile": "../LICENSE",
"resources": ["../THIRD-PARTY-NOTICES.md", "../LICENSE"],
```

Verified on a rebuilt bundle:

```
Phasr.app/Contents/Resources/_up_/LICENSE
Phasr.app/Contents/Resources/_up_/THIRD-PARTY-NOTICES.md
```

`alacritty_terminal` (Apache-2.0) is deliberately absent: it is `optional` and
`vt-alacritty` is not in `default`, so it is not compiled into a release build.

**Still open, not blocking:** there is no in-app attribution *surface*. The
About panel is `PredefinedMenuItem::about` with no licence list. The notice now
ships with the binary, which is what the licence requires; rendering it in the
UI is a follow-up.

---

## 4. Verification run

Everything below was observed on this machine, on `phasr/ghostty-terminal-engine`.

| Suite | Result |
|---|---|
| `pnpm typecheck` | **pass** |
| `pnpm build` | **pass** |
| `pnpm test` (vitest) | **263 passed** |
| `pnpm exec playwright test` (Chromium) | **118 passed, 5 skipped, 1 failed** — the failure is the pre-existing `base-branch.spec.ts` flake |
| `pnpm test:e2e:webkit`, terminal specs, `--workers=1` | **28 passed, 3 skipped, 0 failed** |
| `pnpm test:e2e:webkit`, full suite | 97 passed, 16 failed — **all failures pre-existing and non-terminal**, see below |
| `cargo check` | **pass** |
| `cargo test` | **216 passed, 0 failed** (213 + 3 new compat tests) |
| `cargo test -- --ignored` | **6 passed**, incl. `e2e_real_claude_prompt_submits` against the real Claude CLI |
| `check-command-contract.mjs --all` | **OK: 81/81** |
| `pnpm tauri build` | **pass** — `Phasr.app` + `Phasr_<version>_aarch64.dmg` |

`pnpm lint` is pre-existing broken (no eslint config) and was not run.

### WebKit is now part of the picture — and it earned its place

`playwright.webkit.config.ts` is new in this branch and had never been run
before. WebKit is WKWebView's engine, so it is the closest proxy to the
shipping runtime.

**It found a real bug — in the test, not the product.** The selection-wash
spec hardcoded a 70-column fixture. Chromium lays this app out at **77
columns**, WebKit at **69** (canvas text metrics differ). At 69 the run
wrapped, every row after it shifted by one, and the unselected control rows
sampled a wrap remainder and a blank line — both black — so the test failed
claiming the wash was broken. The fixture now derives its width from the live
grid.

With that fixed, WebKit gives the most valuable number in this release:

```
SELECTION bg plain=(88,166,255) selected=(132,156,212) predicted=(133,156,212)
```

The wash composites over a coloured cell background **correctly to within
1/255 on WebKit** — the engine phasr actually ships in, not Chromium. That is
direct evidence for the `patches/ghostty-web@0.4.0.patch` selection fix.

Two honest WebKit caveats:

- **Clipboard content cannot be asserted under WebKit at all.**
  `navigator.clipboard.readText()` throws `NotAllowedError`. The spec's old
  comment claimed WebKit "grants clipboard access to the focused page anyway";
  that was wrong and the first WebKit run disproved it. Those tests now skip
  with an accurate reason, which keeps ADR-002's Q2 honestly open.
- **Selected glyph colour drifts more on WebKit** — `plain=(228,228,228)`
  vs `selected=(235,232,231)`, against Chromium's exact `(254,254,254)` for
  both. Still inside the spec's `< 12` tolerance, but with less headroom.

### The 16 non-terminal WebKit failures are pre-existing

Baselined by checking out `master` into a worktree and running the same specs
under WebKit: **master fails 15 of `forms.spec.ts` + `notes-todo.spec.ts`**
under WebKit, a superset of the branch's failures. They are focus-ring,
dialog-interaction and `page.goto`-navigation-race issues in the harness, all
outside the terminal. They get *worse* with `--workers=1`, so they are
deterministic WebKit incompatibilities, not load flake.

**The WebKit suite is not a release gate in its current form.** The terminal
specs are, and they are green.

> **Trap worth recording.** Both Playwright configs hardcode
> `http://localhost:1420` with `reuseExistingServer: true`, so a dev server
> left running by *another worktree* silently serves the wrong code. A
> comparison run against `master` produced three confident false failures this
> way. Kill port 1420 between cross-worktree runs.

---

## 5. The gate, updated: Q1 is CLOSED — Q2 is what remains

**Q1 — will WKWebView fetch and compile the `data:application/wasm` URL under
`tauri://localhost` in a packaged build? — CLOSED, twice over.**

1. **The probe.** `scripts/wkwebview-wasm-probe.swift` stands up a real
   `WKWebView` with a `tauri:` scheme handler serving the real built `dist/`:

   ```
   Q1 {"stage":"origin","origin":"tauri://localhost","href":"tauri://localhost/"}
   Q1 {"stage":"fetched","status":200,"wasmBytes":423045}
   Q1 {"stage":"compiled","exports":77}
   Q1 {"ok":true,"stage":"ghostty-load","ctor":"q","terminal":"constructed"}
   ```

2. **The field.** From 2026-08-21 the user ran the packaged
   `/Applications/Phasr.app` — a bundle with no `.wasm` file and no fallback —
   for days of real work: terminals painted, agents ran, and the in-app
   diagnostics captured live PTY streams (ADR-002, seventh pass). That is the
   Q1 mechanism *and* the previously-open "base64 wire format meets a real
   emulator in one process" item, both exercised in production use. The probe's
   own caveat (its `WKWebViewConfiguration` is not wry's) is thereby retired:
   wry's configuration demonstrably serves the module.

**What remains open is ADR-002 Q2** — whether **Edit ▸ Copy** reaches a
terminal whose selection lives on a canvas. Narrow, and narrower than it
sounds:

- **Paste is field-evidenced.** ghostty-web's paste listener sits on the
  focused contenteditable container; the user pasted into a packaged-app
  terminal on 2026-08-21.
- **Copy's data path already works without ⌘C**: copy-on-select writes the
  clipboard at mouseup. The realistic failure is cosmetic-plus-confusing —
  Edit ▸ Copy greyed and ⌘C a no-op — because WebKit's `canCopy()` consults
  the DOM selection, which is collapsed while the real selection is painted
  on canvas. Rung 2 (`phasr.terminal.clipboardMirror`, already implemented)
  exists precisely to hand WebKit a genuine DOM selection.

### Closing Q2

The Swift harness is being extended to answer the two load-bearing questions
mechanically (`validateUserInterfaceItem(copy:)` with a collapsed selection in
a contenteditable; whether `sendAction(copy:)` dispatches a DOM `copy` event;
both again with the rung-2 mirror active). Its verdict decides the default
for `phasr.terminal.clipboardMirror`.

**The 2-minute human confirmation** (isolates ⌘C from copy-on-select, which
rewrites the clipboard at mouseup and would otherwise mask a dead ⌘C):

- [ ] Drag-select text in a terminal of the installed `.app`.
- [ ] In another app, copy some *different* text.
- [ ] **⌘Tab back to Phasr — do not click** (a click clears the selection).
- [ ] Is **Edit ▸ Copy enabled**? Press **⌘C**.
- [ ] Paste in Notes: the terminal text means ⌘C works (Q2 closed, rung 1);
      the other text means ⌘C is a no-op → set
      `localStorage.setItem("phasr.terminal.clipboardMirror","1")`, reload,
      repeat — record that rung 2 was needed.
- [ ] **Edit ▸ Paste** into a terminal pastes exactly once, not twice.

### Full release smoke pass (unchanged)

Run the built `.app`, **not** `pnpm tauri dev`; unsigned builds need
Gatekeeper bypass (right-click ▸ Open, see `README.md`).

- [ ] The app launches, reaches sign-in (exercises §3's migration path).
- [ ] Sign in, open a workspace with a running agent; the terminal paints.
- [ ] Type into the agent terminal; ⌘T opens a session terminal and keys go to
      *that* terminal.
- [ ] Resize the window; toggle the Changes panel and the sidebar — content
      keeps its row (ADR-002 pass 7).
- [ ] ⌘K still opens the palette with a terminal focused.
- [ ] Cursor settings: shape + blink update every open terminal immediately.
- [ ] Drop a file onto a session terminal — its path lands in *that* terminal.
- [ ] ⌘-click a URL opens the browser; plain click does not.
- [ ] Cross-check the keymap and link rows in
      [`docs/MANUAL-VERIFICATION.md`](MANUAL-VERIFICATION.md) — tracked as of
      this branch, so PR review sees it.

---

## 6. Rollback plan

### For the maintainer

The release is not tagged until the gate in §5 passes, so "rollback" before
that is just "do not tag". After tagging, delete the draft release and the
tag (`RELEASING.md`, Dry run).

Code rollback is `git revert` — the runtime backend flag is gone, which was
the deliberate trade for a single code path. `TerminalSurface` is still in
place and nothing outside `src/lib/terminal/backends/` knows which emulator is
running.

### For a user who upgrades and hits trouble

**Downgrading to 0.3.7 is safe and needs no backup.** 0.4.0 applies no
migration 0.3.7 lacks, so `_sqlx_migrations` after 0.4.0 is identical to after
0.3.7. Install the 0.3.7 DMG over 0.4.0 and the database opens.
`version_compat::this_build_adds_no_migration_beyond_0_3_7` asserts exactly
this, and fails the build if a future change breaks it.

**Downgrading below 0.3.7 will abort at launch.** Released 0.3.4 / 0.3.5 /
0.3.6 ship at most 13 migrations, and any database that has seen 0.3.7 *or*
0.4.0 has `0014` applied. sqlx refuses it and the app dies before drawing a
window — `version_compat::rolling_back_past_0_3_7_is_refused_by_sqlx` pins that
boundary deliberately.

> This is **inherited from 0.3.7, not introduced by 0.4.0.** The same wall
> already exists today for anyone on 0.3.7. `82695bb` fixed it for 0.3.5 on
> `master`, but that fix has never been released — the **released** v0.3.5 DMG
> still carries only 13 migrations.

**Consequence, stated plainly:** a 0.3.4/0.3.5/0.3.6 user who upgrades to
0.4.0 crosses a one-way door for their *local database*. Going back further
than 0.3.7 is not possible without restoring a copy.

**And no shipped 0.3.x version ever took a backup.** `backup_rotate` is on
`master` but postdates the v0.3.7 tag — verified across all four tags. **0.4.0
is the first release that snapshots the database at all** (daily, 7 kept, in
`~/.phasr/backups`, deliberately outside the app-data directory that a previous
upgrade wiped). 0.4.0's first snapshot is taken *after* migrations, so it is
not a pre-upgrade image.

**Therefore the release notes must tell 0.3.4/0.3.5/0.3.6 users to copy their
database before updating:**

```sh
cp -a ~/Library/Application\ Support/sh.phasr.desktop/phasr.sqlite \
      ~/phasr-backup-before-0.4.0.sqlite
```

Restoring is the reverse copy with the app closed. Cloud-synced data (settings,
repositories, workspaces, notes) re-pulls on sign-in regardless; the local
database is the part at risk.

---

## 7. Open items before tagging

| # | Item | Blocking? |
|---|---|---|
| 1 | §5 — Q2 clipboard check (Q1 and the base64 path are CLOSED, field-evidenced) | **YES** |
| 2 | Decide whether copy-on-select is acceptable as a silent default | Judgement call |
| 3 | In-app attribution surface (About ▸ licences) | No — notices ship (§3.7) |
| 4 | ghostty idle CPU: ~5% of a core per *visible* terminal, from an always-on rAF loop | No — measured, documented, has no fix short of upstream |

### Note on the build environment

`rust-toolchain.toml` is **new in this branch** and pins `channel = "1.96.0"`.
`release.yml` uses `dtolnay/rust-toolchain@stable` with
`targets: aarch64-apple-darwin`; rustup will honour the pin and download 1.96.0
on the runner. That works today because the runner's host target *is*
`aarch64-apple-darwin`, so the `targets:` line is redundant. **If an x86_64
matrix entry is ever added, that target would be installed against `stable`
and not against the pinned 1.96.0, and the cross-build would fail.**

### Signing

Builds remain **unsigned and un-notarized**. Users need the Gatekeeper bypass
in `README.md`. `RELEASING.md` ▸ "Code signing (future)" lists the six secrets
required to change that; `tauri-action` picks them up with no workflow rewrite.
