import type { TerminalSurface } from "@/lib/terminal/surface";

/**
 * How long the grid must hold still before it counts as settled.
 *
 * Frames are the wrong unit: layout driven by a query is stable for many
 * frames and THEN jumps, so "unchanged twice in a row" resolves long
 * before the thing you are waiting for has happened. A quiet period spans
 * a fast query resolving; the budget below bounds a slow one.
 */
const QUIET_MS = 120;
/** Never hold the agent longer than this, however unsettled the layout. */
const DEFAULT_BUDGET_MS = 250;

/**
 * Resolve once the surface's grid has stopped changing.
 *
 * A terminal mounts before the chrome around it has finished settling. On
 * a freshly created task `WorkspaceAgentToolbar` is gated on
 * `workspace.worktreePath`, which is null until the worktree exists — so
 * the terminal first measures against a container that is one toolbar
 * row too tall, and shrinks a moment later when the query resolves.
 *
 * Starting the PTY on that first number is not cosmetic. An agent TUI
 * reads its size ONCE at startup, draws its welcome frame to those
 * dimensions, and then repaints in place — so a SIGWINCH arriving
 * mid-boot leaves the first frame drawn to a grid that no longer exists.
 * This is the smaller sibling of the 80x24 spawn bug: same failure, two
 * rows instead of the whole width.
 *
 * Deliberately general rather than a fix to that one toolbar: any late
 * chrome (a pane animating, a font swap, the window finishing a maximise)
 * produces the same shape, and the terminal cannot know which.
 *
 * Costs at most `budgetMs` before the agent spawns — set against several
 * seconds of agent boot, and it removes a resize from the middle of it.
 */
export async function whenGridSettles(
  surface: TerminalSurface,
  budgetMs = DEFAULT_BUDGET_MS,
): Promise<void> {
  // No layout to settle against: a parked or hidden surface measures 0 and
  // would burn the whole budget for nothing.
  if (surface.element.clientWidth < 2 || surface.element.clientHeight < 2)
    return;

  const deadline = Date.now() + budgetMs;
  let quietSince = Date.now();
  while (Date.now() - quietSince < QUIET_MS && Date.now() < deadline) {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    // `fit()` reports whether rows/cols actually moved. onData/onResize are
    // wired AFTER the PTY starts, so nothing here emits a resize command.
    if (surface.fit()) quietSince = Date.now();
  }
}
