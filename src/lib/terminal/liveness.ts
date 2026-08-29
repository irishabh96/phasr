import { diagFocus, diagNote } from "@/lib/terminal/diagnostics";
import { liveSurfaces, surfaceForNode } from "@/lib/terminal/registry";
import type { TerminalSurface } from "@/lib/terminal/surface";

/**
 * The render-loop watchdog: proof that a terminal is still painting, and
 * the one lever that brings it back when it is not.
 *
 * ## What this is a reaction to
 *
 * ghostty-web paints from a single `requestAnimationFrame` chain that
 * re-queues itself from inside its own callback. The chain IS the
 * display: if one callback fails to run, the terminal never paints
 * again — while it keeps its focus, keeps accepting keystrokes and keeps
 * feeding them to the PTY. What the user sees is a terminal that "stopped
 * responding to clicks"; what is actually true is that every click
 * landed, every keystroke arrived, and nothing was ever drawn in reply.
 * Measured (e2e/terminal-liveness.spec.ts): one swallowed frame callback
 * and the terminal is dead for the rest of its life.
 *
 * ## Since perf phase 1 (damage-driven scheduling)
 *
 * The chain is a scheduler now: `write()` DOES request a frame, and an
 * idle chain degrades to a ~1 Hz heartbeat instead of spinning at 60 fps.
 * Two consequences for this module. First, the heartbeat is itself a
 * liveness signal — but this watchdog stays, because it covers what a
 * heartbeat cannot: frames (and timers) a suspended web view swallows
 * wholesale (sleep, occlusion, App Nap). Second, "the counter did not
 * move for 200 ms" stopped being evidence — at idle that is the healthy
 * state — so every check now REQUESTS a frame first and watches whether
 * the request is honoured, which a live chain does at any cadence.
 *
 * Two things end a frame callback, and both happen to a machine that has
 * been left alone:
 *
 *   - it is never delivered — a web view suspended by sleep, occlusion or
 *     App Nap can drop a queued frame instead of deferring it;
 *   - it throws — a canvas op after the GPU process restarts, a grid freed
 *     underneath the renderer.
 *
 * `patches/ghostty-web@0.4.0.patch` closes the second (the loop body is
 * wrapped now) and makes `resume()` able to restart a chain that ended
 * with `isPaused` false, which is what made the first one permanent. This
 * module is the part that NOTICES, because a dropped frame leaves no trace
 * anywhere else.
 *
 * ## Why a watchdog and not polling
 *
 * A healthy terminal costs nothing here: the check runs only on the four
 * moments where the failure could have just happened or the user is
 * telling us it did — window focus, visibility returning, a click inside a
 * terminal, and PTY output arriving into a surface whose loop has
 * demonstrably not run (that last one lives in the backend, which is the
 * only place that can read the clock cheaply enough to do it per write).
 */

/** How long a check waits before calling the loop stalled. ~12 frames. */
export const STALL_DEADLINE_MS = 200;

/** What woke the watchdog. Carried into diagnostics verbatim. */
export type LivenessReason =
  | "window-focus"
  | "visible"
  | "click"
  | "activate"
  | "manual";

export interface LivenessTarget {
  readonly id: string;
  renderTick(): number | null;
  kickRendering(): void;
  /**
   * Ask the engine for one frame (perf phase 1). The chain is
   * damage-driven now: at idle it parks on a ~1 Hz heartbeat, so "did the
   * counter move in the last 200 ms" is only a fair question after asking
   * for a frame — a live chain honours the request within one frame at
   * any cadence, and a dead one cannot. Optional so a backend without the
   * patched engine still type-checks; absent, the check degrades to the
   * old free-running assumption.
   */
  requestFrame?(): void;
}

export interface LivenessOutcome {
  id: string;
  reason: LivenessReason;
  /** `null` when the surface is not supposed to be painting — not a fault. */
  before: number | null;
  after: number | null;
  /** Did the loop advance on its own? */
  alive: boolean;
  /** Did we have to restart it? */
  kicked: boolean;
  /** Did it still not advance AFTER the restart? */
  kickFailed: boolean;
}

export interface LivenessDeps {
  /** Injected so unit tests can drive the deadline without waiting. */
  schedule(fn: () => void, ms: number): void;
  report(outcome: LivenessOutcome): void;
}

const defaultDeps: LivenessDeps = {
  schedule: (fn, ms) => {
    // A timer, deliberately, and never `requestAnimationFrame`: the thing
    // being measured is whether animation frames still arrive, so a check
    // built out of them cannot fire in exactly the case it exists for.
    if (typeof window === "undefined") return;
    window.setTimeout(fn, ms);
  },
  report: (outcome) => {
    if (!outcome.kicked) return;
    diagNote(
      outcome.id,
      outcome.kickFailed
        ? `render loop stalled (${outcome.reason}); restart did NOT take`
        : `render loop stalled (${outcome.reason}); restarted`,
    );
    console.warn(
      `[terminal] ${outcome.id}: render loop had stopped (${outcome.reason}) — ` +
        (outcome.kickFailed
          ? "restarted, and it is STILL not painting"
          : "restarted"),
    );
  },
};

/**
 * Sample the surface's frame counter, wait, and restart the loop if it did
 * not move.
 *
 * Returns nothing on purpose — the answer arrives after the deadline, and
 * every caller is a fire-and-forget event handler. `deps.report` is the
 * seam tests read.
 */
export function verifyRenderLoop(
  surface: LivenessTarget,
  reason: LivenessReason,
  deps: LivenessDeps = defaultDeps,
): void {
  const before = surface.renderTick();
  // `null` means "not supposed to be painting" (parked, still loading, or
  // a backend with no loop at all). Kicking those would resume terminals
  // the app deliberately paused.
  if (before === null) return;

  // The probe: request a frame, then watch whether the request is
  // honoured. Without this, a healthy chain idling at the ~1 Hz heartbeat
  // reads as stalled (no tick for up to a second is its NORMAL state) and
  // every click would kick it.
  surface.requestFrame?.();

  deps.schedule(() => {
    const after = surface.renderTick();
    if (after === null || after !== before) {
      deps.report({
        id: surface.id,
        reason,
        before,
        after,
        alive: true,
        kicked: false,
        kickFailed: false,
      });
      return;
    }
    // Hidden is not stalled: a hidden page delivers no animation frames at
    // all, legitimately, so a requested frame not arriving proves nothing.
    // The `visible` trigger re-runs the check on the way back.
    if (
      typeof document !== "undefined" &&
      document.visibilityState !== "visible"
    )
      return;
    surface.kickRendering();
    deps.schedule(() => {
      const settled = surface.renderTick();
      deps.report({
        id: surface.id,
        reason,
        before,
        after: settled,
        alive: settled !== null && settled !== before,
        kicked: true,
        kickFailed: settled !== null && settled === before,
      });
    }, STALL_DEADLINE_MS);
  }, STALL_DEADLINE_MS);
}

let installed = false;

/**
 * Wire the watchdog to the whole app, once.
 *
 * Called from `factory.ts`, so it is impossible for a component to forget
 * and impossible for a second terminal to install it twice. Three
 * listeners for the whole app rather than three per surface: the events
 * are global, and per-surface listeners would be one more thing to leak.
 */
export function installTerminalLivenessWatch(
  check: (
    surface: TerminalSurface,
    reason: LivenessReason,
  ) => void = verifyRenderLoop,
): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const checkAll = (reason: LivenessReason) => {
    for (const surface of liveSurfaces()) check(surface, reason);
  };

  // Coming back to the app is the moment a suspension has just ended.
  window.addEventListener("focus", () => checkAll("window-focus"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkAll("visible");
  });

  // Perf phase 1, Q6: "hidden" includes the app being backgrounded or the
  // window occluded — states the page cannot see (a WKWebView keeps DOM
  // focus and `visibilityState === "visible"` while the app is merely
  // inactive). Tauri's window focus event is the signal, the same one
  // `useCompletionNotifications` already listens to; each live surface
  // floors its engine at the ~1 Hz heartbeat while backgrounded. Dynamic
  // import + catch: in vitest and the mocked e2e harness there is no
  // Tauri window, and the cadence then simply never degrades this way.
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        for (const surface of liveSurfaces())
          surface.setBackgrounded?.(!focused);
        if (focused) checkAll("window-focus");
      }),
    )
    .catch(() => {
      /* not running under Tauri */
    });

  // A click inside a terminal is the user's own report that it is not
  // working — the gesture they make BEFORE they tell anyone. Capture, so
  // it is recorded whatever the emulator does with the event afterwards.
  document.addEventListener(
    "mousedown",
    (event) => {
      const surface = surfaceForNode(event.target as Element | null);
      diagFocus(event, surface);
      if (surface) check(surface, "click");
    },
    { capture: true },
  );
}

/** Test seam — the installer is once-per-process by design. */
export function __resetLivenessWatch(): void {
  installed = false;
}
