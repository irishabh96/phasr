import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { beginPanelAnimation, endPanelAnimation, prefersReducedMotion } from "@/lib/panelMotion";
import { cn } from "@/lib/utils";

/**
 * Longest a toggle may take before we call it settled anyway (no
 * `transitionend`, e.g. a toggle undone within one frame, so the width never
 * moved). Restarted on every toggle.
 */
const SETTLE_FALLBACK_MS = 400;

/**
 * A side panel that collapses to an icon rail (spec §5, P1).
 *
 * The `<aside>` is a slot whose **width** animates (160ms, `--ease-out`),
 * so the centre column grows and shrinks with it, continuously. Inside the
 * slot the panel keeps its full width and is clipped, anchored to the
 * slot's inner edge: its text never rewraps mid-flight, it just slides with
 * the edge while it fades out (the rail fades in over the same transition,
 * at the outer edge).
 *
 * Terminals don't refit while the slot moves: the shell carries
 * `data-panel-animating` from the toggle until the slot's own `width`
 * transition ends (or the fallback timer fires), then every terminal fits
 * exactly once at the settled size (lib/terminal/refit).
 *
 * Interruptions are CSS's job: toggling mid-flight retargets the running
 * transition from the current width, and only the final transition ends
 * the hold. Nothing here stores an intermediate position, so there is no
 * state in which the slot, the panel or the rail can be left between two
 * states.
 *
 * The transition is only applied while toggling, so a drag-resize (and any
 * other width change) is instant. The hidden layer is unmounted once
 * settled, so the `<aside>` (one landmark, `label`) holds only the panel or
 * only the rail at rest.
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
  // A toggle starts an animation in the same render that changes the width,
  // so the slot's transition is in place when its width changes.
  const [shownOpen, setShownOpen] = useState(open);
  const [animating, setAnimating] = useState(false);
  if (open !== shownOpen) {
    setShownOpen(open);
    setAnimating(true);
  }

  const panelRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const flagged = useRef(false);
  const reduced = prefersReducedMotion();
  const motion = animating && !reduced;

  // The panel exists while open and for the whole of any toggle; the rail
  // while closed and for the whole of any toggle.
  const showPanel = open || animating;
  const showRail = !open || animating;
  const hadPanel = useRef(showPanel);
  const hadRail = useRef(showRail);

  useLayoutEffect(() => {
    // A layer mounted by this toggle starts transparent, so it fades in.
    if (motion) {
      if (!hadPanel.current && panelRef.current) fadeFromZero(panelRef.current);
      if (!hadRail.current && railRef.current) fadeFromZero(railRef.current);
    }
    hadPanel.current = showPanel;
    hadRail.current = showRail;
  });

  useLayoutEffect(() => {
    if (animating) {
      if (!flagged.current) {
        flagged.current = true;
        beginPanelAnimation();
      }
      // Reduced motion: the width has already been applied instantly; settle
      // in this same task so the terminals refit straight away.
      if (reduced) {
        setAnimating(false);
        return undefined;
      }
      // Restarted on every toggle (`open` is a dependency).
      const fallback = window.setTimeout(() => setAnimating(false), SETTLE_FALLBACK_MS);
      return () => window.clearTimeout(fallback);
    }
    // Settled: this commit already carries the final width and no
    // transition, so the refits `endPanelAnimation` triggers measure it.
    if (flagged.current) {
      flagged.current = false;
      endPanelAnimation();
    }
    return undefined;
  }, [animating, open, reduced]);

  useEffect(
    () => () => {
      if (flagged.current) {
        flagged.current = false;
        endPanelAnimation();
      }
    },
    [],
  );

  const onTransitionEnd = (e: TransitionEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || e.propertyName !== "width") return;
    // A transition that completed in the same frame as a newer toggle still
    // reports its end; the newer one is the one that counts.
    if (widthTransitionRunning(e.currentTarget)) return;
    setAnimating(false);
  };

  const railInner = `calc(${railWidth} - 1px)`;
  const ease = "var(--dur-2) var(--ease-out)";

  return (
    <aside
      aria-label={label}
      data-panel={side}
      data-state={open ? "open" : "closed"}
      data-animating={motion || undefined}
      onTransitionEnd={onTransitionEnd}
      style={{
        width: open ? width : railWidth,
        transition: motion ? `width ${ease}` : "none",
      }}
      className={cn(
        "relative shrink-0 bg-(--color-bg-sidebar) border-(--color-border-subtle)",
        side === "left" ? "border-r" : "border-l",
      )}
    >
      <div className="absolute inset-0 overflow-hidden">
        {showRail ? (
          <div
            ref={railRef}
            inert={open}
            aria-hidden={open || undefined}
            className={cn(
              "panel-rail absolute inset-y-0 flex flex-col",
              side === "left" ? "left-0" : "right-0",
              open ? "opacity-0" : "opacity-100",
            )}
            style={{ width: railInner }}
          >
            {rail}
          </div>
        ) : null}
        {showPanel ? (
          <div
            ref={panelRef}
            inert={!open}
            aria-hidden={!open || undefined}
            className={cn(
              "panel-content absolute inset-y-0 bg-(--color-bg-sidebar)",
              // Anchored to the inner edge: it leaves and arrives with it.
              side === "left" ? "right-0" : "left-0",
              open ? "opacity-100" : "opacity-0",
              panelClassName,
            )}
            style={{ width: `calc(${width}px - 1px)` }}
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

/** Start `el`'s opacity transition from 0 (it was just mounted at its end value). */
function fadeFromZero(el: HTMLElement) {
  el.style.transition = "none";
  el.style.opacity = "0";
  void el.getBoundingClientRect();
  el.style.removeProperty("transition");
  el.style.removeProperty("opacity");
}

function widthTransitionRunning(el: HTMLElement): boolean {
  if (typeof el.getAnimations !== "function") return false;
  return el
    .getAnimations()
    .some(
      (a) =>
        typeof CSSTransition !== "undefined" &&
        a instanceof CSSTransition &&
        a.transitionProperty === "width" &&
        a.playState === "running",
    );
}
