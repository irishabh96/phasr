# Spec: Perf Phase 4 — Shrink the pipe (incl. amendments A2, A5)

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** P (performance) · **Ships as:** 0.4.2 · **Size:** 2–4 days
**Depends on:** P0 (the IPC bench is the go/no-go instrument), P3 (log offsets, backpressure)
**Type:** Rust + TypeScript
**Provenance:** derived from a local iTerm2 source read, 2026-08-27.

## Objective

Roughly halve the cost per byte, make hidden agent sessions nearly free, and take the
avoidable delay out of keystroke echo. This matters more to phasr than to iTerm2: **phasr's
normal state is many hidden agent sessions streaming at once.**

## The gap

1. **The payload is heavy.** Each 32 KiB flush becomes base64 + JSON ≈ **43.8 KB**. Every
   payload ≥ 8192 B takes Tauri's fetch round-trip through a **global `Mutex<HashMap>` shared
   by all PTYs** (tauri `ipc/channel.rs:37,46,167–182`), then `atob` plus a byte-by-byte loop
   on the JS side (`src/lib/ptyChunk.ts`, `decodePtyChunk` — the file's own comment explains
   the loop was chosen because `Uint8Array.from(s, cb)` is several times slower).
2. **Rust copies ~140 KB per 32 KiB chunk**: a per-read `to_vec`, the coalescer accumulator
   (`buf.extend_from_slice(&bytes)`, `handle.rs:748`), a **full `Vec` clone into the replay
   buffer** (`recorded.push(event.clone())`, `handle.rs:804`), per-subscriber broadcast
   clones, the base64 `String`, and the JSON `String`.
3. **Hidden sessions pay everything.** A *parked* terminal still does full serialize → IPC →
   decode → WASM parse; only painting stops. An **LRU-evicted** surface is worse: the Rust
   forwarder and the JS channel stay alive and the whole pipe runs just to hit
   `if (stats.paused || !stats.open || stats.disposed) return;`
   (`src/lib/terminal/backends/ghostty.ts:1290`).
4. **Echo carries avoidable delay.** Every keystroke pays the full 8 ms coalescing window
   plus up to a 16.7 ms frame wait; each keystroke is a full Tauri invoke (String payload,
   `session.require`, two mutex acquisitions).

## User story

- As a developer with eight agents streaming in the background and one terminal in front of
  me, I want the seven I can't see to cost almost nothing and the one I'm typing into to feel
  instant.

## Acceptance criteria

1. **Raw-bytes IPC.** Terminal output moves to Tauri 2 raw payloads
   (`Channel<InvokeResponseBody>` + `InvokeResponseBody::Raw`; JS receives an `ArrayBuffer`).
   This deletes, in one move: the base64 encode, the JSON envelope, `atob`, and the byte-loop
   decode in `src/lib/ptyChunk.ts`. Exit and metadata events stay on a small JSON control
   channel.
2. **Both transport paths validated, before and after**, with P0's Rust↔JS bench: the
   **< 8 KB** eval path and the **≥ 8 KB** fetch path. A change that helps one and hurts the
   other is not accepted on the strength of an average.
3. **Rust copies cut to ~40 KB per 32 KiB chunk** (from ~140 KB): chunks are carried as
   `bytes::Bytes` so the replay-buffer push (`handle.rs:804`) and per-subscriber broadcast
   clones become refcount bumps.
4. **Leading-edge flush.** If the coalesce buffer is empty *and* the last flush is stale, the
   first read flushes immediately; the trailing burst then coalesces at the existing
   32 KiB / 8 ms. Echo's IPC delay drops from +8 ms to ~0 **without widening the window**.
5. **A2 — keystroke fast path on the render side.** A frame requested **< 0.1 s after a
   keystroke** while throughput is **< 1024 B/s** repaints immediately, out of band, instead
   of waiting for the next scheduled tick. Paired with criterion 4, this is the mechanism
   behind "typing feels instant while `cat` stays cheap".
6. **Echo latency target met**: p95 ≤ 1 frame + 10 ms, measured on WebKit per P0.
7. **LRU-evicted terminals stop costing anything.** On eviction, the JS channel **and** the
   Rust forwarder are torn down. Re-attach happens via replay; if replay is insufficient,
   either raise `REPLAY_BUFFER_BYTES` (`handle.rs:14`, currently `128 * 1024`) or backfill
   from the log using P3's byte offsets. `e2e/terminal-lru.spec.ts` still passes and the
   evicted terminal's **process is untouched** (the invariant
   `docs/MANUAL-VERIFICATION.md` already asserts).
8. **Parked-but-cached terminals get a widened flush window.** A per-PTY visibility hint
   widens their coalesce window to ~50 ms — same bytes delivered, far fewer trips through the
   shared global mutex. A parked terminal's bytes are still **all** delivered (P3's
   guarantee is not weakened).
9. **A5 — hidden sessions yield compute, not just IPC.** Hidden surfaces' WASM `write()`
   parsing yields to the visible terminal's frame budget. (iTerm2 deprioritizes background
   sessions in token execution — a busy hidden session stops mid-batch when a visible one has
   pending tokens — and flushes their side effects at 1 Hz vs 30 Hz.)
10. **Zero dropped bytes still holds.** P3's `PHASR_LOAD=1` assertion of 0 drops passes
    unchanged at every ramp step, including `bulk`.

## #PATH_DECISION — leading-edge flush, not a wider window

ADR-002:1250–1260 already rejected widening the 32 KiB / 8 ms coalescer to fix a different
problem, in these terms: *"it adds latency to **every** keystroke echo to fix a case that is
one codepoint wide."* The same reasoning applies here in reverse — the fix for echo latency
is to flush *earlier* on the leading edge, not to change the window that bounds flood.

**Decision: leading-edge flush (criterion 4) + render-side fast path (criterion 5). The
32 KiB / 8 ms window is unchanged for the trailing burst.** Do not reopen the window
question.

## #PLAN_UNCERTAINTY — grapheme-tail interaction with the leading-edge flush

`src/lib/terminal/graphemeTail.ts` deliberately holds back a chunk's trailing bytes when a
following chunk could change their meaning (incomplete UTF-8, trailing ZWJ, a codepoint a
variation selector may follow), releasing them when the rest arrives or after 50 ms
(ADR-002:1250–1256). A leading-edge flush produces **more, smaller chunks**, which makes the
mid-cluster case more frequent.

Verify during implementation that echo latency measured at the *paint* (not at the IPC
receipt) still meets criterion 6 — a leading-edge flush that hands the surface a chunk ending
mid-cluster buys nothing, because the tail is held anyway. If it does not hold,
`e2e/terminal-grapheme-split.spec.ts` is the regression guard and the architect must decide
whether the 50 ms tail timeout shortens.

## #PLAN_UNCERTAINTY — REPLAY_BUFFER_BYTES is wanted by two phases

P3 may raise `REPLAY_BUFFER_BYTES` for lag recovery; this phase may raise it for LRU
re-attach. Only one of them should own the change. Recommendation: **P4 owns it**, because
P3's recommended recovery mechanism is log backfill; if P3 instead adopts replay-resubscribe,
the raise moves to P3 and this criterion becomes "confirm the existing size suffices".

## Implementation notes — verified entry points

| Piece | Location |
|---|---|
| JS decode to delete | `src/lib/ptyChunk.ts` — `decodePtyChunk` (`atob` + byte loop) |
| PTY event wire type (frontend) | `src/lib/types.ts:80–81` — `{ type: "output"; taskId; chunk }` / `{ type: "exit"; taskId; exitCode }` |
| Coalescer accumulator + flush | `src-tauri/src/pty/handle.rs:740–760`; `flush_output` at `:773` |
| Replay push (the full `Vec` clone) | `src-tauri/src/pty/handle.rs:804` |
| `REPLAY_BUFFER_BYTES = 128 * 1024` | `src-tauri/src/pty/handle.rs:14` |
| `COALESCE_BYTES` / `COALESCE_WINDOW` | `src-tauri/src/pty/handle.rs:657` / `:661` |
| Forwarders that would become raw-payload senders | `src-tauri/src/commands/orchestrator.rs:149,209`, `session_terminal.rs:153`, `run_commands.rs:251`, `orchestrator/service.rs:612` |
| Evicted-surface early return (the wasted work) | `src/lib/terminal/backends/ghostty.ts:1290` |
| LRU / eviction policy | `src/lib/terminal/cache.ts` (`evict()` at :95, refuses mounted surfaces at :180) |
| Visibility hint origin | `TerminalSurface.setActive()`, `src/lib/terminal/surface.ts:166` |
| Keystroke origin (fast-path trigger) | `TerminalSurface.onData()`, `src/lib/terminal/surface.ts:129` |
| Grapheme tail (see uncertainty above) | `src/lib/terminal/graphemeTail.ts` + `graphemeTail.test.ts` |
| IPC bench from P0 | alongside `src-tauri/src/perfbench.rs` |

## Parity targets this phase owns

| Axis | Target |
|---|---|
| Echo latency | p95 ≤ 1 frame + 10 ms, measured on WKWebView |
| Idle CPU | ~0 for hidden terminals (P1 owns the visible half) |

(Full table in `specs/perf-p0-measurement-baseline-spec.md`.)

## Test / evidence plan

- **Rust** (`cargo test --manifest-path src-tauri/Cargo.toml`): `bytes::Bytes` refactor
  covered by existing `handle.rs` tests (there are broadcast/replay tests at `:932`–`:1050`
  and a replay-budget test at `:1310`); new tests for the leading-edge flush rule (empty
  buffer + stale last flush → immediate flush; non-empty buffer → unchanged coalescing) and
  the per-PTY visibility hint widening the window without dropping bytes.
- **vitest** (`pnpm test`): `decodePtyChunk` removal must not break callers; add coverage for
  the `ArrayBuffer` receive path. `src/lib/terminal/cache.test.ts` covers teardown-on-eviction.
- **Playwright**: `e2e/terminal-lru.spec.ts`, `terminal-drop.spec.ts`, `terminal-aged.spec.ts`
  and `terminal-grapheme-split.spec.ts` all pass, under Chromium and `pnpm test:e2e:webkit`.
- **Mocked-IPC limitation — this is the sharpest one in the program.** `e2e/harness.ts`
  synthesizes base64 chunks on the JS side and decodes them with `decodePtyChunk`. It
  therefore **cannot validate the raw-payload transport at all**, and ADR-002:820–830 already
  records that the Rust serializer and the JS decoder "have never met in one process". The
  harness must be updated to emit the new payload shape, but that update is *not* evidence
  the transport works. Criterion 1 and 2's evidence is:
  (a) the Rust↔JS bench from P0, and (b) a **manual run of a packaged build** with a new
  `docs/MANUAL-VERIFICATION.md` entry — the same class of gap that let a 404 template URL
  ship.
- **Manual:** echo feel and the 8-hidden-sessions idle reading in Activity Monitor.

## Out of scope

Renderer work (P2) · frame scheduling (P1) · the input *invoke* path — the plan says to touch
it only if P0 shows the per-keystroke invoke actually costs anything, and that decision
belongs to P5 · changing the coalescer window · anything that weakens P3's zero-drop
guarantee.
