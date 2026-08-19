import type { ILink, ILinkProvider } from "ghostty-web";
import type { LinkSource } from "@/lib/terminal/surface";

/**
 * OSC 8 hyperlink provider — vendored from `ghostty-web@0.4.0`'s
 * `OSC8LinkProvider` (MIT, Coder) and **hardened**.
 *
 * ## Why vendor at all
 *
 * Upstream's provider activates with:
 *
 * ```js
 * activate: (e) => { (e.ctrlKey || e.metaKey) && window.open(uri, "_blank", "noopener,noreferrer"); }
 * ```
 *
 * — `window.open` on an arbitrary `uri`, with **no scheme validation**.
 * An OSC 8 target is chosen by whatever program printed it, i.e. by an
 * agent's untrusted output, so `javascript:`, `file:` and `data:` targets
 * all reach the OS/webview. That is a security regression against phasr's
 * `isOpenableUrl` gate, which is why this file exists: activation is
 * routed to `LinkSource.activateHyperlink`, the same policy the previous
 * backend used, and `window.open` never appears.
 *
 * ## Why we can't simply "not register" upstream's
 *
 * **This contradicts the migration plan's gap table.** `Terminal.open()`
 * registers `new OSC8LinkProvider(this)` *and* `new UrlRegexProvider(this)`
 * unconditionally (`dist/ghostty-web.js`, in `open()`), with no option to
 * suppress them — so "never register upstream's" is not achievable by
 * omission. `unregisterBuiltinLinkProviders()` below drops them off the
 * `LinkDetector` after `open()` instead, and the backend calls it before
 * registering ours. `e2e/terminal-links.spec.ts` asserts the result
 * (`javascript:`/`file:` OSC 8 → zero opener invokes), because that
 * removal reaches through a private field and must fail loudly, in CI, if
 * a future release renames it.
 *
 * ## What is kept from upstream
 *
 * The multi-row range walk: Ghostty preserves `hyperlink_id` across
 * wrapped lines, so a URL that wraps is one link, and finding its extent
 * means walking cells with the same id backwards and forwards across row
 * boundaries. That logic is upstream's, unchanged in substance.
 */

/** The slice of `ghostty-web`'s `Terminal` these providers actually use. */
export interface GhosttyLinkCell {
  getHyperlinkId(): number;
  getCodepoint(): number;
  getChars(): string;
}

export interface GhosttyLinkLine {
  readonly length: number;
  getCell(x: number): GhosttyLinkCell | undefined;
}

export interface GhosttyLinkBuffer {
  readonly length: number;
  getLine(y: number): GhosttyLinkLine | undefined;
}

export interface GhosttyLinkTerminal {
  readonly buffer: { readonly active: GhosttyLinkBuffer };
  readonly wasmTerm?: { getHyperlinkUri(id: number): string | null } | undefined;
}

/**
 * Drop the link providers `Terminal.open()` installed for us.
 *
 * `linkDetector` and its `providers` array are both private in the `.d.ts`
 * but plain own properties at runtime. Returns `false` when the shape it
 * expects isn't there, so the caller can decide loudly rather than
 * silently running with an unvalidated `window.open` handler registered.
 */
export function unregisterBuiltinLinkProviders(term: unknown): boolean {
  const detector = (term as { linkDetector?: { providers?: unknown } })
    .linkDetector;
  if (!detector || !Array.isArray(detector.providers)) return false;
  detector.providers.length = 0;
  return true;
}

/**
 * OSC 8 links on one row, activated through `source.activateHyperlink`.
 *
 * @param y 0-based absolute buffer row, as ghostty-web hands it out.
 */
export function createOsc8LinkProvider(
  term: GhosttyLinkTerminal,
  source: LinkSource,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y);
      const wasm = term.wasmTerm;
      if (!line || !wasm) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      const seen = new Set<number>();
      for (let x = 0; x < line.length; x++) {
        const id = line.getCell(x)?.getHyperlinkId() ?? 0;
        if (id === 0 || seen.has(id)) continue;
        seen.add(id);

        const uri = wasm.getHyperlinkUri(id);
        if (!uri) continue;

        links.push({
          text: uri,
          range: findLinkRange(term.buffer.active, id, y, x),
          // The ONE line that differs in substance from upstream: policy
          // (⌘-gating + `isOpenableUrl` + `openUrl`) belongs to the
          // source, so a backend can never quietly weaken it.
          activate: (event: MouseEvent) => source.activateHyperlink(uri, event),
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
    dispose() {},
  };
}

/**
 * Full extent of the link with `id`, starting from a known cell inside it.
 * Walks backwards then forwards over contiguous cells carrying the same
 * `hyperlink_id`, crossing row boundaries only when the run reaches the
 * edge of a row — which is how a wrapped URL stays one link.
 *
 * Range is **0-based, end-inclusive** on both axes (ghostty's convention).
 */
function findLinkRange(
  buffer: GhosttyLinkBuffer,
  id: number,
  row: number,
  col: number,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  let startRow = row;
  let startCol = col;
  const first = buffer.getLine(startRow);
  if (first) {
    while (startCol > 0) {
      const cell = first.getCell(startCol - 1);
      if (!cell || cell.getHyperlinkId() !== id) break;
      startCol--;
    }
    if (startCol === 0) {
      let probe = startRow - 1;
      while (probe >= 0) {
        const line = buffer.getLine(probe);
        if (!line || line.length === 0) break;
        const last = line.getCell(line.length - 1);
        if (!last || last.getHyperlinkId() !== id) break;
        startRow = probe;
        startCol = 0;
        for (let x = line.length - 1; x >= 0; x--) {
          const cell = line.getCell(x);
          if (!cell || cell.getHyperlinkId() !== id) {
            startCol = x + 1;
            break;
          }
        }
        if (startCol !== 0) break;
        probe--;
      }
    }
  }

  let endRow = row;
  let endCol = col;
  const last = buffer.getLine(endRow);
  if (last) {
    while (endCol < last.length - 1) {
      const cell = last.getCell(endCol + 1);
      if (!cell || cell.getHyperlinkId() !== id) break;
      endCol++;
    }
    if (endCol === last.length - 1) {
      let probe = endRow + 1;
      while (probe < buffer.length) {
        const line = buffer.getLine(probe);
        if (!line || line.length === 0) break;
        const head = line.getCell(0);
        if (!head || head.getHyperlinkId() !== id) break;
        endRow = probe;
        endCol = 0;
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x);
          if (!cell) break;
          if (cell.getHyperlinkId() !== id) {
            endCol = x - 1;
            break;
          }
          endCol = x;
        }
        if (endCol !== line.length - 1) break;
        probe++;
      }
    }
  }

  return { start: { x: startCol, y: startRow }, end: { x: endCol, y: endRow } };
}
