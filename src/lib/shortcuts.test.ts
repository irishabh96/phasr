import { describe, expect, it } from "vitest";
import { matchShortcut, SHORTCUTS } from "@/lib/shortcuts";

const key = (
  k: string,
  mods: { meta?: boolean; ctrl?: boolean; shift?: boolean } = {},
) =>
  new KeyboardEvent("keydown", {
    key: k,
    metaKey: !!mods.meta,
    ctrlKey: !!mods.ctrl,
    shiftKey: !!mods.shift,
  });

/** Every SHORTCUTS entry that matches `e`, by registry id. */
const matches = (e: KeyboardEvent) =>
  Object.entries(SHORTCUTS)
    .filter(([, s]) => matchShortcut(e, s))
    .map(([id]) => id);

// The font-size chords are the one place where the physical key and `e.key`
// disagree: the "+" key reports "=" unshifted, "+" under Shift on macOS, but
// "=" with shiftKey set in Chromium — and the numpad reports "+" with no
// Shift at all. Every spelling must reach the same binding, and none may
// leak into another one.
describe("terminal font size shortcuts", () => {
  it("matches every spelling of ⌘+ that a browser can report", () => {
    for (const e of [
      key("=", { meta: true }), // ⌘=
      key("+", { meta: true, shift: true }), // ⌘⇧= on macOS
      key("=", { meta: true, shift: true }), // ⌘⇧= in Chromium
      key("+", { meta: true }), // numpad ⌘+
    ]) {
      expect(matches(e)).toEqual(["increaseFontSize"]);
    }
  });

  it("matches both spellings of ⌘-", () => {
    for (const e of [
      key("-", { meta: true }), // ⌘-
      key("_", { meta: true, shift: true }), // ⌘⇧-
    ]) {
      expect(matches(e)).toEqual(["decreaseFontSize"]);
    }
  });

  it("⌘0 matches reset only", () => {
    expect(matches(key("0", { meta: true }))).toEqual(["resetFontSize"]);
    // ⌘⇧0 is not a zoom chord anywhere — it must stay unbound.
    expect(matches(key("0", { meta: true, shift: true }))).toEqual([]);
  });

  it("ctrl works as meta (Windows/Linux)", () => {
    expect(
      matchShortcut(key("=", { ctrl: true }), SHORTCUTS.increaseFontSize),
    ).toBe(true);
    expect(
      matchShortcut(key("-", { ctrl: true }), SHORTCUTS.decreaseFontSize),
    ).toBe(true);
  });

  it("bare keys without meta never match", () => {
    for (const k of ["=", "+", "-", "_", "0"]) {
      expect(matches(key(k))).toEqual([]);
      expect(matches(key(k, { shift: true }))).toEqual([]);
    }
  });

  // ignoreShift is opt-in: it must not loosen the rest of the registry.
  it("shift agreement still guards the ordinary bindings", () => {
    expect(matches(key("b", { meta: true }))).toEqual(["toggleSidebarPin"]);
    expect(matches(key("b", { meta: true, shift: true }))).toEqual([
      "toggleSidebarHide",
    ]);
    expect(matches(key("n", { meta: true }))).toEqual(["newWorkspace"]);
    expect(matches(key("n", { meta: true, shift: true }))).toEqual([
      "openNotes",
    ]);
  });
});
