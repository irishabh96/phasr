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
 *
 * **The focus probe below is the exception: it is ALWAYS on.** A field
 * report of "clicking does nothing" is unreproducible by construction, and
 * a diagnostic that first has to be switched on and then waited for is a
 * diagnostic that arrives one occurrence too late. It costs a ring of
 * twenty records, written on mousedown, and nothing at all otherwise — so
 * `dump()` answers the question from a cold paste, with no setup.
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
 * Theme entries that become the WASM palette, and therefore go through
 * `ghostty-web`'s `parseColorToHex`.
 *
 * `buildWasmConfig()` reads exactly these nineteen: the sixteen ANSI slots
 * plus `foreground`, `background` and `cursor`. Nothing else is passed to
 * WASM.
 */
export const WASM_BOUND_THEME_KEYS = [
  "background", "foreground", "cursor",
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;

/**
 * Theme entries the RENDERER uses as a raw canvas `fillStyle`, never through
 * `parseColorToHex`. Any valid CSS colour works here, alpha included — that
 * is the whole mechanism behind the translucent selection wash in
 * `patches/ghostty-web@0.4.0.patch`. Measured: `ctx.fillStyle = "#f7816647"`
 * is accepted and composites over black to rgb(69,36,28), the alpha-honoured
 * value.
 */
export const CANVAS_BOUND_THEME_KEYS = [
  "cursorAccent", "selectionBackground", "selectionForeground",
] as const;

/**
 * Whether a value survives `parseColorToHex`, which understands `#rgb`,
 * `#rrggbb` and `rgb(r, g, b)` and returns 0 for anything else.
 *
 * Deliberately a POSITIVE test — "this is a form the engine handles" — not
 * "it did not return 0". The dangerous case is not rejection but a silent
 * success: `#rrggbbaa` takes the `#` branch, `parseInt("f7816647", 16)` is
 * not NaN, and the engine keeps a 32-bit number it will read as 24-bit,
 * yielding a colour nobody chose. So eight-digit hex must fail here even
 * though `parseColorToHex` "accepts" it.
 *
 * WKWebView is why this matters and why no test engine can catch it:
 * `getPropertyValue` on a custom property returns the author's literal text
 * in Chromium and in Playwright's WebKit (`rgba(247, 129, 102, 0.28)`), but
 * WKWebView normalises it to `#f7816647`. A WASM-bound token carrying alpha
 * therefore ships broken and passes every suite we can run — so the rule
 * enforced in `theme.test.ts` is engine-independent: WASM-bound tokens are
 * opaque.
 */
export function isParseableByGhostty(value: string): boolean {
  const v = value.trim();
  if (/^#[0-9a-f]{3}$/i.test(v) || /^#[0-9a-f]{6}$/i.test(v)) return true;
  return /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/.test(v);
}

/** Does this colour carry alpha in any form WKWebView might normalise? */
export function carriesAlpha(value: string): boolean {
  const v = value.trim();
  return (
    /^#[0-9a-f]{4}$/i.test(v) ||
    /^#[0-9a-f]{8}$/i.test(v) ||
    /^rgba\(/i.test(v) ||
    /^hsla\(/i.test(v) ||
    /\/\s*[\d.]+%?\s*\)$/.test(v)
  );
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
  /** WASM-bound entries `ghostty-web` cannot parse — these become 0. */
  unparseableTheme: string[];
  /** WASM-bound entries carrying alpha — these are silently misread. */
  alphaInWasmTheme: string[];
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
    alphaInWasmTheme: [],
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
  // ONLY the WASM-bound keys. Flagging the canvas-bound ones was a false
  // alarm in the first field dump: `selectionBackground=#f7816647` was
  // reported as unparseable and read as a shipped bug, when that value never
  // reaches `parseColorToHex` and renders exactly as intended.
  r.unparseableTheme = WASM_BOUND_THEME_KEYS.filter((k) => {
    const v = theme?.[k];
    return typeof v === "string" && !isParseableByGhostty(v);
  }).map((k) => `${k}=${theme?.[k]}`);
  r.alphaInWasmTheme = WASM_BOUND_THEME_KEYS.filter((k) => {
    const v = theme?.[k];
    return typeof v === "string" && carriesAlpha(v);
  }).map((k) => `${k}=${theme?.[k]}`);
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

// ---------------------------------------------------------------------------
// Focus probe — always on
// ---------------------------------------------------------------------------

/** Clicks kept. Twenty is a couple of frustrated bursts, not a log. */
const MAX_FOCUS_RECORDS = 20;

/**
 * One click, and everything needed to tell the three ways it can fail
 * apart. They present identically — "I click and nothing happens" — and
 * their fixes have nothing in common, so the first job of a field report
 * is to say WHICH:
 *
 *   - the click never reached the terminal — `hit` is some overlay, or
 *     `bodyPointerEvents` is "none" (a dismissable layer that did not
 *     clean up leaves the whole app click-dead);
 *   - the click landed but focus did not follow — `activeAfter` is not
 *     inside a terminal;
 *   - focus is fine and the RENDERER is dead — `activeAfter` is the
 *     terminal, `hasFocus` is true, and `frames` did not move. This is the
 *     one the field report of 2026-08-26 turned out to be, and the only
 *     one where the terminal is simultaneously "not responding" and
 *     delivering every keystroke to the process.
 */
export interface FocusProbeRecord {
  at: number;
  /** Tag + testid/class of what was actually clicked. */
  target: string;
  /** What `elementFromPoint` says is on top there — an intercepting
   *  overlay shows up here and nowhere else. */
  hit: string;
  surfaceId: string | null;
  activeBefore: string;
  /** Sampled after the deadline, once every handler and the emulator's own
   *  deferred `focus()` have run. */
  activeAfter: string;
  activeAfterInTerminal: boolean;
  /** False when the OS gave the keyboard to another window entirely. */
  hasFocus: boolean;
  /** "none" here means nothing in the app is clickable. */
  bodyPointerEvents: string;
  /** Frame counter at click time; `null` when the surface is parked. */
  frames: number | null;
  /** Same counter after the deadline. Equal to `frames` = frozen. */
  framesAfter: number | null;
}

const focusRecords: FocusProbeRecord[] = [];

/** How long the probe waits before its second sample. */
const FOCUS_SETTLE_MS = 150;

function describe(el: Element | null | undefined): string {
  if (!el) return "none";
  const e = el as HTMLElement;
  const testid = e.getAttribute?.("data-testid");
  const cls =
    typeof e.className === "string" && e.className
      ? `.${e.className.trim().split(/\s+/).slice(0, 2).join(".")}`
      : "";
  return `${e.tagName}${testid ? `[${testid}]` : ""}${cls}`;
}

/**
 * Record a mousedown. Called for EVERY mousedown, not only the ones inside
 * a terminal: half of "focus gets removed" reports are about a plain text
 * field, and a ring that only watched terminals could not tell the two
 * readings apart.
 */
export function diagFocus(
  event: MouseEvent,
  surface: { id: string; renderTick(): number | null } | null,
): void {
  if (typeof document === "undefined") return;
  let hit = "n/a";
  try {
    hit = describe(document.elementFromPoint(event.clientX, event.clientY));
  } catch {
    /* a point outside the viewport */
  }
  const record: FocusProbeRecord = {
    at: Math.round(performance.now()),
    target: describe(event.target as Element | null),
    hit,
    surfaceId: surface?.id ?? null,
    activeBefore: describe(document.activeElement),
    activeAfter: "pending",
    activeAfterInTerminal: false,
    hasFocus: document.hasFocus(),
    bodyPointerEvents: getComputedStyle(document.body).pointerEvents,
    frames: surface?.renderTick() ?? null,
    framesAfter: null,
  };
  focusRecords.push(record);
  if (focusRecords.length > MAX_FOCUS_RECORDS) focusRecords.shift();

  window.setTimeout(() => {
    const active = document.activeElement;
    record.activeAfter = describe(active);
    record.activeAfterInTerminal = !!(
      active as HTMLElement | null
    )?.closest?.("[data-testid='terminal-surface']");
    record.framesAfter = surface?.renderTick() ?? null;
  }, FOCUS_SETTLE_MS);
}

/** Test seam. */
export function __resetFocusProbe(): void {
  focusRecords.length = 0;
}

export interface TerminalDiagnostics {
  dump(): unknown;
  /** The click ring on its own, for a quick look in the console. */
  focus(): FocusProbeRecord[];
}

export function installTerminalDiagnostics(): void {
  if (typeof window === "undefined") return;
  window.__PHASR_TERM_DIAG__ = {
    // An object rather than the bare array it used to be: the focus ring
    // is worthless if the one command people know does not include it.
    dump: () => ({
      surfaces: [...records.values()].map((r) => ({
        ...r,
        head: escape(r.head),
        // The whole point: "did the bytes carry colour" answered without a
        // screen recording.
        headHasSgrColour: /\x1b\[[0-9;]*(3[0-7]|9[0-7]|38;|48;)/.test(r.head),
      })),
      focus: [...focusRecords],
    }),
    focus: () => [...focusRecords],
  };
}

declare global {
  interface Window {
    __PHASR_TERM_DIAG__?: TerminalDiagnostics;
  }
}
