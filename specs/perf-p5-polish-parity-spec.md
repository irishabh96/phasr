# Spec: Perf Phase 5 — Polish to parity

**Status:** planned on `feat/iterm2-parity` · **Author:** BSA (agent) · **Date:** 2026-08-27
**Track:** P (performance) · **Ships as:** 0.4.2 · **Size:** 1–2 days
**Depends on:** P0–P4 (this phase locks their results in)
**Provenance:** derived from a local iTerm2 source read, 2026-08-27.

## Objective

Sweep the remaining known waste, take the free build-level win, and — most importantly —
**turn the program's numbers into asserted thresholds** so 0.4.2's gains cannot silently
regress the way the idle-CPU gap did between 0.3.x and 0.4.0.

## User story

- As a maintainer shipping 0.4.3 and beyond, I want the perf work in 0.4.2 defended by CI, so
  that a future change that undoes it fails a check instead of a user's battery.

## Acceptance criteria

1. **Resize storm collapsed.** One panel toggle currently sends **13 `resize_task` calls in
   220 ms** — the `<aside>` animates its width, the `ResizeObserver` refits every frame, and
   each fit that changes the grid emits a resize (ADR-002:1584). A real agent TUI repaints on
   every SIGWINCH, so that is thirteen full repaints per toggle. Collapse it with the same
   settle machinery the existing grid-rebuild debounce uses (`src/lib/terminal/settle.ts`,
   `QUIET_MS = 120`). Target: **one** `resize_task` per settled toggle.
2. **`[profile.release]` added to `src-tauri/Cargo.toml`** — it is currently **absent**
   (verified). Set `lto = "thin"` and `codegen-units = 1`. Free win; record the binary-size
   and build-time deltas in the PR.
3. **CI perf gates.** The self-comparison numbers promoted from diagnostics into asserted
   thresholds, run in CI:
   - `PHASR_BENCH` throughput ≥ threshold
   - **lagged/dropped events == 0** (`PHASR_LOAD`, every ramp step including `bulk`)
   - idle script time ≤ threshold
   - scroll frame p95 ≤ threshold
   Each threshold is set from the P0 baseline table with explicit headroom, and the headroom
   is written down next to the number so a future failure is diagnosable.
4. **A gate that cannot run in CI is not silently skipped.** Any metric that needs a packaged
   build or Activity Monitor stays a `docs/MANUAL-VERIFICATION.md` checklist item and is
   named as such in the PR. Do not fake a CI gate for a metric CI cannot see.
5. **Input path: decide, then act.** Only if P0's measurements show the per-keystroke Tauri
   invoke (String payload, `session.require`, two mutex acquisitions) actually costs something
   measurable does this phase touch it. If it does not — the plan's own expectation — record
   the measured number and **close the item explicitly** rather than leaving it open.
6. **The full targets table is re-measured and recorded** post-P4, in the P0 baseline table,
   as the 0.4.2 exit evidence:

   | Axis | Target |
   |---|---|
   | Idle CPU | ≤ 0.5% of a core per visible terminal; ~0 for hidden |
   | Echo latency | p95 ≤ 1 frame + 10 ms, measured on WKWebView |
   | Data integrity | zero dropped bytes at any output rate |
   | Scroll | frame p95 < 16.7 ms in deep scrollback |
   | Flood | `cat` of a 100 MB file keeps the whole UI interactive |
   | Cadence (A1) | flood → ~30 fps via `getRenderStats()`; typing at idle paints within 1 frame |

## #PLAN_UNCERTAINTY — CI thresholds on shared runners

Perf assertions on shared CI runners are the classic source of flaky gates, and this repo has
already been bitten twice by test races (recorded in the 0.4.0 release notes). Two mitigations
to choose between, and an architect should pick before the gates land:

- **(a) Ratio gates**: assert against a checked-in reference measured on the same run
  (e.g. idle script time as a fraction of a busy-loop calibration), which cancels runner
  speed.
- **(b) Generous absolute thresholds** with a wide band, catching only order-of-magnitude
  regressions.

Recommendation: **(b) for the CI gate, (a) for the local probe**, because the failure this is
defending against (a rAF chain going free-running again, a `Lagged => continue` creeping
back) is order-of-magnitude, not marginal. Note also the known e2e port-collision trap: a
Playwright run that reuses a dev server on 1420 from another worktree measures the wrong
code — the CI gate must start its own server on an isolated port.

## Implementation notes — verified entry points

| Piece | Location |
|---|---|
| Settle machinery to reuse for resize | `src/lib/terminal/settle.ts` — `QUIET_MS = 120` (:11), `whenGridSettles` (:38) |
| Resize command (Rust) | `src-tauri/src/commands/orchestrator.rs:178` `resize_task` → `src-tauri/src/orchestrator/service.rs:458` |
| Resize call from the frontend | `src/lib/tauri.ts:324` — `invoke<void>("resize_task", { taskId, rows, cols })` |
| Cargo profile (to add) | `src-tauri/Cargo.toml` — no `[profile.*]` section exists today |
| Throughput bench | `src-tauri/src/perfbench.rs` (`PHASR_BENCH=1`) |
| Drop-counting load harness | `src-tauri/src/loadtest.rs` (`PHASR_LOAD=1`, `PHASR_LOAD_STEPS`) |
| Idle / scroll probes | `e2e/terminal-phase0.spec.ts` (`PHASE0_PROBE=1`), `e2e/scroll-probe.spec.ts` (`SCROLL_PROBE=1`), `e2e/perf-probe.spec.ts` (`PERF_PROBE=1`) |
| WebKit runner | `playwright.webkit.config.ts` via `pnpm test:e2e:webkit` |
| CI checks to extend | the checks `CONTRIBUTING.md` names: `pnpm typecheck`, `pnpm build`, `cargo test --manifest-path src-tauri/Cargo.toml` |
| Manual checklist | `docs/MANUAL-VERIFICATION.md` |

## Test / evidence plan

- **Rust**: `resize_task` coalescing gets a unit test on whatever debounce lands host-side;
  the Rust side of resize is unchanged, so the assertion is frontend-side (see below).
- **vitest**: `src/lib/terminal/settle.ts` reuse covered by a unit test asserting N rapid
  resize requests within the quiet window produce exactly one `resize_task` invocation.
- **Playwright**: an e2e that toggles the panel and counts recorded `resize_task` calls —
  the harness *records every invoke* (`e2e/harness.ts`), so this is one of the few
  IPC-shaped things the mocked harness can prove. **Caveat, from ADR-002:1584 itself:**
  `resize_task` goes to a mock there, so the harness proves the *call count*, not that a real
  agent TUI repaints once. The repaint claim is manual.
- **CI**: the four gates from criterion 3 wired into the existing workflow.
- **Manual:** the re-measured targets table (criterion 6) on a packaged build.

## Out of scope

Any new optimisation not listed above · re-opening decisions from P1–P4 · the A4 GANG path
(P2 stretch) · feature work.
