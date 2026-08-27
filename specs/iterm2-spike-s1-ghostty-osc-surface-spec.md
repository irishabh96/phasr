# Spec: Spike S1 — ghostty-web OSC hook surface

**Status:** DECIDED — PATCH (see Decision, 2026-08-27) · **Author:** BSA (agent) · **Date:** 2026-08-27
**Type:** Spike (time-boxed investigation) · **Timebox:** ½ day
**Gates:** Track F2 (command marks). Blocks nothing else.
**Provenance:** derived from a local iTerm2 source read, 2026-08-27.

## Question to answer

**Can `patches/ghostty-web@0.4.0.patch` surface OSC dispatch — specifically OSC 133 — to
JavaScript as `(sequence, params, absoluteRow)` at parse time; and if so, where is the
cleanest hook point?**

"Absolute row" means the row index in the unbounded scrollback coordinate space
(`scrollbackLength + cursorRow` at the moment the sequence is parsed). It must come from the
engine at parse time — resolving it later from JS is racy, because a flood can push many
lines into scrollback between parse and receipt.

## Why the question is open

Verified against the installed patched dist (`node_modules/ghostty-web/dist/ghostty-web.js`,
3 271 lines, with `patches/ghostty-web@0.4.0.patch` applied by pnpm `patchedDependencies`):

- The only JS-visible OSC handling is **OSC 8 hyperlinks**, and it is not a dispatch hook —
  `OSC8LinkProvider` (`dist/index.d.ts:1262`) scans rendered cells for a `hyperlink_id` the
  WASM core already attached.
- Titles (**OSC 0/1/2**) are recovered by a *string scan of the written chunk in JS*, not by
  a parser callback: `checkForTitleChange` (`dist/ghostty-web.js:3105`), invoked from
  `write()` at `dist/ghostty-web.js:2495` only when the data is a string containing `\x1b]`.
  That path is lossy for us (we write `Uint8Array`) and carries no row information.
- `processTerminalResponses()` (`dist/ghostty-web.js:3095`) drains device responses the core
  produced — a candidate hook point *if* the Zig core queues OSC 133 there.
- Nothing in the bundle references `133`. Ghostty's Zig core understands semantic prompts
  upstream; whether that reaches this WASM build is exactly the unknown.

## Method (½ day, in order — stop as soon as a decision is reachable)

1. **Probe the core.** Write `\x1b]133;A\x07`, `\x1b]133;B\x07`, `\x1b]133;C\x07`,
   `\x1b]133;D;1\x07` into a live surface in a scratch harness. Inspect: does the WASM term
   swallow them silently, echo them as text, expose them via
   `processTerminalResponses()`, or leave anything on a cell/row? Record the observed
   behaviour verbatim.
2. **Locate dispatch.** Search the WASM export surface (`dist/index.d.ts`, the `wasmTerm`
   binding used at `dist/ghostty-web.js:2495`) for any OSC/CSI callback seam. Determine
   whether an OSC handler can be registered from JS without rebuilding the Zig core.
3. **Cost the patch.** If a seam exists, sketch the patch hunk: an emitter
   (`oscEmitter.fire({ sequence, params, absoluteRow })`) fired from the same place `write()`
   already fires `bellEmitter`, with `absoluteRow` read as
   `getScrollbackLength() + getCursor().y` **before** the write's viewport anchoring runs
   (`anchorViewportAfterWrite`, same line). Estimate hunk size and upstreamability.
4. **Cost the fallback.** If no seam exists, cost the Rust-side scanner (below).
5. **Write the decision** into this file's Decision section and stop.

## #PLAN_UNCERTAINTY — the fallback if ghostty-web cannot be patched for OSC

**Fallback:** a Rust-side OSC scanner on the coalescer thread
(`coalesce_pty_output`, `src-tauri/src/pty/handle.rs` — the loop that today does
`log.write_all(&bytes)` at line 745 before buffering), emitting mark events on a small JSON
control channel; the frontend resolves the row via an engine query at receipt.

Known weakness, stated so nobody rediscovers it in review: **it is racy under flood.** Rows
resolved at receipt lag the parse by up to one coalesce window plus one IPC hop, and under
`cat bigfile` that is thousands of lines. It also must handle a sequence split across two
PTY reads (the scanner needs a carry buffer, exactly like the grapheme tail in
`src/lib/terminal/graphemeTail.ts`).

**Prefer the patch.** The fallback is a degraded F2, not an equivalent one — if it is the
only option, F2's acceptance criteria for mark-row precision under flood must be relaxed and
the architect must sign that off explicitly.

**Narrowed by the Q1 decision (architect, 2026-08-27).** F2's reflow behaviour no longer
depends on this spike's outcome: marks are re-anchored across a width change from the rebuild
*replay*, using the emulator's own cursor report, with no parse hook involved
(`specs/f2-command-marks-osc133-spec.md`, "#PATH_DECISION — Q1"). So S1 now decides **only**
mark-row precision at parse time under flood — a smaller blast radius than the spec was
written with. It also means the probe does **not** need to answer "does the hook fire during a
rebuild replay, across a 512-byte chunk split?" — that question is out of scope now, and if it
comes up, the answer does not gate F2.

A third option exists and should be costed only if both above fail: emit marks from the
shell into a *side channel* (a `printf` to a phasr-owned fd or the F1 unix socket) instead
of into the PTY stream, trading interoperability for reliability.

## Decision criteria

Return **PATCH** if all hold:
- A JS-reachable OSC dispatch seam exists in the WASM build, or one can be added in a patch
  hunk of comparable size to the existing DEC-2026 hunk (~40 lines).
- The absolute row can be read at parse time, before viewport anchoring.
- The hunk is plausibly upstreamable (no phasr-specific types in the public surface).

Return **FALLBACK** if the core does not surface OSC at all and adding it means rebuilding
the Zig core.

Return **BLOCKED** if neither is answerable in the timebox — then F2 is deferred a release
and the architect is asked for a larger investigation budget.

## Acceptance criteria

1. A written decision (PATCH / FALLBACK / BLOCKED) is appended to this spec under
   **Decision**, dated and signed by the implementing agent.
2. The decision records the **observed** behaviour of the four probe sequences from Method
   step 1 — quoted output or inspector state, not a prediction.
3. If PATCH: the decision names the exact hook location (file + symbol in the dist, and the
   corresponding position in the patch file) and the proposed emitter signature.
4. If FALLBACK: the decision records the row-precision loss measured under a synthetic
   flood, so F2's relaxed criteria are grounded in a number.
5. No production code is merged from this spike beyond a scratch probe. Any probe file lives
   under the scratchpad, not the repo.

## Test / evidence plan

- **Probe harness:** a scratch Playwright spec modelled on `e2e/terminal-phase0.spec.ts`
  (env-gated, `test.skip` by default so it never becomes a gate) driving a real surface
  through `e2e/harness.ts`. The mocked-IPC harness is fine here: this spike tests the
  *engine*, and the harness writes bytes straight into the surface.
- **Cross-engine check:** run the probe under `pnpm test:e2e:webkit`
  (`playwright.webkit.config.ts`) as well as the default Chromium config. WASM behaviour
  should be identical, and a difference is itself a finding worth recording.
- **Evidence:** the Decision section of this file.

## Out of scope

Implementing the patch · implementing the fallback scanner · any shell-integration emission
work (that is F2's Emit layer) · OSC 7 (cwd) beyond noting whether the same seam carries it.

## Decision

**Decision (2026-08-27, spike agent — Claude, Fable 5): PATCH**

…with one amendment to this spec's Method-step-3 sketch: the hook must be a **split-write
scanner**, not a single row sample at the end of `writeInternal`. Measured: with a mark
mid-chunk followed by 500 lines in the same write (the normal shape — the Rust side
coalesces up to 32 KiB / 8 ms per chunk), end-of-chunk sampling reported `absRow=530`
against a true mark row of 30; splitting the write at the sequence terminator and sampling
between the two engine writes reported `absRow=30`, exact. Splitting is semantically free —
final terminal state byte-identical across the split (probe case 3).

### Observed behaviour of 133;A/B/C/D (Method step 1, Node probe against the installed patched dist)

Probe scripts (scratchpad only, per AC 5): `probe-osc.mjs`, `probe-precision.mjs`, run under
Node against `dist/ghostty-web.js` + `dist/ghostty-vt.wasm` — the dist exports the raw
`GhosttyTerminal` wasm binding (class `W`), so the parse path runs with no DOM. Verbatim:

```
after 'before\r\n': cursor=(0,1) scrollback=0 absRow=1 hasResponse=0
wrote 133;A BEL:  cursor=(0,1) hasResponse=0 row1=""
wrote 133;B BEL:  cursor=(0,1) hasResponse=0 row1=""
wrote 133;C BEL:  cursor=(0,1) hasResponse=0 row1=""
wrote 133;D;1 BEL: cursor=(0,1) hasResponse=0 row1=""
wrote 133;A ST:   cursor=(0,1) hasResponse=0 row1=""
```

- **All four sequences (BEL- and ST-terminated) are swallowed silently**: no echo into
  cells, cursor unmoved, and — decisive for the `processTerminalResponses()` candidate —
  **nothing ever reaches the device-response queue** (`hasResponse=0` throughout). That
  candidate hook is dead without a Zig rebuild.
- **A sequence split across two `write()` calls is carried by the core's own parser state**
  (`\x1b]133;` then `C\x07tail` → only `tail` rendered). Splitting our writes is therefore
  safe at any boundary.
- **An OSC sequence never moves the cursor**, so the row sampled immediately after its
  terminator parses equals the row at dispatch (`absRow=42` before and after `133;A` with
  19 rows already in scrollback).
- **OSC 7 and OSC 1337 are also swallowed cleanly** by the terminal write path
  (`x…7…y…1337…z` renders as `xyz`); 1337 additionally logs
  `warning(osc): invalid OSC command: 1337;CurrentDir=/tmp` through the wasm `env.log`
  import — benign, no visual effect.
- **The wasm build compiled semantic-prompt recognition in.** The export section of
  `dist/ghostty-vt.wasm` (423 045 bytes; also inlined as base64 at `dist/ghostty-web.js:17`)
  carries a standalone OSC parser the JS glue never binds: `ghostty_osc_new / next / end /
  reset / free / command_type / command_data`. Driven directly, it classifies:
  `133;A→3, 133;B→4, 133;C→5, 133;D;1→6, 7;file://…→8, 0/2;title→1`; `1337;…` is rejected.
  So the Zig core in this build knows these commands — the terminal's stream handler simply
  discards them with no JS-visible effect, and no `ghostty_terminal_set_osc_callback`-style
  export exists.

### Hook location (AC 3)

- **File + symbol:** `Terminal.writeInternal` (class `IA`), installed patched dist
  `node_modules/ghostty-web/dist/ghostty-web.js:2488`. The single `this.wasmTerm.write(A)`
  at **line 2495** becomes a call to a new private `writeWithOscScan(A)`, placed beside
  `anchorViewportAfterWrite` (line 2529). The emitter registers in the constructor's
  emitter block (**line 2199**): `this.oscMarkEmitter = new J(), this.onOscMark =
  this.oscMarkEmitter.event` — the exact `bellEmitter` pattern.
- **Position in the patch file:** extends the existing
  `@@ -2387,7 +2487,50 @@ class IA` hunk (`patches/ghostty-web@0.4.0.patch:233`, the hunk
  that already owns `writeInternal`/`anchorViewportAfterWrite`), plus a one-line hunk at
  the constructor emitter block and a `Terminal` d.ts addition beside the existing
  `@@ -1686,6 +1710,36` hunk.
- **Scanner shape:** fast path — no `0x1b,0x5d` pair in the chunk and no carried partial
  sequence → one write, upstream-identical (this is every chunk that isn't a prompt
  boundary). Slow path — for each recognized mark prefix (`133;`, `7;`; `1337;` is a
  one-line table entry if ever wanted, classified by us since the engine rejects it), write
  bytes **through** the terminator (BEL or ESC-`\`), sample the row, fire, continue with
  the remainder. A carry buffer holds a chunk-final partial sequence **for classification
  only** — the bytes themselves are always written to the engine immediately (no rendering
  delay), and row exactness survives the split because OSC never moves the cursor. Same
  carry idea as `src/lib/terminal/graphemeTail.ts`.
- **Callback contract (public d.ts surface):**

  ```ts
  /** Fires when a recognized OSC mark (133 semantic prompt, 7 cwd) completes in the
   *  stream. absoluteRow = scrollbackLength + cursor.y sampled immediately after the
   *  sequence terminator parses — exact even when the mark sits mid-chunk. */
  readonly onOscMark: IEvent<{ sequence: number; params: string[]; absoluteRow: number }>;
  ```

  No phasr-specific types → upstreamable as-is; upstream may prefer an xterm.js-style
  `registerOscHandler(ident, cb)` shape, which this reshapes into trivially.

### Absolute-row source

`this.getScrollbackLength() + this.wasmTerm.getCursor().y`, read between the split writes —
i.e. after the terminator byte parses and before any further byte of the same chunk reaches
the engine, and before `anchorViewportAfterWrite` runs. Measured exact under a 500-line
mid-chunk flood (30 vs 30; the naive end-of-chunk sample read 530).

### Estimated hunk size

~80–95 patch lines including house-style comments (scanner ~55, emitter wiring ~5, d.ts
~20). Same order as the DEC-2026 hunk once its comments are counted; the criterion's
"~40 lines" is exceeded by comments, not mechanism.

### Consequences for F2

- The engine layer is **confirmed feasible with exact parse-time rows under flood** — F2
  keeps its strict mark-row precision acceptance criteria; no architect sign-off on a
  relaxation is needed.
- The Rust-side scanner fallback and the shell side-channel third option are **dead — do
  not cost them**.
- OSC 7 (cwd) rides the same seam for free. OSC 1337 is a scanner-table entry if ever
  wanted (the engine's own OSC parser rejects it; ours classifies independently).
- F2's estimate is unchanged or slightly reduced: the hook design work is done here, and
  the patch layer is now mechanical.

### Method deviations, recorded

The probe ran under Node against the identical wasm binary instead of the Playwright
harness, and the webkit cross-engine check was skipped: the parse path is pure wasm + JS
glue with zero browser dependency, and the decision criteria were already met — Method says
"stop as soon as a decision is reachable". If F2's implementation wants belt-and-braces, it
can fold a 133-mark probe into its own e2e spec, where a real surface exists anyway.
