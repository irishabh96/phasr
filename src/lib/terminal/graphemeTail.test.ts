import { describe, expect, it } from "vitest";
import { safeWriteEnd } from "@/lib/terminal/graphemeTail";

const enc = (s: string) => new TextEncoder().encode(s);
/** What would be written now, and what would be held back. */
const split = (s: string | Uint8Array) => {
  const b = typeof s === "string" ? enc(s) : s;
  const at = safeWriteEnd(b);
  const dec = new TextDecoder();
  return { head: dec.decode(b.subarray(0, at)), heldBytes: b.length - at };
};

describe("safeWriteEnd", () => {
  it("holds nothing back for ASCII — the keystroke-echo fast path", () => {
    expect(split("ls -la\r\n")).toEqual({ head: "ls -la\r\n", heldBytes: 0 });
    expect(split("\x1b[1;36mphasr\x1b[0m")).toEqual({
      head: "\x1b[1;36mphasr\x1b[0m",
      heldBytes: 0,
    });
  });

  it("holds a trailing emoji base that a variation selector could follow", () => {
    // U+2601 alone is a small monochrome dingbat; with U+FE0F it is a
    // two-cell colour emoji. Painting the first is the flicker.
    const r = split("on ☁");
    expect(r.head).toBe("on ");
    expect(r.heldBytes).toBe(3);
  });

  it("writes the whole cluster once the selector has arrived", () => {
    expect(split("on ☁️")).toEqual({
      head: "on ☁️",
      heldBytes: 0,
    });
  });

  it("holds a trailing ZERO WIDTH JOINER", () => {
    const r = split("\u{1F468}‍");
    expect(r.heldBytes).toBe(3);
  });

  it("holds an incomplete UTF-8 sequence", () => {
    const full = enc("done ☁️");
    for (let cut = full.length - 1; cut > full.length - 6; cut -= 1) {
      const r = split(full.subarray(0, cut));
      expect(r.head.includes("�")).toBe(false);
    }
  });

  it("does not hold ordinary non-ASCII text", () => {
    expect(split("café")).toEqual({ head: "café", heldBytes: 0 });
    expect(split("───")).toEqual({
      head: "───",
      heldBytes: 0,
    });
  });

  it("is a no-op on an empty chunk", () => {
    expect(safeWriteEnd(new Uint8Array())).toBe(0);
  });

  it("never holds more than the last codepoint", () => {
    const b = enc("x".repeat(100) + "☁");
    expect(safeWriteEnd(b)).toBe(100);
  });
});

describe("TUI glyphs are never held", () => {
  it.each([
    ["box drawing", "┌─┐│└┘├┤┬┴┼"],
    ["heavy box drawing", "━┃┏┓┗┛"],
    ["block elements", "█▌▐░▒▓"],
    ["braille (spinners)", "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"],
    ["powerline (private use)", ""],
  ])("%s", (_label, glyphs) => {
    const b = new TextEncoder().encode(glyphs);
    expect(safeWriteEnd(b)).toBe(b.length);
  });
});
