# Spec: Perf Phase 0 — Measure on the real runtime

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** P (performance) · **Ships as:** 0.4.2 · **Size:** 1–2 days
**Depends on:** nothing · **Blocks:** P1–P5 (every later decision is checked against these numbers)
**Provenance:** derived from a local iTerm2 source read, 2026-08-27, reconciled against ADR-002.

## Objective

Establish the measurement apparatus and the baseline numbers on **the runtime phasr actually
ships on**, so every later phase is judged against reality instead of against Chromium.

This phase owns the program's acceptance-criteria table. Later phases reference it.

## Why this is Phase 0 and not an afterthought

- Every recorded perf number in the repo is Chromium. ADR-002 **withdraws its own
  cross-engine table** (`docs/adr/ADR-002-terminal-engine.md:243–262`) because Playwright's
  default headless Chromium has no GPU: WebGL was served by ANGLE over SwiftShader, so every
  comparison flattered the current engine. Only the ghostty-only self-comparisons survive.
- phasr ships in a **WKWebView**, whose *synchronous GPU-process IPC* is the actual cause of
  the scroll history (`docs/MANUAL-VERIFICATION.md`, "Perf — the real gate" section).
- **There is zero input-latency instrumentation.** Nobody has ever measured keystroke→paint.
- ADR-002:820–830 states plainly that the Rust base64 serializer and the JS decoder "have
  never met in one process" — each half is covered, the seam is not.

## User story

- As a developer deciding where to spend two weeks of terminal work, I want numbers taken on
  the engine we ship on, so that I optimise the thing that is actually slow.

## Acceptance criteria

1. **Perf HUD (dev-mode only).** A HUD renders over a terminal in dev builds showing, live:
   keystroke→paint latency (last / p50 / p95), fps, parse backlog (bytes queued), and
   bytes/s. It is off by default, toggled behind an env or dev-only setting, and **cannot**
   render in a production build.
2. **Latency instrumentation.** A `performance.mark` is placed in the surface's `onData`
   path and resolved on the next *painted* frame; the delta is the recorded keystroke→paint
   latency. It reads frame completion from the patched `getRenderStats()`
   (`ticks`, `lastFrameAt`, `queued`, `paused`, `open`, `disposed`, `frameErrors`,
   `lastFrameError` — `node_modules/ghostty-web/dist/ghostty-web.js:2846`).
3. **Rust↔JS end-to-end IPC bench exists and reports numbers**, timing a real chunk from the
   Rust coalescer to the JS `onmessage`, separately for:
   - the **< 8 KB** Tauri eval transport path, and
   - the **≥ 8 KB** fetch transport path (which goes through Tauri's global
     `Mutex<HashMap>` shared by all PTYs),
   and separately for base64+JSON (today) vs raw bytes (what Phase 4 proposes).
4. **WKWebView-proxy baselines recorded** for idle script cost, scroll frame time, flood
   throughput and echo latency, captured under `pnpm test:e2e:webkit`
   (`playwright.webkit.config.ts` — "phasr ships in a WKWebView, and WebKit is the same
   engine … the closest proxy available without building and driving the packaged .app").
5. **Activity Monitor baselines recorded by hand** for the two cases
   `docs/MANUAL-VERIFICATION.md` already names: **1 visible terminal idle**, and **8
   terminals open with only 1 visible**. Recorded as a new dated table in
   `docs/MANUAL-VERIFICATION.md`.
6. **Chromium reference numbers reproduced** so drift is visible: `IDLE_8S` script time and
   the 60-step/3000-line scroll script time, via the existing `PHASE0_PROBE=1`
   (`e2e/terminal-phase0.spec.ts`) and `SCROLL_PROBE=1` (`e2e/scroll-probe.spec.ts`) probes.
   The known-bad references are **idle 0.420–0.477 s / 8 s** and **scroll script 0.916 s**
   (ADR-002:275–276).
7. **No probe becomes a CI gate in this phase.** All perf specs stay `test.skip`-by-default
   behind their env flags, exactly like the existing three. Promoting thresholds is Phase 5's
   job.
8. Every baseline number is written into this spec's **Baseline** section with the date, the
   machine, and the runtime it was taken on. A number without a runtime label is not a
   number.

## Parity targets — acceptance criteria for the whole program

| Axis | Target |
|---|---|
| Idle CPU | ≤ 0.5% of a core per **visible** terminal; ~0 for hidden |
| Echo latency | p95 ≤ 1 frame + 10 ms, measured on WKWebView (not Chromium) |
| Data integrity | zero dropped bytes at any output rate |
| Scroll | frame p95 < 16.7 ms in deep scrollback |
| Flood | `cat` of a 100 MB file keeps the whole UI interactive |
| Cadence (A1) | observably adaptive: flood drops the frame rate to ~30 fps (verified via `getRenderStats()`); typing at idle paints within 1 frame |

Owned by: P1 (idle, cadence), P2 (scroll, flood frame cost), P3 (data integrity), P4 (echo,
per-byte cost), P5 (holding all of them in CI).

## Implementation notes — verified entry points

| Piece | Location |
|---|---|
| Render stats (already patched in) | `node_modules/ghostty-web/dist/ghostty-web.js:2846` `getRenderStats()`; declared in `dist/index.d.ts` |
| Free-running rAF chain (what fps must measure) | `dist/ghostty-web.js:2953–2955` — the callback re-queues itself unconditionally |
| Surface API to instrument | `src/lib/terminal/surface.ts` — `write()` (:126), `onData()` (:129), `setActive()` (:166) |
| Backend implementation | `src/lib/terminal/backends/ghostty.ts` |
| JS-side chunk decode (the half to time) | `src/lib/ptyChunk.ts` — `decodePtyChunk`, `atob` + byte loop |
| Rust coalescer (the other half) | `src-tauri/src/pty/handle.rs` — `coalesce_pty_output`; `COALESCE_BYTES = 32 * 1024` (:657), `COALESCE_WINDOW = 8 ms` (:661) |
| Existing throughput bench | `src-tauri/src/perfbench.rs`, gated `PHASR_BENCH=1` |
| Existing load harness (counts drops) | `src-tauri/src/loadtest.rs`, gated `PHASR_LOAD=1`, steps via `PHASR_LOAD_STEPS` |
| Existing Chromium probes | `e2e/terminal-phase0.spec.ts` (`PHASE0_PROBE=1`), `e2e/scroll-probe.spec.ts` (`SCROLL_PROBE=1`), `e2e/perf-probe.spec.ts` (`PERF_PROBE=1`) |
| WKWebView proxy runner | `playwright.webkit.config.ts` via `pnpm test:e2e:webkit` |

**Port isolation:** the WebKit config hard-codes `http://localhost:1420` with
`reuseExistingServer: true`. If another worktree's dev server is on 1420, the probe silently
measures *that* code. Confirm the server under test before recording any number.

## Test / evidence plan

- **vitest** (`pnpm test`): unit coverage for the latency-sampling maths (percentiles, the
  mark→frame resolution rule, and that a dropped frame does not corrupt a sample).
- **Playwright, both engines**: the probe specs above, run under the default config *and*
  `pnpm test:e2e:webkit`. Both numbers recorded; only the WebKit one is treated as directional
  truth for paint cost.
- **Rust** (`cargo test --manifest-path src-tauri/Cargo.toml`): the IPC bench harness lands
  as an env-gated test alongside `perfbench.rs`.
- **Mocked-IPC limitation, stated:** `e2e/harness.ts` boots the real app against the Vite
  dev server with a *mocked* Tauri IPC layer — it synthesizes base64 on the JS side. It can
  therefore measure paint and decode cost, but **it cannot measure the real IPC hop**.
  Criterion 3 is satisfied by the Rust-side bench plus a manual run of a packaged build, not
  by Playwright.
- **Manual:** criterion 5's Activity Monitor readings, and a new
  `docs/MANUAL-VERIFICATION.md` entry recording them.

## Out of scope

Any optimisation whatsoever — Phase 0 changes no hot path. Promoting probes to gates (P5).
Shipping the HUD to users.

## Baseline

_To be filled by the implementing agent. Every row must carry runtime + date + machine._

| Metric | Runtime | Value | Date | Machine |
|---|---|---|---|---|
| Idle script / 8 s, 1 visible | Chromium | | | |
| Idle script / 8 s, 1 visible | WebKit | | | |
| Idle CPU %, 1 visible | packaged app (Activity Monitor) | | | |
| Idle CPU %, 8 open / 1 visible | packaged app (Activity Monitor) | | | |
| Scroll script, 60 steps / 3000 lines | Chromium | | | |
| Scroll frame p95, deep scrollback | WebKit | | | |
| Echo keystroke→paint p50 / p95 | WebKit | | | |
| IPC hop, < 8 KB eval path | Rust↔JS bench | | | |
| IPC hop, ≥ 8 KB fetch path | Rust↔JS bench | | | |
| Flood throughput (`PHASR_BENCH`) | Rust | | | |
