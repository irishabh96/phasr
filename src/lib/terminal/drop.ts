import { getPromptInsertTarget } from "@/lib/promptInsertTarget";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";
import {
  focusedTerminalSurface,
  terminalSurfaceAt,
} from "@/lib/terminal/registry";

/** POSIX single-quote a path so it survives the shell. Paths without
 *  whitespace pass through unquoted so they read naturally. */
export function shellQuote(path: string): string {
  if (!/\s/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Where a dropped file's path goes, in priority order:
 *
 *   1. the terminal it was dropped ON — typed through the surface, so the
 *      bytes follow whichever PTY that terminal is wired to (agent, shell
 *      tab, run command) with no per-kind branching here;
 *   2. a prompt textarea being edited — raw path at the caret;
 *   3. the terminal that currently has the keyboard;
 *   4. the active workspace's agent terminal.
 *
 * Position-first matters. The emulator has no drop support of its own —
 * no `drop`, `dragover` or `dataTransfer` anywhere in ghostty-web — and
 * Tauri swallows HTML5 drops at the webview level, so before this a drop
 * on a shell tab or a run-command pane went to the workspace's agent
 * instead, or nowhere at all.
 *
 * `point` is in CSS pixels; callers converting from Tauri's PhysicalPosition
 * must divide by devicePixelRatio first.
 */
export function routeDroppedPaths(
  paths: string[],
  point: { x: number; y: number } | null,
): void {
  if (!paths.length) return;
  const quoted = paths.map(shellQuote).join(" ");

  const dropped = point ? terminalSurfaceAt(point.x, point.y) : null;
  if (dropped) {
    dropped.input(quoted);
    return;
  }

  const insert = getPromptInsertTarget();
  if (insert) {
    insert(paths.join(" "));
    return;
  }

  const focused = focusedTerminalSurface();
  if (focused) {
    focused.input(quoted);
    return;
  }

  const ctx = useUiStore.getState().activeWorkspaceContext;
  if (ctx) void tauri.sendInputToTask(ctx.workspaceId, quoted).catch(() => {});
}
