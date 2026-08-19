import { describe, expect, it, vi } from "vitest";
import { toGhosttyRange } from "@/lib/terminal/backends/ghostty/links";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/tauri", () => ({ tauri: { launchApp: vi.fn() } }));

const { createTerminalLinkSource } = await import("@/lib/terminal/links");

const source = createTerminalLinkSource({
  getCwd: () => "/repo",
  getEditorId: () => "vscode",
});

/**
 * The neutral span is 0-based half-open; ghostty's range is 0-based and
 * END-INCLUSIVE. (The previous engine's was 1-based and end-inclusive — the two
 * disagreed on BOTH ends, in opposite directions, which the migration plan
 * flagged as "the off-by-one that will bite".) Asserted against the real
 * detector rather than a hand-written span.
 */
describe("toGhosttyRange", () => {
  it("translates 0-based half-open to 0-based inclusive", () => {
    expect(toGhosttyRange({ startCol: 0, endCol: 5 }, 7)).toEqual({
      start: { x: 0, y: 7 },
      end: { x: 4, y: 7 },
    });
  });

  it("collapses a single-column span onto one cell", () => {
    expect(toGhosttyRange({ startCol: 3, endCol: 4 }, 0)).toEqual({
      start: { x: 3, y: 0 },
      end: { x: 3, y: 0 },
    });
  });

  it("covers exactly the link text, no more", () => {
    const line = "see https://example.com now";
    const link = source.provide(0, line)[0];
    expect(link?.text).toBe("https://example.com");

    const range = toGhosttyRange(link!.span, 1);
    // 0-based inclusive columns → slice back with 0-based half-open.
    expect(line.slice(range.start.x, range.end.x + 1)).toBe(
      "https://example.com",
    );
  });

  it("keeps the row it was given (already 0-based)", () => {
    expect(toGhosttyRange({ startCol: 3, endCol: 4 }, 42).start.y).toBe(42);
    expect(toGhosttyRange({ startCol: 3, endCol: 4 }, 42).end.y).toBe(42);
  });
});
