import { GhosttySurface, preloadGhosttyEngine } from "@/lib/terminal/backends/ghostty";
import { registerSurfaceForTests } from "@/lib/terminal/bridge";
import { installTerminalDiagnostics } from "@/lib/terminal/diagnostics";
import { installTerminalLivenessWatch } from "@/lib/terminal/liveness";
import { registerSurface } from "@/lib/terminal/registry";
import { itermSequenceFor } from "@/lib/terminal/keymap";
import type {
  TerminalSurface,
  TerminalSurfaceSettings,
} from "@/lib/terminal/surface";

/**
 * Start fetching the ghostty chunk (and compiling its WASM) at module
 * load, which is many hundreds of milliseconds before any terminal mounts
 * — routes have to resolve and the settings query has to land first.
 *
 * A surface created before that finishes is still correct: `GhosttySurface`
 * queues writes and input and replays them on attach. This just means the
 * queue is normally empty, so the PTY is spawned at the real grid size
 * rather than at 80×24 followed by a resize.
 */
void preloadGhosttyEngine().catch(() => {
  // Reported by the surface that actually needs it.
});

/**
 * The one place a terminal is constructed. Every surface leaves here with
 * the iTerm keymap and clipboard support already attached, so no component
 * has to remember — and a backend that needs real clipboard listeners (as
 * opposed to one that gets them from its own hidden textarea) gets them
 * without touching a single component.
 *
 * There is exactly ONE engine now. The previous engine and the backend flag
 * were removed after ghostty-web had been used in anger; rollback is a git
 * revert, not a `localStorage` key (ADR-002). `TerminalSurface` stays: it
 * is what made this swap safe and what makes the next one cheap.
 *
 * Both disposables are intentionally dropped: they are owned by the
 * surface and die with it.
 */
export function createTerminalSurface(
  settings?: Partial<TerminalSurfaceSettings>,
): TerminalSurface {
  const surface = new GhosttySurface(settings);
  surface.installKeymap(itermSequenceFor);
  surface.installClipboard();
  // DEV-only, and here rather than in the components so the terminal is
  // introspectable by e2e without touching a single call site.
  registerSurfaceForTests(surface);
  // Ships (unlike the bridge): an OS file drop resolves the terminal it
  // landed on through this.
  registerSurface(surface);
  // Both ship, and both are installed once for the whole app. Here rather
  // than in a component or in `main.tsx` for the same reason as the two
  // registries above: a terminal that exists is a terminal that is
  // watched, with nothing to remember at any call site.
  //
  // The diagnostics global carries the always-on focus probe, so it is
  // installed unconditionally — the byte-level recorder inside it still
  // needs its localStorage flag.
  installTerminalDiagnostics();
  installTerminalLivenessWatch();
  return surface;
}
