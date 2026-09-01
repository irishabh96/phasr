import { describe, expect, it, vi } from "vitest";
import {
  encodeMouse,
  installGhosttyMouse,
  mouseOutcome,
  type MouseContext,
  type MouseModes,
} from "@/lib/terminal/backends/ghostty/mouse";

function ctx(over: Partial<MouseContext> = {}): MouseContext {
  return {
    type: "down",
    button: 0,
    buttons: 1,
    mouseTracking: true,
    x10: false,
    dragTracking: true,
    anyMotion: true,
    sgrMouse: true,
    col: 0,
    row: 0,
    cellChanged: true,
    shift: false,
    alt: false,
    ctrl: false,
    ...over,
  };
}

describe("mouseOutcome", () => {
  /**
   * The bug this module exists for: ghostty-web reports no mouse event of
   * any kind, so a click inside Claude Code (which asks for
   * 1000/1002/1003/1006 at startup) reached it as nothing at all and its
   * agent rows could not be clicked.
   */
  it("reports a left press and its release when an app asked for the mouse", () => {
    expect(mouseOutcome(ctx({ type: "down", col: 4, row: 9 }))).toEqual({
      kind: "send",
      seq: "\x1b[<0;5;10M",
    });
    expect(
      mouseOutcome(ctx({ type: "up", buttons: 0, col: 4, row: 9 })),
    ).toEqual({ kind: "send", seq: "\x1b[<0;5;10m" });
  });

  it("leaves the mouse to phasr when no app asked for it", () => {
    expect(mouseOutcome(ctx({ mouseTracking: false }))).toEqual({
      kind: "passthrough",
    });
    expect(
      mouseOutcome(ctx({ mouseTracking: false, type: "move", buttons: 1 })),
    ).toEqual({ kind: "passthrough" });
  });

  /** The xterm escape hatch, and the one `wheel.ts` already honours. */
  it("hands a shift-held press back so text selection still works", () => {
    expect(mouseOutcome(ctx({ shift: true }))).toEqual({ kind: "passthrough" });
    expect(
      mouseOutcome(ctx({ shift: true, type: "move", buttons: 1 })),
    ).toEqual({ kind: "passthrough" });
  });

  /**
   * ghostty-web's `contextmenu` handler is what makes WebKit's native
   * Copy/Paste menu work over a canvas — inside a terminal it is phasr's
   * only pointer-driven paste, so button 2 stays phasr's.
   */
  it("never reports right-click, and passes its release through too", () => {
    expect(mouseOutcome(ctx({ button: 2, buttons: 2 }))).toEqual({
      kind: "passthrough",
    });
    expect(mouseOutcome(ctx({ type: "up", button: 2, buttons: 0 }))).toEqual({
      kind: "passthrough",
    });
  });

  it("reports the middle button", () => {
    expect(mouseOutcome(ctx({ button: 1, buttons: 4 }))).toEqual({
      kind: "send",
      seq: "\x1b[<1;1;1M",
    });
  });

  it("carries alt and ctrl, which apps read as modified clicks", () => {
    expect(mouseOutcome(ctx({ alt: true }))).toEqual({
      kind: "send",
      seq: "\x1b[<8;1;1M",
    });
    expect(mouseOutcome(ctx({ ctrl: true }))).toEqual({
      kind: "send",
      seq: "\x1b[<16;1;1M",
    });
  });

  describe("motion", () => {
    it("reports hover as motion when the app asked for 1003", () => {
      expect(
        mouseOutcome(ctx({ type: "move", buttons: 0, col: 2, row: 3 })),
      ).toEqual({ kind: "send", seq: "\x1b[<35;3;4M" });
    });

    it("reports a drag with the held button's number", () => {
      expect(
        mouseOutcome(ctx({ type: "move", buttons: 1, col: 2, row: 3 })),
      ).toEqual({ kind: "send", seq: "\x1b[<32;3;4M" });
      expect(
        mouseOutcome(ctx({ type: "move", buttons: 4, col: 2, row: 3 })),
      ).toEqual({ kind: "send", seq: "\x1b[<33;3;4M" });
    });

    /**
     * A pointer crossing one cell emits dozens of `mousemove`s and the
     * protocol has no sub-cell resolution, so every one after the first
     * would be a duplicate on the PTY.
     */
    it("says nothing while the pointer stays in one cell", () => {
      expect(
        mouseOutcome(ctx({ type: "move", buttons: 1, cellChanged: false })),
      ).toEqual({ kind: "swallow" });
    });

    it("lets hover through when the app only asked for buttons", () => {
      expect(
        mouseOutcome(
          ctx({
            type: "move",
            buttons: 0,
            anyMotion: false,
            dragTracking: false,
          }),
        ),
      ).toEqual({ kind: "passthrough" });
    });

    /**
     * The press was already reported, so the drag belongs to the app even
     * though it asked for no motion — handing it on would start a
     * selection underneath the app's own drag.
     */
    it("swallows a drag the app asked for no motion reports about", () => {
      expect(
        mouseOutcome(
          ctx({
            type: "move",
            buttons: 1,
            anyMotion: false,
            dragTracking: false,
          }),
        ),
      ).toEqual({ kind: "swallow" });
    });
  });

  describe("DECSET 9 (X10)", () => {
    const x10 = { x10: true, dragTracking: false, anyMotion: false } as const;

    it("reports presses and nothing else", () => {
      expect(mouseOutcome(ctx({ ...x10, col: 1, row: 1 }))).toEqual({
        kind: "send",
        seq: "\x1b[<0;2;2M",
      });
      expect(mouseOutcome(ctx({ ...x10, type: "up", buttons: 0 }))).toEqual({
        kind: "swallow",
      });
      expect(mouseOutcome(ctx({ ...x10, type: "move", buttons: 1 }))).toEqual({
        kind: "swallow",
      });
    });

    it("carries no modifier bits", () => {
      expect(mouseOutcome(ctx({ ...x10, ctrl: true, alt: true }))).toEqual({
        kind: "send",
        seq: "\x1b[<0;1;1M",
      });
    });
  });
});

describe("encodeMouse", () => {
  it("encodes SGR presses, releases and motion", () => {
    expect(encodeMouse({ button: 0, col: 0, row: 0, sgr: true })).toBe(
      "\x1b[<0;1;1M",
    );
    expect(
      encodeMouse({ button: 0, col: 11, row: 4, sgr: true, release: true }),
    ).toBe("\x1b[<0;12;5m");
  });

  /**
   * X10 has no release field at all: every release is button 3 and the app
   * has to infer which button it was. That is the whole reason 1006 exists.
   */
  it("collapses every X10 release onto button 3", () => {
    expect(encodeMouse({ button: 1, col: 0, row: 0, sgr: false })).toBe(
      "\x1b[M\x21\x21\x21",
    );
    expect(
      encodeMouse({ button: 1, col: 0, row: 0, sgr: false, release: true }),
    ).toBe("\x1b[M\x23\x21\x21");
  });

  /** Single bytes, so X10 coordinates cap at 223 — SGR's are unbounded. */
  it("clamps X10 coordinates and leaves SGR's alone", () => {
    expect(encodeMouse({ button: 0, col: 400, row: 400, sgr: false })).toBe(
      `\x1b[M\x20${String.fromCharCode(255)}${String.fromCharCode(255)}`,
    );
    expect(encodeMouse({ button: 0, col: 400, row: 400, sgr: true })).toBe(
      "\x1b[<0;401;401M",
    );
  });
});

describe("installGhosttyMouse", () => {
  function harness(over: Partial<MouseModes> = {}) {
    const element = document.createElement("div");
    document.body.append(element);
    const sent: string[] = [];
    const focus = vi.fn();
    const install = installGhosttyMouse(element, {
      modes: () => ({
        mouseTracking: true,
        x10: false,
        dragTracking: true,
        anyMotion: false,
        sgrMouse: true,
        ...over,
      }),
      cellAt: (event) => ({ col: event.clientX, row: event.clientY }),
      send: (seq) => sent.push(seq),
      focus,
    });
    return { element, sent, focus, install };
  }

  function mouse(type: string, init: MouseEventInit = {}) {
    return new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  }

  it("sends press and release, and focuses the terminal on the press", () => {
    const { element, sent, focus, install } = harness();
    element.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1 }));
    window.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0 }));
    expect(sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    expect(focus).toHaveBeenCalledOnce();
    install.dispose();
  });

  /**
   * `installGhosttySelection` listens capture-phase on the same element,
   * and ghostty-web's canvas mousedown anchors its own drag-select. A
   * reported press must reach neither.
   */
  it("stops a reported press from also anchoring a selection", () => {
    const { element, install } = harness();
    const later = vi.fn();
    element.addEventListener("mousedown", later, { capture: true });
    const event = mouse("mousedown", { button: 0, buttons: 1 });
    element.dispatchEvent(event);
    expect(later).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    install.dispose();
  });

  it("leaves a press alone when nothing asked for the mouse", () => {
    const { element, sent, install } = harness({ mouseTracking: false });
    const later = vi.fn();
    element.addEventListener("mousedown", later, { capture: true });
    const event = mouse("mousedown", { button: 0, buttons: 1 });
    element.dispatchEvent(event);
    expect(sent).toEqual([]);
    expect(later).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
    install.dispose();
  });

  /**
   * A drag that leaves the canvas still has to report, and its release
   * still has to arrive — otherwise the app believes the button is held
   * for the rest of the session.
   */
  it("follows a drag off the element and still sees its release", () => {
    const { element, sent, install } = harness();
    element.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1 }));
    window.dispatchEvent(
      mouse("mousemove", { buttons: 1, clientX: 3, clientY: 2 }),
    );
    window.dispatchEvent(
      mouse("mouseup", { button: 0, buttons: 0, clientX: 3, clientY: 2 }),
    );
    expect(sent).toEqual(["\x1b[<0;1;1M", "\x1b[<32;4;3M", "\x1b[<0;4;3m"]);
    install.dispose();
  });

  it("ignores pointer motion outside the terminal when no button is held", () => {
    const { sent, install } = harness({ anyMotion: true });
    window.dispatchEvent(
      mouse("mousemove", { buttons: 0, clientX: 5, clientY: 5 }),
    );
    expect(sent).toEqual([]);
    install.dispose();
  });

  it("reports hover inside the terminal once 1003 is on", () => {
    const { element, sent, install } = harness({ anyMotion: true });
    element.dispatchEvent(
      mouse("mousemove", { buttons: 0, clientX: 2, clientY: 6 }),
    );
    expect(sent).toEqual(["\x1b[<35;3;7M"]);
    install.dispose();
  });

  /**
   * A press we passed through (right-click, shift-held) must not have its
   * release reported: the app would see a release for a press it never got.
   */
  it("does not report the release of a press it passed through", () => {
    const { element, sent, install } = harness();
    element.dispatchEvent(mouse("mousedown", { button: 2, buttons: 2 }));
    window.dispatchEvent(mouse("mouseup", { button: 2, buttons: 0 }));
    expect(sent).toEqual([]);
    install.dispose();
  });

  it("ignores a press outside the terminal", () => {
    const { sent, install } = harness();
    document.body.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1 }));
    expect(sent).toEqual([]);
    install.dispose();
  });

  /**
   * A drag that began elsewhere — ghostty-web's scrollbar thumb, some
   * future splitter — keeps its own `mousemove` stream even while the
   * pointer is over the terminal. Claiming those would freeze the drag the
   * moment it crossed a terminal pane.
   */
  it("does not steal a drag that began outside it", () => {
    const { element, sent, install } = harness({ anyMotion: true });
    const later = vi.fn();
    element.addEventListener("mousemove", later, { capture: true });
    element.dispatchEvent(
      mouse("mousemove", { buttons: 1, clientX: 4, clientY: 4 }),
    );
    expect(sent).toEqual([]);
    expect(later).toHaveBeenCalledOnce();
    install.dispose();
  });

  it("stops listening once disposed", () => {
    const { element, sent, install } = harness();
    install.dispose();
    element.dispatchEvent(mouse("mousedown", { button: 0, buttons: 1 }));
    window.dispatchEvent(mouse("mouseup", { button: 0, buttons: 0 }));
    expect(sent).toEqual([]);
  });
});
