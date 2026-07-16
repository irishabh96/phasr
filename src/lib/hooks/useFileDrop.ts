import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { getPromptInsertTarget } from "@/lib/promptInsertTarget";
import { useUiStore } from "@/lib/store";
import { tauri } from "@/lib/tauri";

/** POSIX single-quote a path so it survives the shell when a workspace's
 *  agent terminal is the drop sink. Paths without whitespace pass through
 *  unquoted so they read naturally. */
function shellQuote(path: string): string {
  if (!/\s/.test(path)) return path;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Subscribes once (at the shell level) to Tauri's native OS file-drop
 * events and routes dropped file paths to whichever agent input is
 * active:
 *   - a focused prompt textarea → inserted at the caret (raw path); else
 *   - the active workspace's running-agent terminal → typed via
 *     `send_input_to_task` (shell-quoted).
 *
 * Tauri intercepts OS drops at the webview level (`dragDropEnabled`
 * defaults to true), so HTML5 `onDrop` never fires — this API is the
 * only way to get absolute paths. Follows the unlisten lifecycle of
 * `useTaskEvents`.
 */
export function useFileDrop() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        // `paths` only exists on the "drop" (and "enter") variants.
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (!paths?.length) return;

        const insert = getPromptInsertTarget();
        if (insert) {
          insert(paths.join(" "));
          return;
        }
        const ctx = useUiStore.getState().activeWorkspaceContext;
        if (ctx) {
          const text = paths.map(shellQuote).join(" ");
          void tauri.sendInputToTask(ctx.workspaceId, text).catch(() => {});
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
