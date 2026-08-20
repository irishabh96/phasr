import { beforeEach, describe, expect, it } from "vitest";
import {
  diagAttach,
  diagCreate,
  diagDispose,
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
    const [rec] = (window.__PHASR_TERM_DIAG__!.dump() as any[]).filter(
      (r) => r.id === "s1",
    );
    expect(rec.headHasSgrColour).toBe(true);
    expect(rec.head).toContain("\\e[1;36m");
    diagDispose("s1");
  });

  it("flags a plain-text stream as carrying no colour", () => {
    diagCreate("s2");
    diagWrite("s2", new TextEncoder().encode("phasr on main\r\n"));
    const [rec] = (window.__PHASR_TERM_DIAG__!.dump() as any[]).filter(
      (r) => r.id === "s2",
    );
    expect(rec.headHasSgrColour).toBe(false);
    diagDispose("s2");
  });

  it("names the theme entries the engine cannot parse", () => {
    diagCreate("s3");
    diagAttach(
      "s3",
      { cyan: "#39c5cf", magenta: "rgba(188,140,255,1)", green: "teal" },
      { rows: 38, cols: 92 },
    );
    const [rec] = (window.__PHASR_TERM_DIAG__!.dump() as any[]).filter(
      (r) => r.id === "s3",
    );
    expect(rec.unparseableTheme).toEqual([
      "magenta=rgba(188,140,255,1)",
      "green=teal",
    ]);
    expect(rec.openedGrid).toEqual({ rows: 38, cols: 92 });
    diagDispose("s3");
  });

  it("numbers surfaces so 'the Nth terminal opened' is answerable", () => {
    diagCreate("a");
    diagCreate("b");
    const dump = window.__PHASR_TERM_DIAG__!.dump() as any[];
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
      (window.__PHASR_TERM_DIAG__!.dump() as any[]).some((r) => r.id === "gone"),
    ).toBe(false);
  });
});
