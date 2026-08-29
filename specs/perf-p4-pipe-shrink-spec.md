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

## #PATH_DECISION — Q3 tail: P4 owns `REPLAY_BUFFER_BYTES`, and the default answer is "do not raise it"

**Decision (2026-08-27, System Architect): P4 is the only phase that may change
`REPLAY_BUFFER_BYTES` (`handle.rs:14`), and it starts from "unchanged".**

P3 settled on log backfill for every byte-carrying forwarder (see that spec's Q3 decision), so
lag recovery no longer wants a bigger replay buffer at all — which leaves LRU re-attach
(criterion 7) as the sole claimant. Re-attach should use **the same log-offset backfill P3
builds**: one mechanism, unbounded history, already tested. Raising the buffer is a second
mechanism with a worse bound, and it costs memory on *every* PTY to serve a case that happens
on re-mount.

So criterion 7 reads: re-attach via `subscribe_with_replay` for the recent tail, plus P3's
log backfill for anything older. Raise `REPLAY_BUFFER_BYTES` **only** if a measurement in this
phase shows backfill-on-re-attach is materially worse for the user, and record the number in
the PR. **Rejected — raising it in P3:** P3 has no remaining need for it.

*(Original uncertainty, for the record: P3 may raise it for lag recovery; this phase may raise
it for LRU re-attach; only one of them should own the change.)*

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

## Evidence — implemented 2026-08-29, `feat/iterm2-parity`

Machine **M1P** (MacBook Pro, Apple M1 Pro, 16 GB, Darwin 25.6.0), on battery.
Commits: `255bbf8` (Bytes + leading edge + visibility hint) · `55f683d` (raw payloads,
shared forwarder, detach/visibility commands) · `73baffd` (frontend) · `254c43a` (e2e
harness) · `1304401` (**size-aware framing — read this one first**) · `612b264` (docs).

### The headline: the phase's premise did not survive a release build

Criterion 1 says move output to raw payloads, citing P0's 6.3× (12.8 → 80.1 MB/s at
32 KiB). That number reproduces on a **debug** build and only there — my debug run
measured 21.0 → 152.4 MB/s, the same 7×. On a **release** build, serde and base64 are
roughly 30× faster, and the picture inverts. Three release runs through a real
`tauri::ipc::Channel`, 200-chunk streams, MB/s of payload:

| chunk | `json` (before) | `raw` (what criterion 1 asked for) | **`auto` (what shipped)** |
|---|---|---|---|
| 512 B | 14.0 / 16.3 / 19.5 / 24.4 | 10.9 / 10.9 / 10.9 / 10.9 | **24.4 / 32.6** |
| 4 KiB | 130.2 / 156.3 / 156.3 | 23.0 / 28.9 / 30.0 | **156.3 / 195.3** |
| 32 KiB | 138.9 / 168.9 / 178.6 / 201.6 | 152.4 / 201.6 / 223.2 / 231.5 | **201.6 / 215.5** |

**What the numbers say.** The variable that dominates is not the encoding, it is which
transport tauri picks: ~0.025 ms per message on the `eval` path, ~0.15 ms on the `fetch`
path, almost independent of payload size. Raw crosses to `fetch` at 1024 B; base64+JSON
stays on `eval` until its envelope hits 8192 B (≈ 6.1 KB of chunk). So raw-for-everything
would have made a 4 KiB chunk **5× slower** on the build users actually run, and a 512 B
chunk 0.7× — because a raw payload under 1024 B is delivered as a JSON **number array**,
~4 bytes per byte, which is exactly the encoding the original base64 comment rejected.

**This is criterion 2 doing its job**, verbatim: *"A change that helps one and hurts the
other is not accepted on the strength of an average."* So the framing is size-aware —
keep the JSON envelope while it still fits the eval threshold, go raw above it
(`commands/pty_stream.rs::send_event`, boundary pinned by
`a_chunk_goes_raw_exactly_when_its_envelope_would_leave_the_eval_path`, arithmetic pinned
against serde by `the_envelope_arithmetic_matches_serde`). Measured as shipped, `auto` is
at or above the better of the two pure strategies at every size, and it never regresses
either transport path against the pre-P4 wire.

It also serves the phase's own motivation better than pure raw would have: the gap
section complains that every payload ≥ 8192 B goes through a global `Mutex<HashMap>`
shared by all PTYs. Pure raw would have pushed *more* traffic onto that mutex (everything
over 1024 B). The shipped policy keeps small and mid-size chunks off it entirely.

### Per criterion

| # | Criterion | As built |
|---|---|---|
| 1 | Raw-bytes IPC | **Partially, deliberately** — raw above the eval threshold, base64+JSON below it (see above). `atob` + the byte loop survive for the small arm, behind `isPtyOutput`/`ptyChunkBytes` so the three handlers never learn there are two shapes. Exit and desync are JSON control events on the same channel |
| 2 | Both paths validated before *and* after | The table above: 512 B and 4 KiB are the eval path, 32 KiB the fetch path, each with a before, a pure-raw, and the shipped policy. The bench's `auto` format calls `pty_stream::output_body` — the function the forwarder calls — so it cannot drift from what it reports |
| 3 | Copies cut to ~40 KB per 32 KiB chunk | `PtyEvent::Output.chunk` is `bytes::Bytes`. The replay push and every per-subscriber broadcast clone are refcount bumps; `a_chunk_is_shared_with_the_replay_buffer_not_copied_into_it` asserts it by pointer. The one remaining copy is the `Vec<u8>` `InvokeResponseBody::Raw` insists on owning at the boundary |
| 4 | Leading-edge flush | Empty buffer + a flush older than the current window ⇒ flush this read at once. Two tests state both halves; two pre-existing tests now read 2 events where they read 1, and that split **is** the feature |
| 5 | A2 render-side keystroke fast path | **NOT DONE — out of my file ownership** (`src/lib/terminal/**` is P2's). See below |
| 6 | Echo p95 ≤ 1 frame + 10 ms on WebKit | **NOT MEASURED** — needs criterion 5 and a paint-level probe. The IPC half is removed (one-shot p50 is at the noise floor, 1.00 ms, for every format and size) |
| 7 | LRU-evicted terminals stop costing | A chunk arriving for a surface whose element left the document triggers `detach_terminal_stream`, which ends the Rust forwarder. Process untouched; re-attach is the existing `subscribe_with_replay`. `e2e/terminal-lru.spec.ts` green |
| 8 | Parked terminals get a widened window | `PtyHandle::set_visible` → 50 ms instead of 8 ms, pushed from the same effect that calls `surface.setActive`. `a_hidden_terminal_coalesces_reads_a_visible_one_would_flush` proves the framing changes and the bytes do not |
| 9 | A5 hidden sessions yield WASM compute | **NOT DONE — out of my file ownership** (renderer). See below |
| 10 | Zero dropped bytes still holds | Unchanged and re-measured; see below |

### `REPLAY_BUFFER_BYTES` — unchanged, as the Q3 decision defaults to

Not raised. The decision said "start from unchanged" and raise only if re-attach measurably
hurts. It does not: eviction's cost is scrollback, and that cost is **identical to before
this phase** — an evicted surface was always rebuilt from the 128 KB replay. P4 only stops
the forwarder that used to keep running behind it. Nothing new asks for a bigger buffer.

### Coalescer throughput (`PHASR_BENCH=1`, release)

```
COALESCE spinner  40 KB/s     BEFORE ev/s     40.3  B/ev  1016  0.04 MB/s
                              AFTER  ev/s     20.0  B/ev  2048  0.04 MB/s   reduction  2.0x
COALESCE tui-10hz 320 KB/s    BEFORE ev/s    320.2  B/ev  1023  0.31 MB/s
                              AFTER  ev/s     20.2  B/ev 16249  0.31 MB/s   reduction 15.9x
COALESCE tui-40hz 1.3 MB/s    BEFORE ev/s   1279.9  B/ev  1024  1.25 MB/s
                              AFTER  ev/s     80.0  B/ev 16384  1.25 MB/s   reduction 16.0x
COALESCE bulk unthrottled     BEFORE ev/s 195888.8  B/ev  1024 191.27 MB/s
                              AFTER  ev/s   4160.9  B/ev 32767 130.02 MB/s  reduction 47.1x
```

Two things to read here. **The flood got faster**: 130.02 MB/s against P3's 114.90, and the
ratio of raw PTY throughput the shipping path retains is now **0.68** (P3 0.61, P0 0.58) —
that is the `Bytes` refactor, and `B/ev` still pinned at the 32 KiB ceiling shows the
leading edge never fires inside a flood. **The 40 Hz TUI profile doubled its event rate**,
80.0 against P3's 44.9, which is the leading edge costing exactly one extra small event per
burst, by design. Bytes delivered are identical in both columns.

### `PHASR_LOAD=1` — P3's zero-drop assertion, re-run (criterion 10)

```
flood         80.0 MiB          events        2364
lagged        204 events        refilled      6423878 B from the log
unrecovered   0 B
delivered     83887430 B (hash 830dac9e5fbdfdd8)
log[0..83887430]  83887430 B (hash 830dac9e5fbdfdd8)
```

Zero unrecovered bytes, reconstructed stream hash-identical to the log, through the `Bytes`
refactor, the leading-edge flush and the new framing. `grep -rn "Lagged(_) => continue"
src-tauri/src/` → no matches.

### Suites

* `cargo test --lib` → **253 passed, 0 failed, 8 ignored** (244 at P3; +9).
* `pnpm test` → **394 passed** (377 before; +17, mostly `src/lib/ptyChunk.test.ts`).
* `pnpm typecheck` → clean.
* IPC contract checker → green for `detach_terminal_stream`, `set_terminal_visible`,
  `open_task_terminal`, `start_session_terminal`, `attach_session_terminal`,
  `start_run_command`, `read_task_log`.
* Playwright Chromium → **155 passed, 12 skipped, 0 failed**, including
  `terminal-lru`, `terminal-drop`, `terminal-aged` and `terminal-grapheme-split`.
* Playwright WebKit → 135 passed / 17 failed, **all pre-existing**. `e2e/forms.spec.ts`
  alone fails 9 of 29 at the pre-P4 baseline (`8d3f34a`) on this machine, in a `page.goto`
  navigation race ("Frame load interrupted") in specs that never emit PTY output. Verified
  in a throwaway worktree at that commit; not this phase's, and not P2's either.

### Deviations, and what is left

1. **Framing is size-aware rather than raw-always** (criterion 1). The headline above.
   Everything downstream of the decision — the frontend predicate, the e2e harness's
   mirror of the rule, the bench's `auto` case — follows from it.
2. **Criteria 5 and 9 are not done, and were not mine to do.** Both are render-side
   (`TerminalSurface.onData` fast path; hidden surfaces yielding WASM `write()` to the
   visible terminal's frame budget) and live in `src/lib/terminal/**`, which P2 owned for
   the duration. Criterion 6's echo target depends on 5, so it is unmeasured. **These are
   the phase's remaining work** and should be re-assigned now that P2 has landed.
3. **#PLAN_UNCERTAINTY (grapheme tail) is only half answered.** The leading edge does make
   more, smaller chunks, so the mid-cluster case is more frequent;
   `e2e/terminal-grapheme-split.spec.ts` passes under Chromium and WebKit. What is *not*
   answered is the spec's actual question — whether echo latency measured **at the paint**
   still meets criterion 6 — because that needs criterion 5. Nobody has yet shown the
   50 ms tail timeout does not eat the leading edge's win.
4. **Files touched outside the ownership list I was given**, all of them P0 bench or e2e
   plumbing that had to move with the payload shape: `src/lib/perf/ipcBench.ts` (the `auto`
   case and the paired matrix), `e2e/terminal-open.spec.ts`, `e2e/terminal-sync.spec.ts`,
   `e2e/perf-baseline.spec.ts` (three specs that hand-built the old envelope and would have
   kept passing while exercising a shape the app no longer receives).
5. **The visibility hint is last-writer-wins per PTY**, not per subscriber. Two channels on
   one PTY (a re-attach, briefly) share the flag. Getting it wrong costs ≤ 42 ms of latency
   and never a byte, so it is recorded rather than defended against.
6. **Detach is noticed on the next chunk, not at the moment of eviction.** `cache.ts`
   exposes no eviction hook and is not mine to change, so the trigger is "a chunk arrived
   for a surface that is no longer in the document". Cost: one wasted chunk per evicted
   terminal, once. A real `onEvict` hook in `src/lib/terminal/cache.ts` would make it exact
   and is worth doing when someone owns that file.
