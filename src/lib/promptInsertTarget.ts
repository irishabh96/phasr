/**
 * Imperative registry for "the prompt input the user is currently
 * editing". A focused agent-prompt textarea registers its caret-aware
 * insert function here (on focus) and clears it (on blur); the global
 * file-drop handler (`useFileDrop`) calls it to drop a path at the
 * caret. Kept out of the zustand store on purpose — this is imperative
 * and must not trigger re-renders. Mirrors the module-singleton style
 * of `disposeMainTerminal` / `disposeSessionTerminal`.
 */
type Inserter = (text: string) => void;

let target: Inserter | null = null;

export function setPromptInsertTarget(fn: Inserter | null) {
  target = fn;
}

export function getPromptInsertTarget(): Inserter | null {
  return target;
}
