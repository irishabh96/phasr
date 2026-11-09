import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { beginPanelAnimation, endPanelAnimation, prefersReducedMotion } from "@/lib/panelMotion";
import { cn } from "@/lib/utils";

/** Longest a slide may take before we call it settled anyway (no transitionend). */
const SETTLE_FALLBACK_MS = 400;

/**
 * A side panel that collapses to an icon rail (A-Polish motion, spec P1).
 *
 * The open panel slides with `translateX` inside an `overflow: hidden`
 * box; nothing tweens `width`. The box's width — and so the centre
 * column's — changes exactly once: at the start of an expand (the panel
 * then slides into the space) and at the end of a collapse (the panel
 * slides out of the space it still owns). While a slide runs the shell
 * carries `data-panel-animating` and terminals hold their refits; the
 * final width is committed before `endPanelAnimation`, so each terminal
 * refits once, at the settled size.
 *
 * The hidden layer is unmounted once settled, so the `<aside>` (one
 * landmark, `label`) only ever holds the panel or the rail.
 */
export function SlidePanel({
  side,
  label,
  open,
  width,
  railWidth,
  rail,
  children,
  panelClassName,
  resize,
}: {
  side: "left" | "right";
  /** Accessible name of the landmark ("Sidebar", "Inspector"). */
  label: string;
  open: boolean;
  /** Expanded width in px. */
  width: number;
  /** Collapsed rail width (a CSS length, e.g. `var(--layout-rail-left)`). */
  railWidth: string;
  rail: ReactNode;
  children: ReactNode;
  panelClassName?: string;
  resize?: { min: number; max: number; onResize: (width: number) => void };
}) {
  const [settledOpen, setSettledOpen] = useState(open);
  const animating = open !== settledOpen;
  const flagged = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const hidden = side === "left" ? "translateX(-100%)" : "translateX(100%)";

  useLayoutEffect(() => {
    if (animating) {
      if (!flagged.current) {
        flagged.current = true;
        beginPanelAnimation();
      }
      // Reduced motion: no slide at all — settle in this same frame.
      if (prefersReducedMotion()) {
        setSettledOpen(open);
        return;
      }
      const el = panelRef.current;
      if (open && el) {
        // The panel was mounted by this commit at its resting place; start
        // it off-canvas so the transition has somewhere to come from.
        el.style.transition = "none";
        el.style.transform = hidden;
        void el.getBoundingClientRect();
        el.style.transition = "";
        el.style.removeProperty("transform");
      }
      const fallback = window.setTimeout(() => setSettledOpen(open), SETTLE_FALLBACK_MS);
      return () => window.clearTimeout(fallback);
    }
    // Settled: this commit already carries the final width.
    if (flagged.current) {
      flagged.current = false;
      endPanelAnimation();
    }
    return undefined;
  }, [animating, open, hidden]);

  useEffect(
    () => () => {
      if (flagged.current) {
        flagged.current = false;
        endPanelAnimation();
      }
    },
    [],
  );

  const onTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
    setSettledOpen(open);
  };

  // The panel owns the full width while open and for the whole of a
  // collapse; the rail shows while closed and for the whole of an expand.
  const wide = open || settledOpen;
  const showRail = !open || !settledOpen;
  const railInner = `calc(${railWidth} - 1px)`;

  return (
    <aside
      aria-label={label}
      data-panel={side}
      data-state={open ? "open" : "closed"}
      style={{ width: wide ? width : railWidth }}
      className={cn(
        "relative shrink-0 bg-(--color-bg-sidebar) border-(--color-border-subtle)",
        side === "left" ? "border-r" : "border-l",
      )}
    >
      <div className="absolute inset-0 overflow-hidden">
        {showRail ? (
          <div
            inert={open}
            aria-hidden={open || undefined}
            className={cn(
              "panel-rail absolute inset-y-0 flex flex-col",
              side === "left" ? "left-0" : "right-0",
              !open && animating && "panel-rail-in",
            )}
            style={{ width: railInner, opacity: open ? 0 : 1 }}
          >
            {rail}
          </div>
        ) : null}
        {wide ? (
          <div
            ref={panelRef}
            inert={!open}
            aria-hidden={!open || undefined}
            onTransitionEnd={onTransitionEnd}
            className={cn("panel-slide absolute inset-0 bg-(--color-bg-sidebar)", panelClassName)}
            style={{
              transform: open ? undefined : hidden,
              willChange: animating ? "transform" : undefined,
            }}
          >
            {children}
          </div>
        ) : null}
      </div>
      {resize && open && !animating ? (
        <ResizeHandle
          edge={side === "left" ? "right" : "left"}
          width={width}
          min={resize.min}
          max={resize.max}
          onResize={resize.onResize}
        />
      ) : null}
    </aside>
  );
}
