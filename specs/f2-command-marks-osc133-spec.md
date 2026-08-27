# Spec: Track F2 — Command marks, exit codes, navigation (OSC 133)

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** F (features) · **Ships as:** 0.5.x · **Size:** ~6–8 days
**Depends on:** **Spike S1** (blocking — the parse layer), perf Phase 3 landed
**Provenance:** derived from a local iTerm2 source read, 2026-08-27
(`VT100Terminal.m:4818` is the reference semantics).

## Objective

Turn an agent's 10 000-line stream into a **navigable list of command results**: where each
command started, what it was, where its output ends, whether it succeeded, and how long it
took.

## User story

- As a developer reading a long agent transcript, I want to jump between commands and see
  which failed, so I can find the interesting part without scrolling.
- As a developer who spotted a failing command, I want to select exactly its output, so I can
  paste it somewhere without hand-dragging across 200 lines.
- As a developer, I want to know what a command was, where it ran, how long it took and what
  it returned — without scrolling back to its prompt.

## Three layers

### 1. Emit — shell integration injected into spawned shells

Injected via the `terminal_env()` seam (`src-tauri/src/pty/shell.rs:73`, called from
`src-tauri/src/pty/handle.rs:172`):

- **zsh**: a `ZDOTDIR` wrapper directory whose `.zshrc` sources the user's real config
  **first**, then installs our `precmd`/`preexec` hooks.
- **bash**: `--rcfile` pointing at a wrapper that sources the user's rc then installs
  `PROMPT_COMMAND` / `DEBUG` trap hooks.

Emit **OSC `133;A/B/C/D`** with **`aid=` and `k=` from day one** (not as a later extension —
see the decision below), plus **OSC 7** for cwd.

Semantics to implement (reference: `VT100Terminal.m:4818`):

| Sequence | Meaning |
|---|---|
| `133;A` | Prompt start. `k=` gives the **prompt kind** (e.g. initial vs. continuation vs. secondary) |
| `133;B` | Prompt end / command input starts |
| `133;C` | Command output starts (the command has been executed) |
| `133;D` | Command finished. `D;<n>` carries the exit code |
| `aid=` | Per-command / per-shell id, on every sequence |

Two compatibility rules that are **not optional**, because real shells emit both:

- **`D` without a preceding `C` → the abort path.** The command never ran (user hit ^C at
  the prompt, or the line was empty). It must not produce a command with output.
- **`D;<garbage>` → treat as exit 0.** Legacy emitters send non-numeric payloads; iTerm2
  accepts them as success rather than dropping the mark.

### 2. Parse — S1's engine hook

The S1 patch surfaces `(sequence, params, absoluteRow)` at parse time. **Absolute row must
come from the engine** (`scrollbackLength + cursorRow`) at the moment of parsing, not be
resolved by JS on receipt.

If S1 returned FALLBACK (Rust-side scanner), this layer instead consumes control-channel
events and resolves rows at receipt — with the documented precision loss under flood. See the
uncertainty section.

### 3. Store + render — the frontend mark store

- Mark store keyed by **absolute row**.
- Margin glyphs: a success/error dot per prompt, using design-system theme tokens, meeting
  **AA contrast on both themes**.
- Navigation: **⌘↑ / ⌘↓** jump between prompts.
- **Select command output**: an action that selects exactly the `C`→`D` extent.
- **Command info popover**: command text, cwd (from OSC 7), duration, exit code.

## #PATH_DECISION — `aid=` and `k=` ship in v1, not as a follow-up

The tempting v1 is bare `133;A/B/C/D`. **Rejected.** phasr's defining workload is agents, and
**agents spawn nested shells constantly** (`zsh -c`, `bash -lc`, tool wrappers). Without
`aid=`, a nested shell's marks interleave with the outer shell's and there is no way to tell
which `D` closes which `C` — the resulting mark list is garbage, and worse, it is *plausible*
garbage.

`aid=` enables the **cascade close**: when a shell exits, every still-open command belonging
to that `aid` (and its descendants) closes, rather than dangling forever.

`k=` (prompt kind) is needed to avoid treating a continuation prompt (`> ` after an unclosed
quote) as a new command.

**Decision: emit and parse `aid=` and `k=` in v1.**

## #PLAN_UNCERTAINTY — reflow: the plan's premise is wrong, and this is the hard problem

The plan assumed "resize remaps rows … remap marks through the same offsets `reflow.ts`
computes". **`reflow.ts` computes no offsets.** Verified against
`src/lib/terminal/reflow.ts` and `src/lib/terminal/serialize.ts`, the actual policy is:

`planResize(current, target)` (`reflow.ts:39`) returns one of three plans (`ResizePlan`, :23):

| Plan | When | Effect on absolute rows |
|---|---|---|
| `"none"` | grid already matches | none — marks are safe |
| `"resize"` | **rows changed, columns did not** | nothing rewraps; ADR-002 measured a rows-only round trip leaves scrollback untouched — **marks are safe** |
| `"rebuild"` | **the width changed** | the grid is **thrown away and rebuilt at the new width**, re-fed from serialized cells — **every absolute row is invalidated** |

The rebuild exists because `ghostty_terminal_resize` takes `(handle, cols, rows)` and **no
anchor**, and every width round trip permanently converts trailing blank rows below the
cursor into leading history rows above it (`reflow.ts` header). And the re-feed uses
`serialize.ts` — *cells*, not the raw byte ring — because "a byte stream is only true at the
geometry it was written for": replaying raw bytes at a narrower width strands a reverse-video
`%` from zsh's `PROMPT_EOL_MARK` once per prompt (measured: 0 such rows at 122 columns, **22**
at 77).

So on a width change there is no old-row→new-row mapping to compute: **the content itself is
regenerated at a different wrap, so the row count changes unpredictably.**

Also relevant: `serialize.ts` explicitly does **not** preserve attributes the renderer cannot
see — it names OSC 8 hyperlink targets as lost, because ghostty-web 0.4.0's
`getHyperlinkUri` returns `null`. **OSC 133 marks are in the same category**: unless the mark
store survives the rebuild independently, a width change destroys the whole mark history.

Options, in preference order — **an architect must choose before implementation**:

1. **Anchor marks to content, re-locate after rebuild.** Store, per mark, a hash of its
   prompt line (plus the `aid=`), and re-locate by scanning the rebuilt buffer. Exact for
   distinct prompt lines, ambiguous for repeated ones; O(scrollback) per width change, which
   is at most once per settled resize (perf P5 collapses the 13-calls-per-toggle storm).
2. **Carry marks through `serialize.ts`.** Emit marks as OSC 133 in the serialized byte
   stream so the rebuild re-parses them into their new rows for free. Elegant and exact —
   but it extends the serializer's contract (which today deliberately emits "nothing
   absolute, nothing width-derived") and depends on the S1 parse hook running during the
   rebuild replay.
3. **Invalidate marks on width change**, keep them across rows-only resizes. Cheap and
   honest, but loses the history a user resized *while reading*. Poor fit for the primary use
   case.

Option 2 is the most attractive if S1 returned PATCH; option 1 is the safe default.
`e2e/terminal-reflow-anchor.spec.ts` and `src/lib/terminal/reflow.test.ts` are the existing
guards and the natural home for the assertion in criterion 8.

## #PLAN_UNCERTAINTY — S1's outcome changes this spec's ceiling

If S1 returns **FALLBACK**, criterion 3's row precision under flood cannot be met as written.
That relaxation must be signed off explicitly, with the measured precision loss from S1's
Decision section quoted here, before F2 starts.

## #EXPORT_CRITICAL — we are injecting code into the user's shell startup

The zsh/bash wrappers run in the user's shell, in their repository, with their environment.

1. **Source the user's real config first, and never replace it.** A user whose `.zshrc` stops
   working because phasr spawned their shell is a severe bug. The wrapper must degrade to a
   plain shell if anything in our hook fails.
2. **Never overwrite user files.** The wrapper lives in a phasr-owned temp/app-data directory
   referenced via `ZDOTDIR`/`--rcfile`. Nothing is written into the user's repository or home
   dotfiles. (Contrast S2's route C, which is explicitly a last resort for the same reason.)
3. **The wrapper must not leak into child processes it shouldn't own.** Confirm `ZDOTDIR`
   does not persist into unrelated shells the user later launches from that session in a way
   that surprises them.
4. **Command text is data.** Command strings captured for the popover are rendered as text,
   never re-executed, never interpolated into a shell string, never used as a git argument.
5. **Nothing is synced.** Command text and cwd may contain repository paths and secrets typed
   at a prompt; they stay local in this version.

## Acceptance criteria

1. **Marks appear for real commands.** Running 3 commands (one of which fails) in a phasr
   terminal produces exactly 3 marks with the correct exit codes.
2. **Navigation order is correct.** ⌘↑ / ⌘↓ visit prompts in stream order, and a command mark
   scrolls **to the top** of the viewport — so the command's output is visible below it. (This
   is an iTerm2 detail worth keeping; scrolling a mark to centre or bottom hides the thing the
   user navigated to see.)
3. **Select-command-output extent is exact**: the selection covers `C`→`D` and includes
   neither the prompt line nor the next prompt.
4. **Nested shells produce no orphan marks.** An agent running `zsh -c '...'` inside a phasr
   terminal produces marks that close correctly; the `aid=` cascade-close is asserted by
   exiting a nested shell with a command still open.
5. **`D` without `C` produces an abort, not a command.** Asserted.
6. **`D;<garbage>` is treated as exit 0.** Asserted.
7. **Continuation prompts are not new commands.** A multi-line command (unclosed quote →
   continuation prompt) produces one mark, not two. Driven by `k=`.
8. **Resize preserves mark anchoring** per the reflow decision above. Split explicitly,
   because the two cases are not alike:
   - **rows-only resize** (`ResizePlan = "resize"`): marks are unaffected — asserted.
   - **width change** (`ResizePlan = "rebuild"`): marks survive per the chosen option, or —
     if option 3 is chosen — are *deliberately and visibly* cleared rather than left pointing
     at wrong rows. Silently wrong marks fail this criterion.
9. **Command info popover** shows command, cwd, duration and exit code, populated from OSC 7
   + the `C`/`D` timestamps.
10. **Margin indicators meet AA contrast on both themes**, verified with the design-system
    contrast check. (The light theme has a documented history of failing AA at the token
    level — do not assume.)
11. **A user's own shell config still works.** A terminal spawned with the wrapper sources the
    user's `.zshrc`/`.bashrc`, and a wrapper failure degrades to a working plain shell rather
    than a broken one.
12. **No performance regression.** The 0.4.2 targets still hold with marks enabled; in
    particular the flood target (`cat` of a 100 MB file stays interactive) — a per-write OSC
    scan must not reintroduce the cost P2 removed.

## Stretch (separate PR, not part of this spec's acceptance)

**Pinned offscreen command line**: when the running command's prompt scrolls off the top, pin
its text as a floating first row.

## Implementation notes — verified entry points

| Piece | Location |
|---|---|
| PTY env seam for shell-integration injection | `src-tauri/src/pty/shell.rs:73` `terminal_env`; call site `src-tauri/src/pty/handle.rs:172`; env-shaping test at `shell.rs:233` |
| Shell resolution / spawn candidates | `src-tauri/src/pty/shell.rs` — `resolve_shell`, `spawn_candidates`, `should_pass_env` |
| Surface API (where OSC events land) | `src/lib/terminal/surface.ts` — `TerminalSurface` (:114), `write()` (:126), `onData()` (:129) |
| Backend implementation | `src/lib/terminal/backends/ghostty.ts` |
| Existing OSC precedent in the engine | OSC 8 hyperlinks via `OSC8LinkProvider` (`node_modules/ghostty-web/dist/index.d.ts:1262`); OSC 0/1/2 titles via a JS string scan, `dist/ghostty-web.js:3105` called from `write()` at `:2495` |
| Where the S1 patch would hook | see `specs/iterm2-spike-s1-ghostty-osc-surface-spec.md` |
| Reflow policy | `src/lib/terminal/reflow.ts` — `Grid` (:18), `ResizePlan` (:23: `"none"` / `"resize"` / `"rebuild"`), `planResize` (:39); tests in `reflow.test.ts`, e2e in `e2e/terminal-reflow-anchor.spec.ts` |
| Rebuild source (what a width change re-feeds) | `src/lib/terminal/serialize.ts` — cells → bytes; explicitly drops attributes the renderer cannot see |
| Resize settle debounce | `src/lib/terminal/settle.ts` — `QUIET_MS = 120` (:11), `whenGridSettles` (:38) |
| Selection primitives to reuse | `src/lib/terminal/selection.ts` — `classifyChar` (:40), `runAtColumn` (:62), `logicalLineRange` (:97) |
| Scrollback sizing (absolute-row space) | `src/lib/terminal/options.ts:40` `UNLIMITED_SCROLLBACK_BYTES = 1_073_741_824` |
| Keymap layer for ⌘↑/⌘↓ | `src/lib/terminal/keymap.ts` + `keymap.test.ts`; e2e `e2e/terminal-keymap.spec.ts` |
| Theme tokens for margin glyphs | `src/lib/terminal/theme.ts`, `themeTokens.ts`, `src/index.css` |

**Keymap warning (learned the hard way):** key bindings here failed three times before,
because **two layers** are involved — xterm-style handling ignores meta keys, and the webview
does not run macOS text-editing actions by default. Ask "which layer owns ⌘↑?" before writing
a handler. `src/lib/terminal/keymap.ts` is the layer that already answers this.

**Tailwind warning:** an unlayered element reset in `src/index.css` beats every utility class
and has silently killed component styling twice. Margin indicators must be verified rendered,
not merely written.

## Test / evidence plan

- **Rust** (`cargo test`): the shell-wrapper generation (correct `ZDOTDIR`/`--rcfile`
  content, user config sourced first, hooks appended, no user file written), and env shaping
  through `terminal_env`.
- **vitest** (`pnpm test`): the mark store as a pure reducer — the whole OSC 133 state machine
  fed by synthetic event sequences. This is where criteria 4–7 are cheapest and most
  thoroughly proven: nesting, `aid=` cascade-close, `D`-without-`C`, `D;garbage`,
  continuation prompts. Also the reflow remap function.
- **Playwright** (`e2e/harness.ts`): the UI half — write OSC 133 byte sequences directly into
  the surface and assert mark count, exit codes, navigation order, selection extent, popover
  contents, and mark anchoring across a resize. Run under `pnpm test:e2e:webkit` too for the
  margin-glyph rendering.
- **Limitations, stated:** (a) the mocked-IPC harness **cannot** prove the shell integration
  actually installs in a real zsh/bash, because it never spawns a PTY — criterion 11 and the
  real-shell half of criterion 1 are **manual**; (b) if S1 returned PATCH, the harness *can*
  exercise the patched engine (it writes bytes to a real surface), but the patch itself needs
  a `docs/MANUAL-VERIFICATION.md` entry because a bundled build's CSP and packaging differ.
- **Manual:** real agent run against `github.com/irishabh96/test-repo` — 3 commands including
  a failure and a nested `zsh -c`; verify marks, navigation, popover, and that the tester's
  own shell config still works. Add the checklist entries.

## Out of scope

Folding command output (**F5**, and design-gated) · the pinned offscreen command line
(stretch, separate PR) · notifications on command completion (**F3**) · searching marks
(**F4**) · OSC 1337 session variables · shell integration for shells other than zsh and bash
· installing shell integration into the user's *own* shells outside phasr.
