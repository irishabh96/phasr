import { describe, expect, it } from "vitest";
import {
  applyChangedOptions,
  applyChangedTheme,
  buildSurfaceOptions,
  scrollbackBytes,
  UNLIMITED_SCROLLBACK,
  UNLIMITED_SCROLLBACK_BYTES,
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
    // A real terminal's bag holds the BYTE budget (toGhosttyOptions
    // converts at construction); the resolved options hold lines.
    scrollback: scrollbackBytes(options.scrollback),
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

  it("keeps a finite scrollback setting, in lines", () => {
    expect(buildSurfaceOptions({ terminalScrollback: 200 }).scrollback).toBe(
      200,
    );
  });

  it("treats unset, non-positive and garbage scrollback as unlimited", () => {
    expect(buildSurfaceOptions(undefined).scrollback).toBe(
      UNLIMITED_SCROLLBACK,
    );
    expect(buildSurfaceOptions({ terminalScrollback: 0 }).scrollback).toBe(
      UNLIMITED_SCROLLBACK,
    );
    expect(buildSurfaceOptions({ terminalScrollback: -5 }).scrollback).toBe(
      UNLIMITED_SCROLLBACK,
    );
    expect(
      buildSurfaceOptions({ terminalScrollback: Number.NaN }).scrollback,
    ).toBe(UNLIMITED_SCROLLBACK);
  });

  it("reinterprets the never-user-chosen legacy default as unlimited", () => {
    // Every 0.x database stores terminal_scrollback = 10000 — the
    // migration default, which no UI has ever offered to change. Honouring
    // it as a cap would silently keep every existing install limited.
    expect(buildSurfaceOptions({ terminalScrollback: 10000 }).scrollback).toBe(
      UNLIMITED_SCROLLBACK,
    );
    // The neighbour is a real choice and stays one.
    expect(buildSurfaceOptions({ terminalScrollback: 10001 }).scrollback).toBe(
      10001,
    );
  });

  it("defaults the cursor to blinking", () => {
    expect(buildSurfaceOptions(undefined).cursorBlink).toBe(true);
    expect(buildSurfaceOptions({ cursorBlink: false }).cursorBlink).toBe(false);
  });
});

// The engine's `scrollback` option is a budget in BYTES (ghostty's
// `max_scrollback`), not lines — feeding it the line count is the bug that
// capped every terminal at ~1,100 rows of history. This mapping is the
// only place the conversion lives.
describe("scrollbackBytes", () => {
  it("maps unlimited to the 1 GiB budget", () => {
    expect(scrollbackBytes(UNLIMITED_SCROLLBACK)).toBe(
      UNLIMITED_SCROLLBACK_BYTES,
    );
  });

  it("budgets 4 KiB per requested line", () => {
    // Worst case measured against the real WASM: a full 200-column styled
    // row costs ~4.2 KiB, a plain 80-column row ~800 B — so 4 KiB/row
    // guarantees at least the asked lines and usually retains far more.
    expect(scrollbackBytes(200)).toBe(200 * 4096);
    expect(scrollbackBytes(25000)).toBe(25000 * 4096);
  });

  it("never exceeds the unlimited budget", () => {
    expect(scrollbackBytes(10_000_000)).toBe(UNLIMITED_SCROLLBACK_BYTES);
  });
});
