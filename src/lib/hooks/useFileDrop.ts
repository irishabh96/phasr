import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect } from "react";
import { routeDroppedPaths } from "@/lib/terminal/drop";

/**
 * Subscribes once (at the shell level) to Tauri's native OS file-drop
 * events and hands the paths to `routeDroppedPaths`.
 *
 * Tauri intercepts OS drops at the webview level (`dragDropEnabled`
 * defaults to true), so HTML5 `onDrop` never fires — this API is the only
 * way to get absolute paths. Follows the unlisten lifecycle of
 * `useTaskEvents`.
 */
export function useFileDrop() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths;
        if (!paths?.length) return;
        // PhysicalPosition → CSS pixels, which is what a hit-test wants.
        const dpr = window.devicePixelRatio || 1;
        routeDroppedPaths(paths, {
          x: event.payload.position.x / dpr,
          y: event.payload.position.y / dpr,
        });
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
