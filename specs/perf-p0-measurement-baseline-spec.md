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
7. **`getScrollbackLine` throughput microbench** (architect, Q5 — added so F4's build-vs-patch
   decision is data-driven when F4 starts, rather than argued). Extend the `PHASE0_PROBE=1`
   spec (`e2e/terminal-phase0.spec.ts`) with a probe that fills a surface to a known depth,
   then times `getScrollbackLine(offset)` (`node_modules/ghostty-web/dist/index.d.ts:359`)
   over a large sample, reporting **lines/second and µs/line**, under **both** Chromium and
   `pnpm test:e2e:webkit`. Report the fetch-only cost and the fetch+`getScrollbackGraphemeString`
   cost separately — F4 needs graphemes for correct match spans, so the cheaper number alone
   would flatter it. Reference point for sanity: the rebuild path measures ~15 µs per row for
   *read plus re-emit* (`src/lib/terminal/backends/ghostty.ts:198`), so a fetch-only figure far
   above that is a measurement bug, not a discovery. This belongs in the e2e probe, **not** in
   `perfbench.rs`: it is a WASM/JS call and never crosses the IPC boundary.
8. **No probe becomes a CI gate in this phase.** All perf specs stay `test.skip`-by-default
   behind their env flags, exactly like the existing three. Promoting thresholds is Phase 5's
   job — and per P5's Q4 decision, only the *counting* ones are promoted at all.
9. Every baseline number is written into this spec's **Baseline** section with the date, the
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

_Every row carries runtime + date + machine. Machine "M1P" = MacBook Pro, Apple
M1 Pro, 16 GB, macOS (Darwin 25.6.0), **120 Hz ProMotion display** (rAF runs at
~120 fps — frame-time numbers are not comparable to a 60 Hz machine). Engine:
ghostty-web 0.4.0 + `patches/ghostty-web@0.4.0.patch` at v0.4.1+p0. Browser
runs use the mocked-IPC dev harness on an isolated port (`E2E_PORT=14310/14311`),
one worker, machine held awake with `caffeinate`. Probes:
`PHASE0_PROBE=1 … e2e/terminal-phase0.spec.ts` / `e2e/perf-baseline.spec.ts`._

| Metric | Runtime | Value | Date | Machine |
|---|---|---|---|---|
| Idle script / 8 s, 1 visible | Chromium | Script **0.559 s**, Task 1.307 s (CDP; ADR-002 known-bad band was 0.420–0.477 s) | 2026-08-28 | M1P |
| Idle script / 8 s, 1 visible | WebKit | browser-tree CPU **2.28 s / 8 s** (ps-diff; no CDP in WebKit — process-tree CPU, not ScriptDuration); rAF mean 17.7 ms / p95 19.0 ms at 60 Hz | 2026-08-28 | M1P |
| Idle CPU %, 1 visible | packaged app (Activity Monitor) | | | |
| Idle CPU %, 8 open / 1 visible | packaged app (Activity Monitor) | | | |
| Scroll script, 60 steps / 3000 lines | Chromium | Script **0.51 s**, Task 0.747 s; frames mean 8.3 ms / p95 8.5 ms, 0 > 25 ms (ADR-002 reference 0.916 s — post-0.4.1 scroll fixes) | 2026-08-28 | M1P |
| Scroll frame p95, deep scrollback | WebKit | **p95 19.0 ms** (mean 16.7, max 33.0, 2 frames > 25 ms of 129) — over the < 16.7 ms target; note idle p95 is also 19.0 ms on this 60 Hz proxy, so the scroll-specific overshoot is the max/>25 ms tail | 2026-08-28 | M1P |
| Echo keystroke→paint p50 / p95 | WebKit | **p50 6.0 ms / p95 15.0 ms** (n=60, 0 expired, 60 fps) — within the p95 ≤ 1 frame + 10 ms target on this proxy | 2026-08-28 | M1P |
| IPC hop, < 8 KB eval path | Rust↔JS bench | | | |
| IPC hop, ≥ 8 KB fetch path | Rust↔JS bench | | | |
| Flood throughput (`PHASR_BENCH`) | Rust | | | |
| `getScrollbackLine` lines/s (fetch only) | Chromium | **3.38 µs/line ≈ 296 k lines/s** (depth 9 649, 4 000 sampled, warm, disjoint offsets) | 2026-08-28 | M1P |
| `getScrollbackLine` lines/s (fetch only) | WebKit | **4.00 µs/line ≈ 250 k lines/s** (depth 9 646, 4 000 sampled, warm, disjoint offsets) | 2026-08-28 | M1P |
| `getScrollbackLine` lines/s (+ graphemes) | WebKit | **9.25 µs/line ≈ 108 k lines/s** — graphemes cost **2.3×** on the shipping-engine proxy (Chromium hides this entirely; the spec's "the cheaper number alone would flatter it" warning, confirmed). F4's ~4 ms tick budget ≈ ~430 grapheme-correct lines/tick here | 2026-08-28 | M1P |
| `getScrollbackLine` lines/s (+ graphemes) | Chromium | **2.83 µs/line ≈ 354 k lines/s** — pass-order/allocator noise puts it under fetch-only; read both as "~3 µs/line, fetch dominates, graphemes ≈ free on a 1/16-cluster corpus" | 2026-08-28 | M1P |
| `resize_task` calls per horizontal gesture | Chromium (harness) | **14** (`resize_task`×14; 14-step / ~220 ms viewport drag) | 2026-08-27 | M1P |
| `resize_task` calls per vertical gesture | Chromium (harness) | **9** (`resize_task`×9; rows-only path fits immediately — P5's remaining half, confirmed) | 2026-08-27 | M1P |

**WebKit context from `perf-baseline.spec.ts`** (2026-08-28, M1P; Playwright
WebKit runs its rAF at 60 Hz on this machine while Chromium runs at ~120 —
frame numbers between the two engines are not directly comparable): flood
2.06 MB TUI in 140 ms = **14.7 MB/s** in-page parse+write, **~36 fps during
flood** (the A1 cadence baseline: the free-running loop already yields under
flood on WebKit); resize gesture horizontal **13** / vertical **10**
(`resize_task`, same probe model as the Chromium rows).

**Chromium drift references from `perf-baseline.spec.ts`** (same-machine
context for the WebKit rows; Chromium is never paint-cost truth): echo
keystroke→paint p50 4.2 ms / p95 7.9 ms (n=60, 0 expired, ~119 fps);
idle 8 s browser-tree CPU 2.69 s (ps-diff, all processes incl. GPU);
flood 2.06 MB TUI in 144 ms = **14.3 MB/s** in-page parse+write at ~69 fps
during flood; deep-scrollback wheel p95 9.3 ms. 2026-08-27, M1P.

**Coalescer ladder** (`PHASR_BENCH=1 … perfbench::bench_phase3`, real PTY +
node producer over the 22.1 MiB corpus log, debug profile, 2026-08-28, M1P;
BEFORE = one event per 4096-B read, AFTER = shipping coalescer):
spinner 40 KB/s: 40.3 → **10.2 ev/s** (4 029 B/ev, 4.0×);
tui-10hz 320 KB/s: 320.2 → **10.3 ev/s** (31 711 B/ev, 31.0×);
tui-40hz 1.3 MB/s: 1 280 → **40.4 ev/s** (32 363 B/ev, 31.7×).
The ladder confirms the ≤125 ev/s bound with full-size 32 KiB chunks under
agent-repaint load. (Bench repair shipped with this phase: the shipping-path
command was word-splitting the corpus path — every AFTER column silently
measured 0 events before the fix.)

**Rust-side IPC component costs** (`PHASR_BENCH=1 cargo test --lib ipcbench
-- --ignored --nocapture`, **debug profile** — the shipping app is release,
so absolute µs overstate; the json-vs-raw RATIO is the durable finding;
2026-08-28, M1P): per chunk, serialize+send into a no-webview sink —
4 KiB: json 221 µs vs raw **0.2 µs**; 32 KiB: json 1 999 µs vs raw
**1.0 µs**. The base64+JSON envelope is ~1000× the Rust-side cost of
Phase 4's raw bytes before the webview is even involved. Corpus context:
73.07 MiB across 107 real PTY logs, ESC/KiB 61.7.

**Measurement notes.**
- The horizontal gesture's 14 `resize_task` calls are one per drag STEP
  (each 10 px step re-plans; `REBUILD_QUIET_MS` collapses the rebuild but
  the probe's stepped `setViewportSize` lands each step as its own settled
  width — a real panel toggle animates continuously and produces one).
  Read it as the probe's gesture model, not 14× per panel toggle; the
  number to hold against P5 is the per-gesture count under the same probe.
- Scrollback bench: re-fetching a just-fetched line is measurably cheaper
  than a cold fetch even after warm-up, so the two passes sample disjoint
  offsets (n / n+1). Corpus: every 16th line CJK + emoji, rest ASCII.
- Runs on battery with aggressive sleep: two Chromium probe runs recorded
  15-minute wall-clock gaps (test-timeout + teardown) with identical
  measured values on retry — sleep gaps, not renderer wedges. Numbers
  recorded only from runs that completed without a gap.
