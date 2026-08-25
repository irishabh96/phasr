import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetFocusProbe,
  diagAttach,
  diagCreate,
  diagDispose,
  diagFocus,
  diagWrite,
  installTerminalDiagnostics,
  isParseableByGhostty,
  terminalDiagnosticsEnabled,
} from "@/lib/terminal/diagnostics";

describe("isParseableByGhostty", () => {
  // `parseColorToHex` in ghostty-web handles exactly these two forms and
  // returns 0 for everything else. Measured consequence of returning 0: the
  // engine falls back to ITS OWN palette, so the terminal stays colourful
  // but stops matching phasr's theme.
  it.each(["#fff", "#e6edf3", "#39C5CF", "rgb(57, 197, 207)", "  #000000  "])(
    "accepts %s",
    (v) => expect(isParseableByGhostty(v)).toBe(true),
  );

  it.each([
    "rgba(57, 197, 207, 1)",
    "rgb(57 197 207)", // CSS Color 4 space-separated
    "oklch(0.7 0.15 200)",
    "teal",
    "color-mix(in srgb, red, blue)",
    "var(--ansi-cyan)",
    "",
    "#12345",
  ])("rejects %s", (v) => expect(isParseableByGhostty(v)).toBe(false));
});

/**
 * `dump()` returns `{ surfaces, focus }` rather than the bare array it used
 * to. The focus ring is worthless if the one command anyone knows does not
 * include it, and a field report arrives as one paste or not at all.
 */
const surfaces = () =>
  (window.__PHASR_TERM_DIAG__!.dump() as { surfaces: any[] }).surfaces;

describe("diagnostics recorder", () => {
  beforeEach(() => {
    window.localStorage.clear();
    installTerminalDiagnostics();
  });

  it("is off unless explicitly switched on", () => {
    expect(terminalDiagnosticsEnabled()).toBe(false);
    window.localStorage.setItem("phasr.diag.terminal", "1");
    expect(terminalDiagnosticsEnabled()).toBe(true);
  });

  it("answers 'did the bytes carry colour' without a screen recording", () => {
    diagCreate("s1");
    diagWrite("s1", new TextEncoder().encode("\x1b[1;36mphasr\x1b[0m"));
    const [rec] = surfaces().filter(
      (r) => r.id === "s1",
    );
    expect(rec.headHasSgrColour).toBe(true);
    expect(rec.head).toContain("\\e[1;36m");
    diagDispose("s1");
  });

  it("flags a plain-text stream as carrying no colour", () => {
    diagCreate("s2");
    diagWrite("s2", new TextEncoder().encode("phasr on main\r\n"));
    const [rec] = surfaces().filter(
      (r) => r.id === "s2",
    );
    expect(rec.headHasSgrColour).toBe(false);
    diagDispose("s2");
  });

  it("names the PALETTE entries the engine cannot parse", () => {
    diagCreate("s3");
    diagAttach(
      "s3",
      { cyan: "#39c5cf", magenta: "rgba(188,140,255,1)", green: "teal" },
      { rows: 38, cols: 92 },
    );
    const [rec] = surfaces().filter(
      (r) => r.id === "s3",
    );
    expect(rec.unparseableTheme).toEqual([
      "green=teal",
      "magenta=rgba(188,140,255,1)",
    ]);
    expect(rec.openedGrid).toEqual({ rows: 38, cols: 92 });
    diagDispose("s3");
  });

  it("does NOT flag canvas-bound entries — the first field dump's false alarm", () => {
    // `selectionBackground` never reaches `parseColorToHex`; the renderer
    // hands it to `ctx.fillStyle`, where 8-digit hex is valid and its alpha
    // is honoured. Reporting it as unparseable read as a shipped colour bug
    // and cost a round trip.
    diagCreate("s4");
    diagAttach(
      "s4",
      { selectionBackground: "#f7816647", cursorAccent: "rgba(1,2,3,0.5)", cyan: "#39c5cf" },
      { rows: 17, cols: 94 },
    );
    const [rec] = surfaces().filter(
      (r) => r.id === "s4",
    );
    expect(rec.unparseableTheme).toEqual([]);
    expect(rec.alphaInWasmTheme).toEqual([]);
    diagDispose("s4");
  });

  it("flags alpha on a palette entry, which parseColorToHex accepts silently", () => {
    diagCreate("s5");
    diagAttach("s5", { cyan: "#39c5cf47" }, { rows: 17, cols: 94 });
    const [rec] = surfaces().filter(
      (r) => r.id === "s5",
    );
    expect(rec.alphaInWasmTheme).toEqual(["cyan=#39c5cf47"]);
    expect(rec.unparseableTheme).toEqual(["cyan=#39c5cf47"]);
    diagDispose("s5");
  });

  it("numbers surfaces so 'the Nth terminal opened' is answerable", () => {
    diagCreate("a");
    diagCreate("b");
    const dump = surfaces();
    const a = dump.find((r) => r.id === "a")!;
    const b = dump.find((r) => r.id === "b")!;
    expect(b.seq).toBe(a.seq + 1);
    diagDispose("a");
    diagDispose("b");
  });

  it("drops its record on dispose — no reference to a dead terminal", () => {
    diagCreate("gone");
    diagDispose("gone");
    expect(
      surfaces().some((r) => r.id === "gone"),
    ).toBe(false);
  });
});

/**
 * The focus probe. A field report of "clicking does nothing" has three
 * possible causes that look identical to the person reporting it, and each
 * one has a different fix:
 *
 *   1. the click never arrived (an overlay, or a click-dead body);
 *   2. it arrived and focus did not follow;
 *   3. focus is fine and the renderer is frozen.
 *
 * These assert that one record separates them, because the alternative —
 * asking the user to try things — is what the last three of these cost.
 */
describe("focus probe", () => {
  beforeEach(() => {
    __resetFocusProbe();
    installTerminalDiagnostics();
    document.body.innerHTML = "";
    document.body.style.pointerEvents = "";
  });

  const fire = (
    target: Element,
    surface: { id: string; renderTick(): number | null } | null,
  ) => {
    const event = new MouseEvent("mousedown", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
    });
    // jsdom never dispatches these, so the target is set by hand — the
    // probe reads it exactly as a real capture listener would.
    Object.defineProperty(event, "target", { value: target });
    diagFocus(event, surface);
  };

  const ring = () => window.__PHASR_TERM_DIAG__!.focus();

  it("records a click even when it is nowhere near a terminal", () => {
    // Reading (b) of the report — "terminal OR INPUT". A ring that only
    // watched terminals could not tell the two readings apart.
    const input = document.createElement("input");
    document.body.append(input);
    fire(input, null);
    expect(ring()).toHaveLength(1);
    expect(ring()[0]!.target).toBe("INPUT");
    expect(ring()[0]!.surfaceId).toBeNull();
  });

  it("captures the frame counter on both sides of the click", async () => {
    // The discriminator for the frozen-renderer case: focus lands, and
    // the counter does not move.
    const host = document.createElement("div");
    host.setAttribute("data-testid", "terminal-surface");
    document.body.append(host);
    const frozen = { id: "ghostty-9", renderTick: () => 41 };
    fire(host, frozen);
    await new Promise((r) => setTimeout(r, 200));
    const [rec] = ring();
    expect(rec!.surfaceId).toBe("ghostty-9");
    expect(rec!.frames).toBe(41);
    expect(rec!.framesAfter).toBe(41);
  });

  it("reports body pointer-events, which is the app-wide click killer", () => {
    // A dismissable layer that does not clean up leaves the whole window
    // unclickable, and nothing else in a dump would show it.
    document.body.style.pointerEvents = "none";
    const div = document.createElement("div");
    document.body.append(div);
    fire(div, null);
    expect(ring()[0]!.bodyPointerEvents).toBe("none");
  });

  it("keeps the last twenty clicks and no more", () => {
    const div = document.createElement("div");
    document.body.append(div);
    for (let i = 0; i < 30; i++) fire(div, null);
    expect(ring()).toHaveLength(20);
  });

  it("rides along in dump(), so one paste carries everything", () => {
    const div = document.createElement("div");
    document.body.append(div);
    fire(div, null);
    const dump = window.__PHASR_TERM_DIAG__!.dump() as {
      surfaces: unknown[];
      focus: unknown[];
    };
    expect(dump.focus).toHaveLength(1);
    expect(Array.isArray(dump.surfaces)).toBe(true);
  });
});
