# Spec: Perf Phase 3 — Never drop a byte: backpressure + recovery (incl. amendment A3)

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** P (performance) · **Ships as:** 0.4.2 · **Size:** 2–3 days
**Depends on:** P0 (baselines) · **Independent of:** P1, P2 (Rust-only)
**Blocks:** all Track F work — no feature work proceeds until this lands.
**Provenance:** derived from a local iTerm2 source read, 2026-08-27.

## Objective

**This is the only correctness item in the program.** Today phasr silently drops PTY output
under flood. A dropped chunk is a hole in a VT stream: the display is silently corrupted
until the program does a full repaint. iTerm2 never drops output — it stops reading the fd.

## The bug, verified in the code

1. **Reader→coalescer channel is unbounded.** `src-tauri/src/pty/handle.rs:260`:

   ```rust
   let (bytes_tx, bytes_rx) = std::sync::mpsc::channel::<Vec<u8>>();
   ```

   `std::sync::mpsc::channel` is unbounded — the reader thread (`pump_pty_output`, spawned
   just below at :261–269) never blocks, so the kernel PTY buffer never fills, so the child
   never blocks in `write()`. There is no backpressure anywhere in the pipeline.

2. **Coalescer→frontend broadcast drops oldest on overflow.** `handle.rs:213` creates
   `broadcast::channel::<PtyEvent>(2048)`. Tokio's broadcast drops the oldest value for a
   lagging receiver and reports `RecvError::Lagged(n)`.

3. **Every forwarder swallows `Lagged` with `continue`.** Verified sites (the plan said
   "four"; there are **five** on the async broadcast, plus two `TryRecvError` sites inside
   `handle.rs` itself):

   | File | Line | Form |
   |---|---|---|
   | `src-tauri/src/commands/orchestrator.rs` | 149 | `Err(RecvError::Lagged(_)) => continue,` |
   | `src-tauri/src/commands/orchestrator.rs` | **209** | `Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,` — **not in the original plan's list** |
   | `src-tauri/src/commands/session_terminal.rs` | 153 | `Err(RecvError::Lagged(_)) => continue,` |
   | `src-tauri/src/commands/run_commands.rs` | 251 | `Err(RecvError::Lagged(_)) => continue,` |
   | `src-tauri/src/orchestrator/service.rs` | **612** | `Err(broadcast::error::RecvError::Lagged(_)) => continue,` — plan cited 576; the line drifted |
   | `src-tauri/src/pty/handle.rs` | 566, 602 | `Err(TryRecvError::Lagged(_)) => continue,` — internal drains; audit these too |

   Reference sites that already do the right thing and should be the model:
   `src-tauri/src/loadtest.rs:170` and `src-tauri/src/perfbench.rs:263` both **count** the
   lagged events rather than ignoring them. `src-tauri/src/loadtest.rs:19` and
   `src-tauri/src/vt/mod.rs:10` document the bug in prose already.

4. **The log writer is synchronous, unbuffered and unbounded.** `handle.rs:745`:
   `let _ = log.write_all(&bytes);` — one syscall per ~4 KB PTY read, on the coalescer
   thread, with no rotation. 47 MB observed on the dev machine.

This is the still-open half of report item **D3**.

## User story

- As a developer watching an agent flood output, I want every byte the program printed to
  reach my screen, so what I read is the truth and not a partially-repainted corruption.

## Acceptance criteria

1. **Reader→coalescer is bounded with a blocking send.** `handle.rs:260` becomes a
   `std::sync::mpsc::sync_channel` with **40–64 slots** (see A3 for the bound's provenance).
   When the pipeline stalls, the reader stops reading; the kernel PTY buffer fills; the child
   blocks in `write()`. This is how every native terminal throttles `yes`.
2. **Broadcast lag is recovered, never swallowed.** At **every** site in the table above,
   `Lagged` triggers recovery rather than `continue`:
   - The coalescer already writes every byte to the per-task log before any framing decision
     (`handle.rs:743–745`, and the comment there says exactly that: *"The log is the raw byte
     stream, written before any framing decision"*). Track a **log byte offset per event** and,
     on `Lagged`, **backfill the missed range from the log**.
   - Hidden-session forwarders may instead resubscribe via `subscribe_with_replay`
     (`handle.rs:321`, whose contract is "Everything already produced, plus everything
     produced from now on — each chunk **exactly once**"; the replay lock deliberately spans
     both halves — see `subscribe_with_replay_locked`, `handle.rs:826`).
   - **Minimum bar, if backfill is not reachable for a given site:** emit a
     `stream desynced` event so the frontend forces a full repaint, rather than rendering
     corruption. A site that neither backfills nor signals fails this criterion.
3. **Zero *unrecovered* bytes at every ramp step** (architect, Q3 corollary).
   `PHASR_LOAD=1` (`src-tauri/src/loadtest.rs`, steps configurable via `PHASR_LOAD_STEPS`)
   already counts drops (:170). The harness asserts that the stream a subscriber reconstructs
   — live events plus backfill — is **byte-identical to the per-task log** at every step,
   including a new **unthrottled `bulk` step**. Lag events are counted and reported, not
   asserted at zero: a fully backfilled `Lagged` is not a dropped byte.
4. **Log writer is buffered and bounded.** A `BufWriter` flushed on the coalesce tick, plus
   size-capped rotation. `read_task_log` and the B1 replay corpus keep working — the comment
   at `handle.rs:743–745` names both as dependants; rotation must not break either.
5. **Throughput does not regress.** `PHASR_BENCH=1` (`src-tauri/src/perfbench.rs`) throughput
   is within noise of the P0 baseline. A backpressured pipeline is allowed to be *slower than
   the kernel*; it is not allowed to be slower than today at rates that fit.
6. **A blocked reader never deadlocks or hangs the app.** A child that stops reading its own
   input while phasr's pipeline is stalled must not wedge the UI thread; the reader thread is
   already dedicated and blocking (`handle.rs:261–269`, thread `phasr-pty-{task_id}`), so
   confirm the block stays confined there.
7. **Report item D3 is closed** in whatever tracker holds it, citing the loadtest assertion
   as evidence.

## #PATH_DECISION — A3: the bounded channel *is* the design; do not invent a scheme

iTerm2 does **not** stop selecting the fd. Its reader thread blocks on a **counting
semaphore** before parsing more (`TokenExecutor.swift:104`), with `bufferDepth` defaulting to
**40** chunks of ~1 KB ≈ **40 KB in flight per session** → the kernel PTY buffer fills → the
child blocks in `write()`.

Phase 3.1's bounded `sync_channel` with a blocking send is **the same mechanism**. 40–64
slots is the empirically right bound: it matches iTerm2's in-flight budget while staying
above our 32 KiB coalesce threshold, so a single flush never starves.

iTerm2's own tmux code warns against precisely our current bug
(`PTYSession.m:10641–10652`): *"infinite data could be buffered by GCD, breaking the
backpressure mechanism."*

**Decision: bounded channel + blocking send. Do not build a rate limiter, a sampling scheme,
a drop-with-marker scheme, or an adaptive buffer.** Any of those re-introduces the bug in a
politer form.

## ~~#PLAN_UNCERTAINTY~~ — SETTLED (Q3, below) — recovery mechanism per forwarder

Two viable recovery strategies exist (log backfill vs. replay resubscribe) and the right one
may differ per site: visible-terminal forwarders want *exact* backfill; hidden-session
forwarders may be satisfied by a replay resubscribe, which is cheaper but is bounded by
`REPLAY_BUFFER_BYTES = 128 * 1024` (`handle.rs:14`) — a lag larger than 128 KB cannot be
recovered from replay alone.

An architect must settle: (a) is per-site divergence acceptable, or must all five sites use
one mechanism? and (b) if replay is used, does `REPLAY_BUFFER_BYTES` rise here or in P4
(which also wants it raised, for LRU re-attach)? Recommendation: **log backfill everywhere**
(one mechanism, unbounded history, and the log write already exists), with the replay path
kept only as the cold-attach path it is today.

## #PATH_DECISION — Q3: one mechanism *per stream class*, because two of the five sites carry no bytes

**Decision (2026-08-27, System Architect): log backfill is the single recovery mechanism for
every forwarder that carries PTY bytes. It is not applied to the two sites that carry task
*status* events, because those broadcasts have no log to backfill from. `REPLAY_BUFFER_BYTES`
does not change in this phase (see P4).**

This overrules the "uniformly at all five sites" framing on the evidence: the five-site table
above conflates two different broadcast channels. Verified by reading each site:

| Site | Channel | Payload | Recovery |
|---|---|---|---|
| `commands/orchestrator.rs:149` (`spawn_task_event_forwarder`) | `broadcast::Sender<PtyEvent>` | PTY bytes | **log backfill** |
| `commands/session_terminal.rs:153` (`forward`) | `broadcast::Sender<PtyEvent>` | PTY bytes | **log backfill** |
| `commands/run_commands.rs:251` (`forward`) | `broadcast::Sender<PtyEvent>` | PTY bytes | **log backfill** |
| `commands/orchestrator.rs:209` (`spawn_status_bridge`) | `broadcast::Sender<TaskStatusEvent>` | `{task_id, repository_id, status, exit_code}` | **state resync** |
| `orchestrator/service.rs:612` (exit watcher) | `broadcast::Sender<PtyEvent>` consumed for `Exit` only | one terminal event | **re-read child state** |
| `pty/handle.rs:566` (`watch_after_typing`), `:602` (`wait_for_tui`) | `PtyEvent` via `try_recv` | PTY bytes, scanned for markers | **reset the scanner carry** |

Rules, one per class:

1. **PTY-byte forwarders (3 sites) — log backfill, exactly as recommended.**
   `PtyEvent::Output` gains a **log byte offset** stamped by the coalescer
   (`handle.rs:740–760`), the forwarder tracks the last offset+len it delivered, and on
   `Lagged` it reads the gap out of the per-task log before delivering the event that revealed
   the lag. Ordering and de-duplication are by offset, so a backfill can never double-write.
   Three implementation facts the implementer must not discover the hard way:
   - The log is opened `create(true).append(true)` (`handle.rs:251`), so a task id reused
     across app runs appends to an existing file. **Offsets are file-absolute and must be
     seeded from the file length at open**, not from zero.
   - Criterion 4 adds a `BufWriter`. Bytes still in that buffer are not readable through the
     file. Track a `flushed_through: AtomicU64` updated after each flush (which happens on the
     coalesce tick, i.e. within `COALESCE_WINDOW` = 8 ms); a backfill request beyond
     `flushed_through` retries once after one window and then falls through to the desync
     event. Never read past it and never assume the file is current.
   - Criterion 4 also adds rotation. A gap that starts before the rotation boundary is
     **unrecoverable by construction** → desync event. That is the honest floor, and it is why
     the rotation cap must be large enough to cover any lag the broadcast can produce
     (2048 events × 32 KiB ≈ 64 MiB worst case — size the cap against that number, and record
     the arithmetic in the PR).
2. **Status-event sites (2 sites) — resync, not backfill.** A missed `TaskStatusEvent` is a
   missed *state transition*, and the authoritative state is in the workspace store. On
   `Lagged`, re-read and re-emit the current status for every live task rather than
   `continue`. This is cheap, idempotent, and correct; backfilling it from a byte log is not
   even definable. `service.rs:612` waits for one `Exit`: on `Lagged` it must ask the child's
   state directly rather than assume the exit is still coming.
3. **Internal marker scanners (`handle.rs:566`, `:602`) — reset the carry.** A `Lagged` here
   means the byte stream has a hole, and `TuiMarkerScanner` keeps a `carry` of the trailing
   bytes (`handle.rs:632`, written at `:646`). Stitching that carry onto a post-hole chunk can synthesise a
   marker that was never emitted — a **false TUI-readiness positive**, which is the failure
   mode that once cost this repo a prompt-delivery bug. On `Lagged`: clear `carry`, count the
   event, keep scanning (the deadline already backstops a missed marker). No backfill: these
   scanners run before any frontend exists and are inherently lossy-tolerant.

**Rejected — per-site divergence between backfill and replay-resubscribe** for the byte
forwarders: two mechanisms means two test surfaces and a "which one ran?" question at every
incident. `subscribe_with_replay` stays exactly what it is today — the cold-attach path.
**Rejected — one mechanism literally everywhere:** it is not implementable; see the table.

## #PATH_DECISION — Q3 corollary: what the bounded channel actually bounds

Recorded because criterion 1's rationale, as drafted, claims more than the pipeline can
deliver, and the difference decides how this phase is *verified*.

`emit_output` (`handle.rs:788`) pushes to the replay buffer and calls `tx.send`, and a tokio
broadcast send **never blocks** — it overwrites the oldest slot. So a slow *frontend* exerts no
backpressure on the coalescer, and therefore none on the reader, and therefore none on the
child. Bounding the reader→coalescer channel makes the child block in `write()` only when the
**coalescer itself** is the bottleneck (a disk stall on the log write, which is the one
genuinely blocking call it makes).

**Decision: keep the bounded `sync_channel` — it converts an unbounded memory queue into a
real stall signal and it is the right shape — but the zero-drop guarantee is carried by the
backfill mechanism (criterion 2), not by criterion 1.** Consequences:

- Criterion 3 is asserted as **zero unrecovered bytes**, not zero `Lagged` events: the load
  harness (`loadtest.rs:170`) must count lag *and* prove the reconstructed stream is
  byte-identical to the log. A `Lagged` that was fully backfilled is not a drop.
- **Rejected — making the coalescer block on a bounded per-subscriber queue** to get true
  end-to-end backpressure: one slow or wedged webview surface would then stall every hidden
  agent's PTY. phasr's normal state is many hidden sessions; a UI hiccup must never be able to
  pause an agent's work.
- The reader thread must **exit cleanly when the send fails** (the coalescer having gone away
  closes the channel), so a dead coalescer cannot leave a reader parked forever on a full
  channel with the child blocked behind it. Add it to criterion 6's assertion.

## #EXPORT_CRITICAL — log rotation and what the log contains

The per-task log is the raw PTY byte stream: it contains everything an agent printed,
including anything the user pasted into the terminal. Rotation must **delete** rotated
segments rather than moving them somewhere longer-lived, and the rotation cap must be a
documented, bounded number. This phase must not make the log more durable than it is today.

**Architect note (2026-08-27):** the Q3 decision makes the log load-bearing for recovery, which
pulls the cap *up* (it must exceed the broadcast's worst-case in-flight bytes, ≈ 64 MiB), while
this section pulls it *down*. They are compatible — the log is **unbounded** today (47 MB
observed), so any cap is strictly less durable than the status quo — but the number must be
chosen deliberately, with both constraints named in the PR, and rotated segments deleted.

## Implementation notes — verified entry points

| Piece | Location |
|---|---|
| Unbounded reader→coalescer channel | `src-tauri/src/pty/handle.rs:260` |
| Reader thread (`phasr-pty-{task_id}`, calls `pump_pty_output`) | `src-tauri/src/pty/handle.rs:261–269` |
| Coalescer thread (`phasr-pty-out-{task_id}`) | `src-tauri/src/pty/handle.rs:271–287` |
| Broadcast channel, capacity 2048 | `src-tauri/src/pty/handle.rs:213` |
| Coalescer loop: log write, buffer, deadline, flush | `src-tauri/src/pty/handle.rs:740–760` |
| `COALESCE_BYTES = 32 * 1024` / `COALESCE_WINDOW = 8 ms` | `src-tauri/src/pty/handle.rs:657` / `:661` |
| `pump_pty_output` (reader body) / `coalesce_pty_output` (coalescer body) | `src-tauri/src/pty/handle.rs:680` / `:715` |
| `flush_output` — replay push + broadcast send | `src-tauri/src/pty/handle.rs:773`, clone at `:804` |
| `subscribe_with_replay` (exactly-once contract) / `subscribe_with_replay_locked` | `src-tauri/src/pty/handle.rs:321` / `:826` |
| `read_task_log` (log consumer that rotation must not break) | `src-tauri/src/commands/orchestrator.rs:168` |
| `REPLAY_BUFFER_BYTES = 128 * 1024` | `src-tauri/src/pty/handle.rs:14` |
| Five `Lagged` swallow sites | see table above |
| Load harness that counts drops | `src-tauri/src/loadtest.rs:170` (`PHASR_LOAD=1`, `PHASR_LOAD_STEPS`) |
| Throughput bench | `src-tauri/src/perfbench.rs` (`PHASR_BENCH=1`) |

## Parity target this phase owns

| Axis | Target |
|---|---|
| Data integrity | zero dropped bytes at any output rate |

(Full table in `specs/perf-p0-measurement-baseline-spec.md`.)

## Test / evidence plan

- **Rust is the primary suite here** (`cargo test --manifest-path src-tauri/Cargo.toml`):
  - `PHASR_LOAD=1` ramp with drops asserted at 0, including the new `bulk` step.
  - `PHASR_BENCH=1` throughput before/after.
  - New unit tests: bounded-channel send blocks when full and resumes; `Lagged` at each
    forwarder produces backfill or a desync event (never a silent `continue`); log rotation
    preserves `read_task_log` behaviour across a rotation boundary.
- **grep-checkable invariant** for review: no `Lagged(_) => continue` remains outside test
  code. State this in the PR description with the command used.
- **Mocked-IPC limitation, stated:** `e2e/harness.ts` never spawns a PTY and synthesizes
  chunks on the JS side — it **cannot** exercise backpressure, the broadcast, or the log at
  all. There is no Playwright coverage of this phase; the Rust tests are the evidence.
- **Manual:** add a `docs/MANUAL-VERIFICATION.md` entry — `cat` a 100 MB file in a packaged
  build and confirm (a) the UI stays interactive and (b) the final screen matches
  `tail` of the same file, i.e. no hole.

## Out of scope

Reducing per-byte cost (P4) · raw-bytes IPC (P4.1) · leading-edge flush (P4.3) · frontend
repaint-on-desync UI polish beyond emitting the event · anything in the renderer.
