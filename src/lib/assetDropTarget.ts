/**
 * Imperative registry for "the ticket Assets zone that should capture an OS
 * file-drop right now". Mirrors `promptInsertTarget.ts` (module singleton, kept
 * out of the zustand store so it never triggers re-renders).
 *
 * Architect Stage-1 #3: the Brief tab registers this ONLY while it is the
 * ACTIVE/visible inner tab and clears it on hide — never on mount. All inner
 * tabs mount at once, so a hidden Brief must not hijack drops, and two open
 * workspaces must never cross-route a drop to the wrong ticket. The section
 * editors deliberately do NOT register as a `promptInsertTarget`, so dropping a
 * file while editing a section attaches an asset (not a path string).
 *
 * Precedence (`useFileDrop`): focused prompt-insert target → asset-drop target
 * → active-workspace agent PTY. So the Brief's Assets zone wins over the
 * terminal fallback while it's visible.
 */
type AssetDropHandler = (paths: string[]) => void;

let target: AssetDropHandler | null = null;

export function setAssetDropTarget(fn: AssetDropHandler | null) {
  target = fn;
}

export function getAssetDropTarget(): AssetDropHandler | null {
  return target;
}
