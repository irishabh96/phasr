import { useEffect, useRef } from "react";
import {
  getAssetDropTarget,
  setAssetDropTarget,
} from "@/lib/assetDropTarget";

/**
 * Registers the ticket Assets drop sink while `active` (the Brief tab is the
 * visible inner tab) and clears it on hide/unmount (Architect Stage-1 #3). The
 * handler is read through a ref so a re-render never re-registers — the
 * registration is keyed solely on `active`, so exactly one Brief owns the drop
 * target at a time and a hidden Brief never captures a drop.
 */
export function useAssetDropTarget(
  active: boolean,
  onDrop: (paths: string[]) => void,
) {
  const handlerRef = useRef(onDrop);
  handlerRef.current = onDrop;

  useEffect(() => {
    if (!active) return;
    const fn = (paths: string[]) => handlerRef.current(paths);
    setAssetDropTarget(fn);
    return () => {
      // Only clear if we're still the registered target — guards against a
      // race where the next Brief registered before this cleanup ran.
      if (getAssetDropTarget() === fn) setAssetDropTarget(null);
    };
  }, [active]);
}
