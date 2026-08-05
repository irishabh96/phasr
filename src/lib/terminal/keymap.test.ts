import { describe, expect, it } from "vitest";
import { itermSequenceFor } from "@/lib/terminal/keymap";

function keydown(
  key: string,
  mods: Partial<
    Pick<KeyboardEvent, "metaKey" | "altKey" | "ctrlKey" | "shiftKey">
  > = {},
) {
  return new KeyboardEvent("keydown", {
    key,
    metaKey: mods.metaKey ?? false,
    altKey: mods.altKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
  });
}

describe("itermSequenceFor — hello.itermkeymap parity", () => {
  it("⇧↵ sends ESC CR (Claude Code insert-newline)", () => {
    expect(itermSequenceFor(keydown("Enter", { shiftKey: true }))).toBe(
      "\x1b\r",
    );
  });

  it("⌘ line editing", () => {
    expect(itermSequenceFor(keydown("ArrowLeft", { metaKey: true }))).toBe(
      "\x01",
    );
    expect(itermSequenceFor(keydown("ArrowRight", { metaKey: true }))).toBe(
      "\x05",
    );
    expect(itermSequenceFor(keydown("Backspace", { metaKey: true }))).toBe(
      "\x15",
    );
  });

  it("⌥ word editing", () => {
    expect(itermSequenceFor(keydown("ArrowLeft", { altKey: true }))).toBe(
      "\x1bb",
    );
    expect(itermSequenceFor(keydown("ArrowRight", { altKey: true }))).toBe(
      "\x1bf",
    );
    expect(itermSequenceFor(keydown("Backspace", { altKey: true }))).toBe(
      "\x1b\x7f",
    );
    expect(itermSequenceFor(keydown("Delete", { altKey: true }))).toBe(
      "\x1bd",
    );
    expect(itermSequenceFor(keydown("ArrowUp", { altKey: true }))).toBe(
      "\x1b\x1b[A",
    );
    expect(itermSequenceFor(keydown("ArrowDown", { altKey: true }))).toBe(
      "\x1b\x1b[B",
    );
  });

  it("forward delete sends ^D", () => {
    expect(itermSequenceFor(keydown("Delete"))).toBe("\x04");
  });

  it.each([
    ["ArrowUp", "A"],
    ["ArrowDown", "B"],
    ["ArrowRight", "C"],
    ["ArrowLeft", "D"],
  ] as const)("modified %s → CSI 1;N %s", (key, letter) => {
    expect(itermSequenceFor(keydown(key, { shiftKey: true }))).toBe(
      `\x1b[1;2${letter}`,
    );
    expect(itermSequenceFor(keydown(key, { ctrlKey: true }))).toBe(
      `\x1b[1;5${letter}`,
    );
    expect(
      itermSequenceFor(keydown(key, { ctrlKey: true, shiftKey: true })),
    ).toBe(`\x1b[1;6${letter}`);
  });

  it("Home/End variants", () => {
    expect(itermSequenceFor(keydown("Home", { shiftKey: true }))).toBe(
      "\x1b[1;2H",
    );
    expect(itermSequenceFor(keydown("Home", { ctrlKey: true }))).toBe(
      "\x1b[1;5H",
    );
    expect(itermSequenceFor(keydown("End", { shiftKey: true }))).toBe(
      "\x1b[1;2F",
    );
    expect(itermSequenceFor(keydown("End", { ctrlKey: true }))).toBe(
      "\x1b[1;5F",
    );
  });

  it.each([
    ["2", "\x00"],
    ["3", "\x1b"],
    ["4", "\x1c"],
    ["5", "\x1d"],
    ["6", "\x1e"],
    ["7", "\x1f"],
    ["8", "\x7f"],
    ["-", "\x1f"],
    ["/", "\x1f"],
  ] as const)("^%s control code", (key, seq) => {
    expect(itermSequenceFor(keydown(key, { ctrlKey: true }))).toBe(seq);
  });

  it.each([
    ["F1", "\x1b[1;2P"],
    ["F2", "\x1b[1;2Q"],
    ["F3", "\x1b[1;2R"],
    ["F4", "\x1b[1;2S"],
    ["F5", "\x1b[15;2~"],
    ["F6", "\x1b[17;2~"],
    ["F7", "\x1b[18;2~"],
    ["F8", "\x1b[19;2~"],
    ["F9", "\x1b[20;2~"],
    ["F10", "\x1b[21;2~"],
    ["F11", "\x1b[23;2~"],
    ["F12", "\x1b[24;2~"],
  ] as const)("⇧%s", (key, seq) => {
    expect(itermSequenceFor(keydown(key, { shiftKey: true }))).toBe(seq);
  });

  it("leaves unmapped combos to their default handling", () => {
    // Plain keys — xterm's own encoder owns these.
    expect(itermSequenceFor(keydown("Enter"))).toBeNull();
    expect(itermSequenceFor(keydown("Backspace"))).toBeNull();
    expect(itermSequenceFor(keydown("ArrowLeft"))).toBeNull();
    expect(itermSequenceFor(keydown("a"))).toBeNull();
    // App chrome shortcuts — must fall through to _app.tsx handlers.
    expect(itermSequenceFor(keydown("k", { metaKey: true }))).toBeNull();
    expect(itermSequenceFor(keydown("t", { metaKey: true }))).toBeNull();
    expect(itermSequenceFor(keydown("w", { metaKey: true }))).toBeNull();
    // Native menu equivalents.
    expect(itermSequenceFor(keydown("c", { metaKey: true }))).toBeNull();
    expect(itermSequenceFor(keydown("v", { metaKey: true }))).toBeNull();
    // ⌘⇧↵ is the commit-and-push form shortcut, not a terminal chord.
    expect(
      itermSequenceFor(keydown("Enter", { metaKey: true, shiftKey: true })),
    ).toBeNull();
    // Extra modifiers on a mapped base combo must not match.
    expect(
      itermSequenceFor(keydown("ArrowLeft", { metaKey: true, altKey: true })),
    ).toBeNull();
  });
});
