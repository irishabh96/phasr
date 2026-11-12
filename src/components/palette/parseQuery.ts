/**
 * ⌘K query grammar (A-Palette): no prefix searches everything; a leading
 * `>` narrows to commands, `#` to tasks, `@` to files, `?` to shortcuts help.
 */
export type PaletteMode = "all" | "commands" | "tasks" | "files" | "help";

const PREFIX: Record<string, PaletteMode> = { ">": "commands", "#": "tasks", "@": "files", "?": "help" };

export function parseQuery(raw: string): { mode: PaletteMode; text: string } {
  const trimmed = raw.trimStart();
  const mode = PREFIX[trimmed[0] ?? ""];
  if (mode) return { mode, text: trimmed.slice(1).trim() };
  return { mode: "all", text: raw.trim() };
}

/**
 * Match score for `text` against a candidate: contiguous substring beats a
 * subsequence; earlier and word-start matches rank higher. null = no match.
 * Returns the matched range for highlighting (contiguous matches only).
 */
export function scoreMatch(
  text: string,
  candidate: string,
): { score: number; range: [number, number] | null } | null {
  if (!text) return { score: 0, range: null };
  const q = text.toLowerCase();
  const c = candidate.toLowerCase();
  const at = c.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s/._-]/.test(c[at - 1]!);
    return { score: 1000 - at + (wordStart ? 200 : 0) - c.length * 0.1, range: [at, at + q.length] };
  }
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (let j = 0; j < c.length && i < q.length; j++) {
    if (c[j] === q[i]) {
      if (last >= 0) gaps += j - last - 1;
      last = j;
      i++;
    }
  }
  if (i < q.length) return null;
  return { score: 300 - gaps - c.length * 0.1, range: null };
}
