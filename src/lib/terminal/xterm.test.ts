import { describe, expect, it } from "vitest";
import { applyXtermSettings, createXtermTerminal } from "@/lib/terminal/xterm";

// Every write to `term.options` runs xterm's options-changed path, and
// theme/font writes make the WebGL renderer drop its glyph atlas — which
// WKWebView rebuilds through synchronous GPU-process IPC. applyXtermSettings
// runs on every terminal remount (tab switch), so it must be a no-op when
// nothing changed.
describe("applyXtermSettings", () => {
  const settings = {
    monoFont: "JetBrains Mono",
    baseFontSize: 13,
    cursorStyle: "block",
    cursorBlink: true,
    terminalScrollback: 5000,
  } as const;

  it("does not reassign any option when settings are unchanged", () => {
    const term = createXtermTerminal(settings);
    applyXtermSettings(term, settings);
    const themeBefore = term.options.theme;

    applyXtermSettings(term, settings);

    // Reference equality: an untouched option keeps its object identity.
    expect(term.options.theme).toBe(themeBefore);
  });

  it("still applies real changes", () => {
    const term = createXtermTerminal(settings);
    applyXtermSettings(term, { ...settings, baseFontSize: 15 });
    expect(term.options.fontSize).toBe(15);
  });

  it("enables smooth scrolling by default", () => {
    const term = createXtermTerminal(settings);
    expect(term.options.smoothScrollDuration).toBe(120);
  });
});
