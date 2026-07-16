import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

interface ResizeHandleProps {
  /** Which edge of the panel the handle sits on. "right" grows the
   *  panel as the pointer moves right; "left" grows it as it moves left. */
  edge: "left" | "right";
  /** Current panel width in px (drag baseline). */
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
}

/**
 * A thin vertical divider that drag-resizes an adjacent panel. Uses
 * pointer events (robust for trackpad/stylus and keeps firing over the
 * webview content) and suppresses text selection during the drag.
 * Shared by both sidebars.
 */
export function ResizeHandle({
  edge,
  width,
  min,
  max,
  onResize,
  onResizeStart,
  onResizeEnd,
}: ResizeHandleProps) {
  const startX = useRef(0);
  const startW = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      startX.current = e.clientX;
      startW.current = width;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
      onResizeStart?.();

      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX.current;
        const raw = edge === "right" ? startW.current + dx : startW.current - dx;
        onResize(Math.min(max, Math.max(min, Math.round(raw))));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        onResizeEnd?.();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [edge, width, min, max, onResize, onResizeStart, onResizeEnd],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      className={cn(
        "absolute top-0 z-10 h-full w-1 cursor-col-resize select-none",
        "transition-colors duration-150",
        "hover:bg-[color-mix(in_oklab,var(--color-accent-500)_40%,transparent)]",
        edge === "right" ? "-right-0.5" : "-left-0.5",
      )}
    />
  );
}
