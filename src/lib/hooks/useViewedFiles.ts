import { useCallback, useEffect, useState } from "react";

/**
 * "Mark viewed" for review (A-Review). Per task, in localStorage. A file's
 * viewed mark is keyed by its change size (`path@adds:removes`), so a file
 * the agent touches again after you viewed it reads as unviewed.
 */
export function viewedKey(path: string, adds: number | null, removes: number | null): string {
  return `${path}@${adds ?? "?"}:${removes ?? "?"}`;
}

const storageKey = (taskId: string) => `phasr.review.viewed.${taskId}`;

function read(taskId: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey(taskId));
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function useViewedFiles(taskId: string) {
  const [viewed, setViewed] = useState<Set<string>>(() => read(taskId));
  useEffect(() => setViewed(read(taskId)), [taskId]);
  const toggle = useCallback(
    (key: string) => {
      setViewed((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        try {
          localStorage.setItem(storageKey(taskId), JSON.stringify([...next]));
        } catch {
          /* storage full or unavailable: the in-memory mark still works */
        }
        return next;
      });
    },
    [taskId],
  );
  return { viewed, toggle };
}
