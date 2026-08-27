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

1. **Resize storm collapsed — the half that is left.** ADR-002:1584 recorded 13 `resize_task`
   calls in 220 ms for one panel toggle. **Correction (architect, 2026-08-27): the *width*
   half already shipped in 0.4.x.** `fitAnchored()` routes a width change through
   `scheduleRebuild()` on a `REBUILD_QUIET_MS = 120` timer
   (`src/lib/terminal/backends/ghostty.ts:177,545,550`), and the code comment says so: "this
   is what turns a gesture into ONE event … in place of the thirteen a single panel toggle
   used to send in 220 ms". A panel toggle animates *width*, so that specific case is done.

   What remains is the **rows-only** path: `planResize` returns `"resize"` and
   `fitAnchored()` calls `this.fit()` **immediately** (`ghostty.ts:538–544`), so a vertical
   panel animation or a window drag still emits one `resize_task` per `ResizeObserver` frame.
   Collapse that path with the same settle machinery (`src/lib/terminal/settle.ts`,
   `QUIET_MS = 120`), keeping the deliberate property that a rows-only change is cheap and
   never rebuilds. **Measure before changing anything** — record the current per-gesture call
   count for both a horizontal and a vertical gesture in the P0 table, then assert **one**
   `resize_task` per settled gesture of either kind.
2. **`[profile.release]` added to `src-tauri/Cargo.toml`** — it is currently **absent**
   (verified). Set `lto = "thin"` and `codegen-units = 1`. Free win; record the binary-size
   and build-time deltas in the PR.
3. **CI perf gates**, per the Q4 decision below — three tiers, not four thresholds:
   - **Tier 1 (counts / invariants, in CI):** zero unrecovered bytes at every `PHASR_LOAD`
     ramp step including `bulk`; no `Lagged(_) => continue` outside tests; idle
     `getRenderStats().ticks` < 5·N over N seconds (and ~30/s under flood); exactly one
     `resize_task` per settled gesture.
   - **Tier 2 (the one timing gate, in CI):** `PHASR_BENCH` throughput as a **ratio** against
     an in-job calibration workload, with an order-of-magnitude band.
   - **Tier 3 (not in CI):** idle script time and scroll frame p95 stay local/WebKit probes
     with recorded numbers — a Linux-Chromium threshold cannot speak for WKWebView.
   Every threshold is set from the P0 baseline table with explicit headroom, and the headroom
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

## ~~#PLAN_UNCERTAINTY~~ — SETTLED (Q4, below) — CI thresholds on shared runners

Perf assertions on shared CI runners are the classic source of flaky gates, and this repo has
already been bitten twice by test races (recorded in the 0.4.0 release notes). Two mitigations
to choose between:

- **(a) Ratio gates**: assert against a checked-in reference measured on the same run
  (e.g. idle script time as a fraction of a busy-loop calibration), which cancels runner
  speed.
- **(b) Generous absolute thresholds** with a wide band, catching only order-of-magnitude
  regressions.

Note also the known e2e port-collision trap: a Playwright run that reuses a dev server on 1420
from another worktree measures the wrong code — the CI gate must start its own server on an
isolated port.

## #PATH_DECISION — Q4: count invariants in CI, ratio the one timing gate, keep paint numbers out

**Decision (2026-08-27, System Architect):** three tiers, decided from what this repo's CI can
actually see.

The facts that decide it (`.github/workflows/ci.yml`, read 2026-08-27):

- CI has **three jobs — `web`, `rust`, `vt` — all `runs-on: ubuntu-latest`**, and **no
  Playwright job at all**. Promoting an idle-script or scroll-frame threshold means
  *introducing* browser perf testing to CI, on Linux.
- A GitHub Linux runner's headless Chromium **has no GPU**. That is precisely the condition
  under which ADR-002 withdrew its own Q4 table (`ADR-002:243–262`). A paint threshold measured
  there would gate on a software rasterizer that no user runs.
- The only macOS/WKWebView runner in this repo is `release.yml`, and the headline metrics
  (Activity Monitor CPU %, echo feel) need a packaged build and a human either way.

**Tier 1 — invariant / counting gates. These go into CI, unconditionally, and they are the
gates that matter.** They are runner-independent because they assert *counts and shapes*, not
times, and they catch exactly the regressions this phase fears:

- **Zero unrecovered bytes** at every `PHASR_LOAD` ramp step including `bulk` (P3 criterion 3)
  — a count, in the `rust` job.
- **`grep` invariant**: no `Lagged(_) => continue` outside test code (P3's own review
  invariant), as a shell step.
- **Idle tick count**: `getRenderStats().ticks` over N seconds of idle must be **< 5·N**, not
  "≤ X ms of script". A rAF chain going free-running again is a 60× move in a *counter*
  (~60/s vs ~1/s), so this gate has enormous headroom and zero timing sensitivity — it cannot
  flake on a slow runner, and it is the P1 regression the whole tier exists for. Same for the
  flood cadence (~30/s).
- **One `resize_task` per settled toggle** (criterion 1) — a call count, already provable in
  the mocked harness.

**Tier 2 — the one unavoidable timing gate: `PHASR_BENCH` throughput. Ratio, not absolute.**
Measure a fixed calibration workload in the same job and assert throughput as a fraction of
it, with an order-of-magnitude band. Runs in the existing `rust` job; no new infrastructure.

**Tier 3 — paint numbers (idle script time, scroll frame p95) are NOT promoted to CI
thresholds.** They stay `test.skip`-by-default probes, run locally and under
`pnpm test:e2e:webkit`, with their numbers recorded in P0's baseline table and in the PR. A
Linux-Chromium threshold for a WKWebView metric is a gate that fails for the wrong reasons and
passes for the wrong reasons; criterion 4 already forbids faking a CI gate for a metric CI
cannot see, and this is that case.

**Where this differs from the recommendation put to the architect** ("ratio/self-comparison,
before/after on the same runner in one job"): the *before/after in one job* form is rejected —
it doubles CI time by building and measuring the merge-base, and for the browser probes it
would still be A/B-ing a GPU-less renderer. The recommendation's principle (never trust an
absolute number from a shared runner) is adopted in full; it is satisfied more cheaply by
turning most gates into counts, and by an in-job calibration ratio for the one that resists.

**Rejected — (b), generous absolute thresholds for the paint metrics:** an absolute band wide
enough not to flake on a Linux runner is wide enough to miss the regression, and it would
launder a Chromium number into a guarantee about WKWebView.

If a Playwright job is added to CI for other reasons, it may run the probes for their *counting*
assertions (tier 1) only. Any new CI job must start its own dev server on an isolated port
(`E2E_PORT`), never `reuseExistingServer` on 1420.

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
