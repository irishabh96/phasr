# Spec: iTerm2 Parity Program — Overview

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Baseline:** v0.4.1 · **Provenance:** derived from a local read of `gnachman/iTerm2`
@ `368a48d` (2026-08-26) reconciled against phasr's shipping pipeline (`src-tauri/src/pty/`,
`src/lib/terminal/`, `ghostty-web@0.4.0` + `patches/ghostty-web@0.4.0.patch`), ADR-002, and
`docs/MANUAL-VERIFICATION.md`.

> This spec and its siblings are **self-contained**. Every number, table and mechanism an
> implementer needs is copied here. Do not look for an external plan document.

## Objective

Close the gap between phasr's embedded terminal and iTerm2 on the two axes users actually
feel — **performance** (idle cost, echo latency, scroll smoothness, flood behaviour, never
dropping a byte) and **agent-workflow features** (knowing what an agent is doing, navigating
its output, being told when it settles, searching an unbounded stream).

phasr's normal state is *many hidden agent sessions streaming at once*. That makes the cost
of an invisible session and the truth of a session's status more valuable to us than to
iTerm2, which optimises for one foreground shell.

## User stories

- As a developer leaving phasr open all day, I want an idle window to cost nothing, so the
  app is not the reason my battery drains.
- As a developer typing in a terminal, I want the echo to feel native, so phasr does not
  read as "a web page pretending to be a terminal".
- As a developer running an agent that floods output, I want every byte to arrive intact,
  so what I read is what the program printed.
- As a developer supervising several agents, I want to know at a glance which one is
  working, which is waiting on me, and which is done.
- As a developer reading a 10 000-line agent transcript, I want to jump between commands,
  see exit codes, and search — so the stream is a document, not a wall.

## Program map

| Track | What | Size | Ships as | Spec |
|---|---|---|---|---|
| **P** — Performance | Perf phases 0–5, amendments A1–A6 folded in | ~10–16 days | 0.4.2 | `perf-p0-measurement-baseline-spec.md`, `perf-p1-frame-scheduling-spec.md`, `perf-p2-renderer-hot-path-spec.md`, `perf-p3-backpressure-zero-drop-spec.md`, `perf-p4-pipe-shrink-spec.md`, `perf-p5-polish-parity-spec.md` |
| **S1** — Spike | ghostty-web OSC hook surface | ½ day | during 0.4.2 | `iterm2-spike-s1-ghostty-osc-surface-spec.md` |
| **S2** — Spike | Claude Code hook-injection channel | ½ day | before 0.5.0 | `iterm2-spike-s2-claude-hook-channel-spec.md` |
| **F1** — Agent status via hooks | cc-status state model over local IPC | ~3–4 days | 0.5.0 | `f1-agent-status-hooks-spec.md` |
| **F2** — Command marks (OSC 133) | marks, exit codes, navigation | ~6–8 days | 0.5.x | `f2-command-marks-osc133-spec.md` |
| **F3** — Notify on quiet/finish | one-shot arm + baseline + debounce | ~2 days | 0.5.x | `f3-notify-quiet-finish-spec.md` |
| **F4** — Find / filter / tail-find | search over unlimited scrollback | ~5 days | 0.6.0 | `f4-find-filter-tail-find-spec.md` |
| **F5** — QoL batch | smart selection; folding (design-first) | ~2 days + design | 0.6.x | `f5-smart-selection-folding-spec.md` |

## Sequencing rules (binding)

```
0.4.2  ── Track P (perf phases 0→1→2→3→4→5)
            └─ in parallel: S2 → F1 groundwork (Rust/UI, disjoint from the engine patch)
            └─ S1 run during 0.4.2 hardening
0.5.0  ── F1 agent status
0.5.x  ── F2 marks → F3 notify (F3 lands right after F2's first slice)
0.6.0  ── F4 find / filter / tail-find
0.6.x  ── F5 smart selection; folding design doc → go/no-go
```

1. **No feature work steals days from Track P until Phase 3 (zero dropped bytes) has
   landed.** Phase 3 is the only *correctness* item in the whole program; everything else is
   speed or capability. F1 groundwork may run in parallel only because it touches Rust
   command/UI code and never the engine patch or the PTY pipeline.
2. **Every ghostty-web patch change goes in its own commit**, separate from phasr-side
   changes in the same PR, so hunks stay upstreamable to `coder/ghostty-web`. Patch commits
   must regenerate `patches/ghostty-web@0.4.0.patch` (pnpm `patchedDependencies`, see
   `package.json`) and never hand-edit `node_modules/`.
3. **Track P phases land in order 0 → 1 → 2 → 3 → 4 → 5.** Phase 0 first is non-negotiable:
   every recorded perf number in the repo is Chromium, and ADR-002 (lines 243–262) withdraws
   its own cross-engine table for exactly that reason. Phases 1 and 3 are independent of
   each other and each safe to land alone if the order must bend.
4. **F2 does not start before S1 returns a decision.** F3 consumes F1 and F2 signals but
   degrades to its output-quiet timer if either is absent. F4 depends on nothing.
5. Every track lands behind its own automated coverage **plus** an entry appended to
   `docs/MANUAL-VERIFICATION.md`, because the mocked-IPC e2e harness (`e2e/harness.ts`)
   cannot validate hook transport, the OSC patch, real PTY bytes, or WKWebView paint cost.

## Parity targets — acceptance criteria for the whole program

Copied here as the single authority; each Track P phase spec restates the subset it owns.

| Axis | Target |
|---|---|
| Idle CPU | ≤ 0.5% of a core per **visible** terminal; ~0 for hidden |
| Echo latency | p95 ≤ 1 frame + 10 ms, measured on WKWebView (not Chromium) |
| Data integrity | zero dropped bytes at any output rate |
| Scroll | frame p95 < 16.7 ms in deep scrollback |
| Flood | `cat` of a 100 MB file keeps the whole UI interactive |
| Cadence (from A1) | observably adaptive: flood drops the frame rate to ~30 fps (verified via `getRenderStats()`); typing at idle paints within 1 frame |

## Already at or better than parity — do not spend here

- **Memory**: 7.06 MiB engine + 5.21 MiB per terminal; 10 000 scrollback lines ≈ +0.06 MiB
  (ADR-002 §Q5). Better than iTerm2's footprint.
- DEC 2026 synchronized output (patched, 150 ms bounded).
- Row-level dirty tracking for a visible terminal, **including while scrolled back** — the
  v0.4.1 scroll program fixed the "repaint every row every frame while scrolled" behaviour.
- Parked terminals pause rendering (`pause()`/`resume()` patch; LRU in
  `src/lib/terminal/cache.ts`).
- No DOM/React in the paint path; no CSS hazards on the terminal surface.
- The 32 KiB / 8 ms coalescer bounding IPC at ≤ 125 events/s per PTY
  (`src-tauri/src/pty/handle.rs:657,661`).

## Explicit non-goals (decided — do not re-litigate)

- **tmux `-CC` integration.** Weeks of protocol edge cases for a non-headline need.
- **Instant Replay.** Requires owning the grid diff; scrollback + F2 marks covers the agent
  use case.
- **Password manager.**
- **Python-API-style scripting.**
- **Moving the VT engine to Rust for performance.** `src-tauri/src/vt/` exists for state
  inspection ("has the TUI taken over?"), not rendering. Shipping grid state from Rust would
  push *more* structured data across the same expensive IPC boundary. A webview-side engine
  is the right architecture for a Tauri app.
- **Widening the 8 ms coalescer window.** ADR-002:1250–1260 rejected it: it adds latency to
  every keystroke echo. Perf Phase 4's leading-edge flush is the correct move.
- Later candidates, explicitly *not* in this program (0.7+): portholes (inline markdown
  rendering of agent output), a multi-line composer with history, OSC 1337
  `SetUserVar`/badge-style session variables.

## #PATH_DECISION — copy iTerm2's state models, not its transports

iTerm2 master ships a purpose-built Claude Code integration (`cc-status` hook shim → OSC
21337 status protocol → Cockpit panel, with priority/snooze rules and ancestor-chain job
detection). Someone already designed and debugged phasr's core product loop.

**Decision: Track F copies the debugged *state model* and *UI rules*, and carries them over
our own local IPC** — not over an escape-sequence side channel. Rationale: an escape
sequence has to survive our coalescer, our WASM parser and our IPC anyway, and would need a
new engine patch (S1's risk) to be observable; a direct channel to the Rust backend has none
of those dependencies and is testable in a Rust unit test.

The one place we deliberately *do* adopt the escape-sequence transport is F2, because OSC
133 is an interoperability standard every shell integration already emits — there we want
the wire format, not just the model.

## #PLAN_UNCERTAINTY — cross-branch dependency for F1's fallback

The "honest status" liveness pipeline (Working/Idle/Wedged/Done/Failed via TUI markers and a
CPU sensor) is **not on `master`** and therefore not on this branch. It lives on
`feat/task-board` (`src-tauri/src/orchestrator/liveness.rs`, `src/lib/agentLiveness.ts`,
`src/lib/deriveAgentState.ts`), which was pushed to origin but never merged.

What exists on this branch is coarser: `list_task_activity`
(`src-tauri/src/commands/orchestrator.rs:61`) returns `lastOutputAt` per task, consumed by
`useRecentlyActiveTasks` (`src/lib/hooks/useTaskActivity.ts`, 10-minute timeout, 60 s poll)
to drive the sidebar activity dot in `src/components/AppSidebar.tsx`.

**An architect must decide before F1 starts** whether F1 targets (a) this branch's
`lastOutputAt` model with hook state layered on top, or (b) a merged `feat/task-board`
baseline. F1's spec is written against (a) with the integration seam isolated so (b) is a
localized change.

## #PLAN_UNCERTAINTY — F2's reflow problem is harder than the plan assumed

The plan says marks should be remapped "through the same offsets `reflow.ts` computes".
**`reflow.ts` computes no offsets.** `planResize` (`src/lib/terminal/reflow.ts:39`) returns
`"none"` / `"resize"` / `"rebuild"`, and a **width change takes the `"rebuild"` path**: the
grid is thrown away and re-fed from serialized *cells* (`src/lib/terminal/serialize.ts`),
because ghostty-web's `ghostty_terminal_resize` has no anchor and "a byte stream is only true
at the geometry it was written for". There is no old-row→new-row mapping to remap through —
the content is regenerated at a different wrap.

`serialize.ts` already names OSC 8 hyperlink targets as something the rebuild loses. OSC 133
marks are in the same category. Three options are laid out in the F2 spec; **an architect must
choose one before F2 starts.**

## Corrections made while verifying against v0.4.1

Recorded here so nobody re-derives them from the (gitignored, now-stale) plan documents:

| Claim in the plan | Verified reality |
|---|---|
| `PHASR_TASK_ID` is set in `terminal_env()` | **It does not exist.** `terminal_env(shell)` (`src-tauri/src/pty/shell.rs:73`) sets only TERM/COLORTERM/TERM_PROGRAM/SHELL/LANG + macOS PATH, and takes no task id. Introducing it is S2/F1 work. |
| "all **four** forwarders swallow `RecvError::Lagged`" | **Five** on the async broadcast — the plan missed `commands/orchestrator.rs:209` — plus two `TryRecvError::Lagged` sites inside `handle.rs` (:566, :602). |
| `orchestrator/service.rs:576` | Drifted to **`:612`**. |
| Dirty tracking bypassed while scrolled back | **Fixed in v0.4.1.** The row loop honours dirty flags while scrolled (`dist/ghostty-web.js:1496–1497`). What remains is the per-row `getScrollbackLine` fetch and the full redraw during *active* scrolling. |
| ghostty-web dist anchors 1433 / 1538 / 1548 / 2454 | Drifted in the patched dist to **1452 / 1567 / 1547+1576 / 2495**. `getLine` **241** and `getViewport` **225** are unchanged. |
| `options.ts:44` for the cursor-blink default | Drifted; the default is `options.ts:84` (`cursorBlink: settings?.cursorBlink ?? true`). Line 40 is now `UNLIMITED_SCROLLBACK_BYTES`. |
| `notifications.rs` route seam | It is `src-tauri/src/commands/notifications.rs`, not `src-tauri/src/notifications.rs`. |
| "the existing honest-status liveness pipeline" | Not on this branch — see the cross-branch section above. |
| `reflow.ts` computes remap offsets | It does not — see the F2 reflow section above. |

Verified **unchanged and exact**: `handle.rs:260` (unbounded `std::sync::mpsc::channel`),
`:213` (`broadcast::channel(2048)`), `:745` (`log.write_all`), `:804`
(`recorded.push(event.clone())`), `:14` (`REPLAY_BUFFER_BYTES = 128 * 1024`), `:657`/`:661`
(32 KiB / 8 ms), and every ADR-002 anchor cited (243–262, 275–276, 820–830, 1250–1260, 1584).
`[profile.release]` is confirmed **absent** from `src-tauri/Cargo.toml`.

## Out of scope for this overview

Per-phase implementation detail, file-level task breakdowns, and per-track test plans — all
live in the individual specs listed in the program map.
