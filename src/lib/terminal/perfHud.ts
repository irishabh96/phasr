/**
 * The dev-mode perf HUD — the visual half of `perf.ts`.
 *
 * A small read-only overlay pinned to the terminal's top-right corner.
 * Reachable only through `createSurfacePerf`, which is compile-time dead
 * in production builds; nothing here needs its own gate.
 *
 * Design notes (design-system): tokens only — `--color-bg-tooltip` ground
 * with the same border treatment as every floating surface, `--font-mono`
 * at 10px (it is a column of numbers), `--color-text-secondary` ink with
 * `--color-warning`/`--color-danger` reserved for a p95 over the parity
 * target (16.7ms frame + 10ms budget from the overview spec). Non-
 * interactive by construction: `pointer-events: none`, `aria-hidden` — it
 * must never eat a click aimed at the terminal, and it has no states to
 * design beyond its numbers. Both themes come free from the tokens.
 */

import type { PerfSnapshot } from "@/lib/terminal/perf";

/** Echo p95 above this is over the program's parity target (1 frame + 10ms). */
const ECHO_WARN_MS = 26.7;
/** Above this it is not a slow frame, it is a stall. */
const ECHO_BAD_MS = 50;

export interface PerfHud {
  update(snapshot: PerfSnapshot): void;
  dispose(): void;
}

function fmtBytes(perSec: number): string {
  if (perSec >= 1_048_576) return `${(perSec / 1_048_576).toFixed(1)} MB/s`;
  if (perSec >= 1024) return `${(perSec / 1024).toFixed(1)} KB/s`;
  return `${Math.round(perSec)} B/s`;
}

function fmtBacklog(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function attachPerfHud(host: HTMLElement): PerfHud | null {
  if (typeof document === "undefined") return null;

  // The surface element is a plain `h-full w-full` div; the HUD needs a
  // positioning context. Only claim it when nothing else has.
  if (getComputedStyle(host).position === "static") {
    host.style.position = "relative";
  }

  const el = document.createElement("div");
  el.setAttribute("data-testid", "terminal-perf-hud");
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = [
    "position:absolute",
    "top:4px",
    "right:20px", // clear of the engine's overlay scrollbar
    "z-index:10",
    "pointer-events:none",
    "user-select:none",
    "font-family:var(--font-mono)",
    "font-size:10px",
    "line-height:1.5",
    "white-space:pre",
    "color:var(--color-text-secondary)",
    "background:color-mix(in srgb, var(--color-bg-tooltip) 88%, transparent)",
    "border:1px solid var(--color-border-subtle)",
    "border-radius:var(--radius-sm)",
    "padding:4px 8px",
  ].join(";");
  host.appendChild(el);

  const rowEcho = document.createElement("div");
  const rowFrame = document.createElement("div");
  const rowIo = document.createElement("div");
  el.append(rowEcho, rowFrame, rowIo);

  return {
    update(s: PerfSnapshot): void {
      const { latency } = s;
      rowEcho.textContent =
        latency.count === 0
          ? "echo     — (type to measure)"
          : `echo     ${latency.last.toFixed(1)}ms  p50 ${latency.p50.toFixed(1)}  p95 ${latency.p95.toFixed(1)}  n=${latency.count}`;
      rowEcho.style.color =
        latency.p95 > ECHO_BAD_MS
          ? "var(--color-danger)"
          : latency.p95 > ECHO_WARN_MS
            ? "var(--color-warning)"
            : "var(--color-text-secondary)";
      rowFrame.textContent = `fps      ${s.fps.toFixed(1)}`;
      rowIo.textContent = `in       ${fmtBytes(s.bytesPerSec)}  backlog ${fmtBacklog(s.backlogBytes)}`;
      rowIo.style.color =
        s.backlogBytes > 0
          ? "var(--color-warning)"
          : "var(--color-text-secondary)";
    },
    dispose(): void {
      el.remove();
    },
  };
}
