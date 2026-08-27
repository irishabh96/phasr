# Spec: Spike S1 — ghostty-web OSC hook surface

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
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

_To be appended by the implementing agent. Format:_

```
**Decision (YYYY-MM-DD, <agent>): PATCH | FALLBACK | BLOCKED**

Observed behaviour of 133;A/B/C/D: …
Hook location: …
Absolute-row source: …
Estimated hunk size: …
Consequences for F2: …
```
