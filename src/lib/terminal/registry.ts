import type { TerminalSurface } from "@/lib/terminal/surface";

/**
 * Every live terminal, by `data-terminal-id`.
 *
 * Unlike `bridge.ts` — which exists for e2e and is `import.meta.env.DEV`
 * gated — this one ships, because a shipped feature depends on it: an OS
 * file drop has to find the terminal it was dropped ON, and the only thing
 * that comes back from a hit-test is a DOM node carrying that id.
 *
 * Entries are removed by wrapping `dispose`, so a surface cannot outlive
 * its registration and a stale id cannot resolve to a dead terminal.
 */
const live = new Map<string, TerminalSurface>();

export function registerSurface(surface: TerminalSurface): void {
  live.set(surface.id, surface);
  const original = surface.dispose.bind(surface);
  (surface as { dispose: () => void }).dispose = () => {
    live.delete(surface.id);
    original();
  };
}

function surfaceForNode(node: Element | null): TerminalSurface | null {
  const host = node?.closest?.("[data-testid='terminal-surface']") ?? null;
  const id = host?.getAttribute("data-terminal-id");
  return id ? (live.get(id) ?? null) : null;
}

/**
 * The terminal under a viewport point — for a drop, the one the user
 * actually dropped on rather than whichever happened to hold focus.
 */
export function terminalSurfaceAt(
  clientX: number,
  clientY: number,
): TerminalSurface | null {
  return surfaceForNode(document.elementFromPoint(clientX, clientY));
}

/** The terminal the user is currently typing into, if any. */
export function focusedTerminalSurface(): TerminalSurface | null {
  return surfaceForNode(document.activeElement as Element | null);
}
