/**
 * Field diagnostics for a terminal that misrenders in a packaged build.
 *
 * `bridge.ts` is gated on `import.meta.env.DEV`, so a shipped `.app` has no
 * terminal introspection at all. Three screen recordings of a real
 * misrender could therefore be measured only in *pixels* — enough to prove
 * the prompt was painted with default attributes, and not enough to say
 * whether the cells carried colour, what palette the engine was built with,
 * or what bytes produced them. Every candidate had to be tested by trying to
 * reproduce it elsewhere, and the one environment that reproduces it is the
 * one with no instrumentation.
 *
 * This is the smallest thing that closes that gap: OFF unless explicitly
 * switched on, so it costs a `localStorage` read per surface and nothing
 * else, and it never holds a reference to a disposed terminal.
 *
 *   localStorage.setItem("phasr.diag.terminal", "1"); location.reload();
 *   copy(JSON.stringify(window.__PHASR_TERM_DIAG__.dump(), null, 2));
 */

const FLAG = "phasr.diag.terminal";

/** Bytes of PTY output kept per surface — enough for a shell's whole boot. */
const MAX_BYTES = 8 * 1024;

export function terminalDiagnosticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FLAG) === "1";
  } catch {
    // Private mode / storage denied. Diagnostics are never worth throwing for.
    return false;
  }
}

/**
 * `parseColorToHex` in `ghostty-web` understands `#rgb`, `#rrggbb` and
 * `rgb(r, g, b)` and returns 0 for anything else — so a token written as
 * `rgba(…)`, `oklch(…)`, a named colour, or CSS Color 4's space-separated
 * `rgb(r g b)` silently becomes "no colour" in the WASM palette. Measured:
 * that makes the engine fall back to its OWN palette rather than to the
 * theme's, so the terminal stays colourful but stops matching phasr.
 */
export function isParseableByGhostty(value: string): boolean {
  const v = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(v) || /^#[0-9a-f]{6}$/i.test(v)) return true;
  return /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(v);
}

export interface SurfaceDiagnostics {
  id: string;
  /** Creation order, so "the Nth terminal opened" is answerable. */
  seq: number;
  createdAt: number;
  attachedAt: number | null;
  /** Grid the engine was constructed at. */
  openedGrid: { rows: number; cols: number } | null;
  /** The theme the WASM palette was actually built from. */
  theme: Record<string, string> | null;
  /** Theme entries `ghostty-web` cannot parse — these become 0. */
  unparseableTheme: string[];
  bytesWritten: number;
  /** First `MAX_BYTES` of PTY output, escaped — the ground truth for "did
   *  the SGR actually arrive". */
  head: string;
  notes: string[];
}

const records = new Map<string, SurfaceDiagnostics>();
let seq = 0;

export function diagCreate(id: string): void {
  records.set(id, {
    id,
    seq: ++seq,
    createdAt: Math.round(performance.now()),
    attachedAt: null,
    openedGrid: null,
    theme: null,
    unparseableTheme: [],
    bytesWritten: 0,
    head: "",
    notes: [],
  });
}

export function diagAttach(
  id: string,
  theme: Record<string, string> | undefined,
  grid: { rows: number; cols: number },
): void {
  const r = records.get(id);
  if (!r) return;
  r.attachedAt = Math.round(performance.now());
  r.openedGrid = grid;
  r.theme = theme ? { ...theme } : null;
  r.unparseableTheme = Object.entries(theme ?? {})
    .filter(([, v]) => typeof v === "string" && !isParseableByGhostty(v))
    .map(([k, v]) => `${k}=${v}`);
}

export function diagWrite(id: string, data: string | Uint8Array): void {
  const r = records.get(id);
  if (!r) return;
  const text =
    typeof data === "string" ? data : new TextDecoder().decode(data);
  r.bytesWritten += typeof data === "string" ? data.length : data.length;
  if (r.head.length < MAX_BYTES) r.head += text;
}

export function diagNote(id: string, note: string): void {
  const r = records.get(id);
  if (r && r.notes.length < 64)
    r.notes.push(`${Math.round(performance.now())}ms ${note}`);
}

export function diagDispose(id: string): void {
  records.delete(id);
}

/** Escape so the dump survives a copy/paste through a chat window. */
function escape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\x1b/g, "\\e")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

export interface TerminalDiagnostics {
  dump(): unknown;
}

export function installTerminalDiagnostics(): void {
  if (typeof window === "undefined") return;
  window.__PHASR_TERM_DIAG__ = {
    dump: () =>
      [...records.values()].map((r) => ({
        ...r,
        head: escape(r.head),
        // The whole point: "did the bytes carry colour" answered without a
        // screen recording.
        headHasSgrColour: /\x1b\[[0-9;]*(3[0-7]|9[0-7]|38;|48;)/.test(r.head),
      })),
  };
}

declare global {
  interface Window {
    __PHASR_TERM_DIAG__?: TerminalDiagnostics;
  }
}
