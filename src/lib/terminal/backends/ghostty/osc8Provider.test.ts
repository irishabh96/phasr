import { describe, expect, it, vi } from "vitest";
import {
  createOsc8LinkProvider,
  unregisterBuiltinLinkProviders,
  type GhosttyLinkTerminal,
} from "@/lib/terminal/backends/ghostty/osc8Provider";
import type { LinkSource } from "@/lib/terminal/surface";

/**
 * The hardened OSC 8 provider. Upstream's calls
 * `window.open(uri, "_blank", "noopener,noreferrer")` on whatever the
 * terminal was told the target is — and an OSC 8 target is chosen by the
 * program that printed it, i.e. by untrusted agent output. These tests
 * pin the two things that must stay true: activation goes to the
 * `LinkSource` (which does the ⌘-gating and the scheme check), and
 * `window.open` is never reached from this file.
 */

/** A grid line built from `[hyperlinkId, char]` pairs. */
function line(cells: Array<[number, string]>) {
  return {
    length: cells.length,
    getCell: (x: number) => {
      const cell = cells[x];
      if (!cell) return undefined;
      return {
        getHyperlinkId: () => cell[0],
        getCodepoint: () => cell[1].codePointAt(0) ?? 0,
        getChars: () => cell[1],
      };
    },
  };
}

function terminal(rows: ReturnType<typeof line>[], uris: Record<number, string>) {
  const buffer = {
    length: rows.length,
    getLine: (y: number) => rows[y],
  };
  return {
    buffer: { active: buffer },
    wasmTerm: { getHyperlinkUri: (id: number) => uris[id] ?? null },
  } as unknown as GhosttyLinkTerminal;
}

function spySource() {
  const activateHyperlink = vi.fn();
  return {
    source: { provide: () => [], activateHyperlink } as LinkSource,
    activateHyperlink,
  };
}

const cells = (text: string, id: number): Array<[number, string]> =>
  [...text].map((ch) => [id, ch] as [number, string]);

describe("createOsc8LinkProvider", () => {
  it("routes activation through the LinkSource, never window.open", () => {
    const openSpy = vi.spyOn(window, "open");
    const { source, activateHyperlink } = spySource();
    const term = terminal(
      [line([...cells("ab", 0), ...cells("link", 7)])],
      { 7: "https://example.com" },
    );

    let links: unknown[] | undefined;
    createOsc8LinkProvider(term, source).provideLinks(0, (l) => {
      links = l;
    });

    expect(links).toHaveLength(1);
    const event = { metaKey: true } as MouseEvent;
    (links![0] as { activate(e: MouseEvent): void }).activate(event);

    expect(activateHyperlink).toHaveBeenCalledWith(
      "https://example.com",
      event,
    );
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("reports a 0-based END-INCLUSIVE range over the linked cells", () => {
    const { source } = spySource();
    const term = terminal(
      [line([...cells("ab", 0), ...cells("link", 7), ...cells("cd", 0)])],
      { 7: "https://example.com" },
    );
    let links: { range: { start: { x: number }; end: { x: number } } }[] = [];
    createOsc8LinkProvider(term, source).provideLinks(0, (l) => {
      links = (l ?? []) as typeof links;
    });
    // "link" occupies columns 2..5 inclusive.
    expect(links[0]!.range.start.x).toBe(2);
    expect(links[0]!.range.end.x).toBe(5);
  });

  it("joins a link that wraps across rows — Ghostty keeps the id", () => {
    const { source } = spySource();
    const term = terminal(
      [
        line([...cells("xx", 0), ...cells("https:/", 9)]),
        line([...cells("/example.com", 9), ...cells("  ", 0)]),
      ],
      { 9: "https://example.com" },
    );
    let links: { range: { start: { x: number; y: number }; end: { x: number; y: number } } }[] = [];
    createOsc8LinkProvider(term, source).provideLinks(0, (l) => {
      links = (l ?? []) as typeof links;
    });
    expect(links).toHaveLength(1);
    expect(links[0]!.range.start).toEqual({ x: 2, y: 0 });
    expect(links[0]!.range.end).toEqual({ x: 11, y: 1 });
  });

  it("emits one link per hyperlink id, not one per cell", () => {
    const { source } = spySource();
    const term = terminal([line(cells("linklink", 3))], {
      3: "https://example.com",
    });
    let links: unknown[] | undefined;
    createOsc8LinkProvider(term, source).provideLinks(0, (l) => {
      links = l;
    });
    expect(links).toHaveLength(1);
  });

  it("yields nothing on a row with no hyperlink cells", () => {
    const { source } = spySource();
    const term = terminal([line(cells("plain text", 0))], {});
    let links: unknown[] | undefined = [];
    createOsc8LinkProvider(term, source).provideLinks(0, (l) => {
      links = l;
    });
    expect(links).toBeUndefined();
  });
});

describe("unregisterBuiltinLinkProviders", () => {
  // `Terminal.open()` installs its own OSC8 + URL-regex providers with no
  // way to opt out, so the backend has to take them off afterwards. If a
  // future release renames `linkDetector` or `providers`, this must report
  // failure rather than silently leave `window.open` registered.
  it("empties the detector's provider list and says so", () => {
    const term = { linkDetector: { providers: [{}, {}] } };
    expect(unregisterBuiltinLinkProviders(term)).toBe(true);
    expect(term.linkDetector.providers).toHaveLength(0);
  });

  it("returns false when the shape it reaches for is gone", () => {
    expect(unregisterBuiltinLinkProviders({})).toBe(false);
    expect(unregisterBuiltinLinkProviders({ linkDetector: {} })).toBe(false);
    expect(
      unregisterBuiltinLinkProviders({ linkDetector: { providers: null } }),
    ).toBe(false);
  });
});
