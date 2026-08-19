import type { ILink, ILinkProvider } from "ghostty-web";
import type {
  LinkSource,
  LinkSpan,
  SurfaceDisposable,
} from "@/lib/terminal/surface";
import type { GhosttyLinkTerminal } from "@/lib/terminal/backends/ghostty/osc8Provider";

/**
 * ghostty binding for a `LinkSource`. All policy (what counts as a link, ⌘-gating,
 * scheme validation, path resolution) lives in the source; the only thing
 * this file knows is how ghostty-web spells "link".
 *
 * Three differences from the previous binding, all verified against
 * `ghostty-web@0.4.0`'s shipped `dist/ghostty-web.js`:
 *
 * 1. `provideLinks(y, cb)` is handed a **0-based absolute buffer row** and
 *    the callback takes `undefined` for "no links"; the previous engine
 *    handed out a 1-based row.
 * 2. `ILink` has **no `decorations`**. That field drove the underline/pointer
 *    cursor from that field; ghostty-web draws a hover underline itself
 *    from `renderer.setHoveredLinkRange`, driven by its own throttled
 *    mousemove handler, so there is nothing to pass and nothing missing.
 * 3. The line text has to be built cell-by-cell — see `lineToText`.
 */
export function createGhosttyLinkProvider(
  term: GhosttyLinkTerminal,
  source: LinkSource,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = lineToText(line);
      const links: ILink[] = source.provide(y, text).map((link) => ({
        text: link.text,
        range: toGhosttyRange(link.span, y),
        activate: (event: MouseEvent) => link.activate(event),
      }));
      callback(links.length > 0 ? links : undefined);
    },
    dispose() {},
  };
}

/**
 * Neutral span → ghostty range. The neutral span is 0-based half-open;
 * ghostty's range is 0-based and **END-INCLUSIVE**, so the start is
 * unchanged and the end loses one.
 *
 * This is the exact off-by-one the previous binding got wrong in the other
 * direction (`start.x = c + 1, end.x = e`), which is why the translation
 * is exported and unit-tested against the real detector rather than a
 * hand-written span. Getting it wrong here shifts every ghostty link one
 * column and drops its last character — invisible until someone ⌘-clicks
 * the end of a URL.
 */
export function toGhosttyRange(span: LinkSpan, bufferRow: number) {
  return {
    start: { x: span.startCol, y: bufferRow },
    end: { x: span.endCol - 1, y: bufferRow },
  };
}

/**
 * One character per CELL, so a string index equals a grid column.
 *
 * `IBufferLine.translateToString()` cannot be used for anything
 * positional: it renders a cell with codepoint 0 — never written, and the
 * trailing half of a double-width grapheme — as the **empty string**
 * (`getChars()` returns `""` for codepoint 0). So `\x1b[10G` followed by
 * text yields a string whose index 0 is grid column 9, and every link span
 * would be reported at the wrong columns. ghostty-web's own
 * `UrlRegexProvider` builds its text this same way, which is the tell that
 * `translateToString` is not the intended positional API.
 */
export function lineToText(line: {
  readonly length: number;
  getCell(x: number): { getCodepoint(): number; getChars(): string } | undefined;
}): string {
  const out: string[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell) {
      out.push(" ");
      continue;
    }
    const code = cell.getCodepoint();
    out.push(code === 0 || code < 32 ? " " : cell.getChars());
  }
  return out.join("");
}

/** Structural no-op disposable — ghostty-web has no unregister API. */
export function noopDisposable(): SurfaceDisposable {
  return { dispose: () => {} };
}
