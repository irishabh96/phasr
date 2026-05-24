import { useEffect, useState } from "react";

/**
 * Returns a value that lags `source` by `delayMs`. Useful for
 * pipelining a typing-driven input into a network query without
 * firing one request per keystroke.
 */
export function useDebouncedValue<T>(source: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(source);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(source), delayMs);
    return () => clearTimeout(t);
  }, [source, delayMs]);
  return debounced;
}
