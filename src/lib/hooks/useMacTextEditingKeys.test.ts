import { afterEach, describe, expect, it, vi } from "vitest";
import { handleMacTextEditingKey } from "@/lib/hooks/useMacTextEditingKeys";

type FieldKind = "input" | "textarea";

function makeField(
  kind: FieldKind,
  value: string,
  selStart: number,
  selEnd = selStart,
  direction: "forward" | "backward" | "none" = "none",
) {
  const el = document.createElement(kind);
  document.body.appendChild(el);
  el.value = value;
  el.setSelectionRange(selStart, selEnd, direction);
  return el;
}

function fire(
  el: HTMLElement,
  key: string,
  mods: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {},
) {
  const e = new KeyboardEvent("keydown", {
    key,
    metaKey: true,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    ctrlKey: mods.ctrlKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(e, "target", { value: el });
  handleMacTextEditingKey(e);
  return e;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("⌘⌫ — delete to line start", () => {
  it("deletes from line start to the caret in an input", () => {
    const el = makeField("input", "hello world", 8);
    const e = fire(el, "Backspace");
    expect(el.value).toBe("rld");
    expect(el.selectionStart).toBe(0);
    expect(e.defaultPrevented).toBe(true);
  });

  it("deletes only the current line in a textarea", () => {
    const el = makeField("textarea", "first\nsecond line\nthird", 13); // caret before "line"
    fire(el, "Backspace");
    expect(el.value).toBe("first\nline\nthird");
    expect(el.selectionStart).toBe(6);
  });

  it("removes the selection plus everything back to line start", () => {
    const el = makeField("input", "abcdefgh", 3, 6);
    fire(el, "Backspace");
    expect(el.value).toBe("gh");
  });

  it("consumes the chord at line start without deleting", () => {
    const el = makeField("textarea", "first\nsecond", 6);
    const e = fire(el, "Backspace");
    expect(el.value).toBe("first\nsecond");
    expect(e.defaultPrevented).toBe(true);
  });

  it("dispatches a bubbling input event so React onChange fires", () => {
    const el = makeField("input", "hello", 5);
    const seen = vi.fn();
    el.addEventListener("input", seen);
    fire(el, "Backspace");
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]?.[0]?.bubbles).toBe(true);
  });
});

describe("⌘← / ⌘→ — line boundaries", () => {
  it("moves the caret to line start / end in an input", () => {
    const el = makeField("input", "hello world", 6);
    fire(el, "ArrowLeft");
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 0]);
    fire(el, "ArrowRight");
    expect([el.selectionStart, el.selectionEnd]).toEqual([11, 11]);
  });

  it("respects logical lines in a textarea", () => {
    const el = makeField("textarea", "first\nsecond\nthird", 9); // inside "second"
    fire(el, "ArrowLeft");
    expect(el.selectionStart).toBe(6);
    el.setSelectionRange(9, 9);
    fire(el, "ArrowRight");
    expect(el.selectionStart).toBe(12);
  });

  it("⇧⌘← selects back to line start", () => {
    const el = makeField("input", "hello world", 8);
    const e = fire(el, "ArrowLeft", { shiftKey: true });
    expect([el.selectionStart, el.selectionEnd]).toEqual([0, 8]);
    expect(el.selectionDirection).toBe("backward");
    expect(e.defaultPrevented).toBe(true);
  });

  it("⇧⌘→ extends an existing backward selection's focus, keeping the anchor", () => {
    // anchor at 8, focus at 3 (backward). ⇧⌘→ moves the FOCUS to line
    // end — crossing the anchor — giving [8, 11] forward.
    const el = makeField("input", "hello world", 3, 8, "backward");
    fire(el, "ArrowRight", { shiftKey: true });
    expect([el.selectionStart, el.selectionEnd]).toEqual([8, 11]);
    expect(el.selectionDirection).toBe("forward");
  });
});

describe("scoping", () => {
  it("ignores the emulator's hidden textarea", () => {
    // Matched by the phasr container the emulator is mounted into, not by
    // an emulator-specific class — the class test silently stopped
    // matching when the engine changed.
    const host = document.createElement("div");
    host.dataset.testid = "terminal-surface";
    document.body.appendChild(host);
    const el = makeField("textarea", "abc", 3);
    host.appendChild(el);
    const e = fire(el, "Backspace");
    expect(el.value).toBe("abc");
    expect(e.defaultPrevented).toBe(false);
  });

  it("ignores non-field targets and readonly fields", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);
    expect(fire(div, "Backspace").defaultPrevented).toBe(false);

    const ro = makeField("input", "abc", 3);
    ro.readOnly = true;
    expect(fire(ro, "Backspace").defaultPrevented).toBe(false);
    expect(ro.value).toBe("abc");
  });

  it("ignores chords with extra modifiers (⌥⌘← is not ours)", () => {
    const el = makeField("input", "hello world", 6);
    const e = fire(el, "ArrowLeft", { altKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(el.selectionStart).toBe(6);
  });
});
