import { useCallback, useRef } from "react";
import { setPromptInsertTarget } from "@/lib/promptInsertTarget";

/**
 * Wires a controlled agent-prompt textarea up to the global file-drop
 * handler. While the textarea is focused it registers a caret-aware
 * inserter with `setPromptInsertTarget`, so dropping a file inserts its
 * path at the cursor. Spread the returned `ref`/`onFocus`/`onBlur` onto
 * the `GlassTextarea` (it's `forwardRef`, so the ref reaches the DOM
 * node).
 */
export function usePromptDropTarget(
  value: string,
  setValue: (v: string) => void,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Keep the live value in a ref so the inserter (registered once per
  // focus) never splices into a stale closure value.
  const valueRef = useRef(value);
  valueRef.current = value;

  const insert = useCallback(
    (text: string) => {
      const el = ref.current;
      const cur = valueRef.current;
      if (!el) {
        setValue(cur ? `${cur} ${text}` : text);
        return;
      }
      const start = el.selectionStart ?? cur.length;
      const end = el.selectionEnd ?? cur.length;
      setValue(cur.slice(0, start) + text + cur.slice(end));
      const caret = start + text.length;
      // Restore the caret after React re-renders with the new value.
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    },
    [setValue],
  );

  const onFocus = useCallback(() => setPromptInsertTarget(insert), [insert]);
  const onBlur = useCallback(() => setPromptInsertTarget(null), []);

  return { ref, onFocus, onBlur };
}
