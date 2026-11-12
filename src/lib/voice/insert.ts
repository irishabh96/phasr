/**
 * Put dictated `text` into `value` in place of the selection
 * `[start, end)`, the way typing it would: a space before it unless it
 * starts a line or follows whitespace, and a space after it when it runs
 * into a word. Returns the new value and where the caret goes.
 */
export function insertDictation(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const t = text.trim();
  const s = Math.max(0, Math.min(start, value.length));
  const e = Math.max(s, Math.min(end, value.length));
  if (!t) return { value, caret: e };
  const before = value.slice(0, s);
  const after = value.slice(e);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = after !== "" && /^[\p{L}\p{N}]/u.test(after) ? " " : "";
  const inserted = lead + t + trail;
  return { value: before + inserted + after, caret: before.length + lead.length + t.length };
}

/** "0:07", "1:42". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
