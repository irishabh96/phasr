import { describe, expect, it } from "vitest";
import {
  applyChangedOptions,
  applyChangedTheme,
  buildSurfaceOptions,
  type MutableSurfaceOptions,
  type MutableThemeTarget,
  type ResolvedSurfaceOptions,
} from "@/lib/terminal/options";

const SETTINGS = {
  monoFont: "JetBrains Mono",
  baseFontSize: 13,
  cursorStyle: "block",
  cursorBlink: true,
  terminalScrollback: 5000,
} as const;

/**
 * A spy terminal: the same option bag a backend hands to
 * applyChangedOptions, but every assignment is recorded. Asserting on the
 * WRITES (rather than on some resulting value) is what makes the diffing
 * invariant testable at all — an unnecessary write is invisible in the
 * final state and very visible in a frame time.
 */
function spyTarget(options: ResolvedSurfaceOptions) {
  const writes: string[] = [];
  const state: Record<string, unknown> = {
    fontFamily: options.fontFamily,
    fontSize: options.fontSize,
    cursorStyle: options.cursorStyle,
    cursorBlink: options.cursorBlink,
    scrollback: options.scrollback,
    theme: options.theme,
  };
  const target = {} as MutableSurfaceOptions & MutableThemeTarget;
  for (const key of Object.keys(state)) {
    Object.defineProperty(target, key, {
      enumerable: true,
      get: () => state[key],
      set: (value: unknown) => {
        writes.push(key);
        state[key] = value;
      },
    });
  }
  return { target, writes };
}

// Every write to a live terminal's options runs the emulator's
// options-changed path, and theme/font writes make the WebGL renderer drop
// its glyph atlas — which WKWebView rebuilds through synchronous
// GPU-process IPC. This runs on every terminal remount (tab switch), so it
// must be a no-op when nothing changed.
describe("applyChangedOptions", () => {
  it("writes nothing when the settings are unchanged", () => {
    const options = buildSurfaceOptions(SETTINGS);
    const { target, writes } = spyTarget(options);

    applyChangedOptions(target, buildSurfaceOptions(SETTINGS));

    expect(writes).toEqual([]);
  });

  it("writes only the option that actually changed", () => {
    const { target, writes } = spyTarget(buildSurfaceOptions(SETTINGS));

    const written = applyChangedOptions(
      target,
      buildSurfaceOptions({ ...SETTINGS, baseFontSize: 15 }),
    );

    expect(writes).toEqual(["fontSize"]);
    expect(written).toEqual(["fontSize"]);
    expect(target.fontSize).toBe(15);
  });

  it("clamps before diffing, so an illegal size is not a change", () => {
    // 13 is already the clamp fallback for garbage.
    const { target, writes } = spyTarget(buildSurfaceOptions(SETTINGS));
    applyChangedOptions(
      target,
      buildSurfaceOptions({ ...SETTINGS, baseFontSize: 0 }),
    );
    expect(writes).toEqual([]);
  });

  it("carries cursor + scrollback changes", () => {
    const { target, writes } = spyTarget(buildSurfaceOptions(SETTINGS));
    applyChangedOptions(
      target,
      buildSurfaceOptions({
        ...SETTINGS,
        cursorStyle: "bar",
        cursorBlink: false,
        terminalScrollback: 200,
      }),
    );
    expect(writes).toEqual(["cursorStyle", "cursorBlink", "scrollback"]);
  });
});

// Theme is diffed on its own so a live theme flip can push colours without
// touching fonts. It is rebuilt from CSS on every read, so it is never
// reference-equal — the comparison has to be structural.
describe("applyChangedTheme", () => {
  it("writes nothing for an equal-but-not-identical theme", () => {
    const options = buildSurfaceOptions(SETTINGS);
    const { target, writes } = spyTarget(options);

    const next = buildSurfaceOptions(SETTINGS).theme;
    expect(next).not.toBe(options.theme);
    expect(applyChangedTheme(target, next)).toBe(false);
    expect(writes).toEqual([]);
  });

  it("writes when a colour moved", () => {
    const options = buildSurfaceOptions(SETTINGS);
    const { target, writes } = spyTarget(options);

    const written = applyChangedTheme(target, {
      ...options.theme,
      background: "#ffffff",
    });

    expect(written).toBe(true);
    expect(writes).toEqual(["theme"]);
  });

  it("writes when the terminal has no theme yet", () => {
    const options = buildSurfaceOptions(SETTINGS);
    const { target, writes } = spyTarget(options);
    target.theme = undefined;
    writes.length = 0;

    expect(applyChangedTheme(target, options.theme)).toBe(true);
    expect(writes).toEqual(["theme"]);
  });
});

describe("buildSurfaceOptions", () => {
  it("enables smooth scrolling by default", () => {
    // Discrete whole-line jumps read as "janky" on a trackpad regardless
    // of frame rate; this is the glide.
    expect(buildSurfaceOptions(SETTINGS).smoothScrollDuration).toBe(120);
  });

  it("keeps the grid metrics the renderer was tuned against", () => {
    const options = buildSurfaceOptions(SETTINGS);
    expect(options.lineHeight).toBe(1.0);
    expect(options.convertEol).toBe(true);
  });

  it("quotes the user's font and keeps a fallback behind it", () => {
    expect(buildSurfaceOptions({ monoFont: 'Fira "Code"' }).fontFamily).toBe(
      `"Fira Code", ui-monospace, Menlo, monospace`,
    );
    expect(buildSurfaceOptions({ monoFont: "  " }).fontFamily).toBe(
      "ui-monospace, Menlo, monospace",
    );
    expect(buildSurfaceOptions(undefined).fontFamily).toBe(
      "ui-monospace, Menlo, monospace",
    );
  });

  it("normalizes an unknown cursor style rather than passing it through", () => {
    expect(buildSurfaceOptions({ cursorStyle: "bar" }).cursorStyle).toBe("bar");
    expect(buildSurfaceOptions({ cursorStyle: "wedge" }).cursorStyle).toBe(
      "block",
    );
    expect(buildSurfaceOptions(undefined).cursorStyle).toBe("block");
  });

  it("falls back to the default scrollback for a non-positive value", () => {
    expect(buildSurfaceOptions({ terminalScrollback: 200 }).scrollback).toBe(
      200,
    );
    expect(buildSurfaceOptions({ terminalScrollback: 0 }).scrollback).toBe(
      10000,
    );
    expect(buildSurfaceOptions(undefined).scrollback).toBe(10000);
  });

  it("defaults the cursor to blinking", () => {
    expect(buildSurfaceOptions(undefined).cursorBlink).toBe(true);
    expect(buildSurfaceOptions({ cursorBlink: false }).cursorBlink).toBe(false);
  });
});
