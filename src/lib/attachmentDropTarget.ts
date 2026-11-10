/**
 * Imperative registry of mounted attachment targets (the New task dialog,
 * the session composer), consulted by the global file-drop router before
 * it falls back to typing paths. Same module-singleton style as
 * `promptInsertTarget`: drops are imperative and must not re-render.
 *
 * A target takes a drop when:
 *   - it is `modal` (the New task dialog: it covers the app, so a drop
 *     anywhere is meant for it), or
 *   - the drop point is over its element, or
 *   - (`focusedAttachmentTarget`) focus is inside its element. The router
 *     asks this one only after a terminal under the point has had its turn.
 * The most recently registered target wins, so a dialog opened over a
 * composer gets the drop.
 */
export interface AttachmentTarget {
  element: () => HTMLElement | null;
  modal?: boolean;
  add: (paths: string[]) => void;
}

const targets: AttachmentTarget[] = [];

export function registerAttachmentTarget(target: AttachmentTarget): () => void {
  targets.push(target);
  return () => {
    const i = targets.indexOf(target);
    if (i >= 0) targets.splice(i, 1);
  };
}

/** A modal target, or one whose element is under the point (CSS pixels). */
export function attachmentTargetAt(point: { x: number; y: number } | null): AttachmentTarget | null {
  const hit = point && typeof document.elementFromPoint === "function"
    ? document.elementFromPoint(point.x, point.y)
    : null;
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (t.modal && t.element()) return t;
    const el = t.element();
    if (hit && el?.contains(hit)) return t;
  }
  return null;
}

/** The target holding keyboard focus, if any. */
export function focusedAttachmentTarget(): AttachmentTarget | null {
  const active = document.activeElement;
  if (!active || active === document.body) return null;
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i]!;
    if (t.element()?.contains(active)) return t;
  }
  return null;
}
