import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/session/Composer";
import type { ReplyChip } from "@/lib/transcript/suggest";

const sendMessageToTask = vi.fn();

// Voice input reads the downloaded-model list; none here.
vi.mock("@/lib/voice/useVoiceModels", () => ({ useVoiceModels: () => ({ data: [] }), useDictationPolishers: () => ({ data: [] }) }));
vi.mock("@/lib/tauri", () => ({
  tauri: { sendMessageToTask: (...args: unknown[]) => sendMessageToTask(...args) },
}));
vi.mock("@/lib/toast", () => ({ showToast: vi.fn() }));

beforeEach(() => {
  sendMessageToTask.mockReset();
  sendMessageToTask.mockResolvedValue(undefined);
});

type State = "working" | "idle" | "needs-you" | "exited" | null;
const turn = (state: State) => ({ state, onStop: vi.fn().mockResolvedValue(undefined) });
const CHIPS: ReplyChip[] = [
  { label: "Open a draft PR", text: "Open a draft PR", source: "heuristic" },
  { label: "Also handle the mobile deep-link case", text: "Also handle the mobile deep-link case", source: "heuristic" },
];
const row = () => screen.getByRole("group", { name: "Suggested replies" });
const chipButtons = () => within(row()).queryAllByRole("button");
const input = () => screen.getByRole("textbox");

function renderComposer(state: State = "idle", chips: ReplyChip[] = CHIPS, pending = false) {
  return render(<Composer taskId="t1" agent="claude" turn={turn(state)} suggestions={{ chips, pending }} />);
}

describe("Composer reply suggestions (transcript view)", () => {
  it("shows the suggestions instead of the static chips", () => {
    renderComposer();
    expect(chipButtons().map((b) => b.textContent)).toEqual(["Open a draft PR", "Also handle the mobile deep-link case"]);
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Run the tests" })).toBeNull();
  });

  it("a click fills and focuses the input, and never sends", () => {
    renderComposer();
    fireEvent.click(screen.getByRole("button", { name: "Also handle the mobile deep-link case" }));
    expect(input()).toHaveValue("Also handle the mobile deep-link case");
    expect(input()).toHaveFocus();
    const el = input() as HTMLTextAreaElement;
    expect(el.selectionStart).toBe(el.value.length);
    expect(sendMessageToTask).not.toHaveBeenCalled();
    // ⌘↵ is what sends it.
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    expect(sendMessageToTask).toHaveBeenCalledWith("t1", "Also handle the mobile deep-link case", true);
  });

  it("typing clears the chips; emptying the input brings them back", () => {
    renderComposer();
    fireEvent.change(input(), { target: { value: "A" } });
    expect(chipButtons()).toHaveLength(0);
    fireEvent.change(input(), { target: { value: "" } });
    expect(chipButtons()).toHaveLength(2);
  });

  it("Tab from the empty input focuses the first chip", () => {
    renderComposer();
    input().focus();
    const tab = fireEvent.keyDown(input(), { key: "Tab" });
    expect(tab).toBe(false); // default prevented
    expect(screen.getByRole("button", { name: "Open a draft PR" })).toHaveFocus();
    // Shift+Tab and Tab with text keep the browser's own order.
    input().focus();
    expect(fireEvent.keyDown(input(), { key: "Tab", shiftKey: true })).toBe(true);
    fireEvent.change(input(), { target: { value: "x" } });
    expect(fireEvent.keyDown(input(), { key: "Tab" })).toBe(true);
  });

  it("hides the chips while a turn runs", () => {
    const { rerender } = renderComposer("working");
    expect(chipButtons()).toHaveLength(0);
    rerender(<Composer taskId="t1" agent="claude" turn={turn("idle")} suggestions={{ chips: CHIPS, pending: false }} />);
    expect(chipButtons()).toHaveLength(2);
  });

  it("shows no chips at all while an approval is pending", () => {
    render(<Composer taskId="t1" agent="claude" awaitingAnswer turn={turn("needs-you")} suggestions={{ chips: CHIPS, pending: false }} />);
    expect(screen.queryByRole("group", { name: "Suggested replies" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open a draft PR" })).toBeNull();
  });

  it("shimmers while suggestions are coming and there are none yet", () => {
    const { container, rerender } = renderComposer("idle", [], true);
    expect(container.querySelector("[data-suggestion-shimmer]")).not.toBeNull();
    expect(row()).toHaveAttribute("aria-busy", "true");
    // Heuristic chips present: they show, no shimmer.
    rerender(<Composer taskId="t1" agent="claude" turn={turn("idle")} suggestions={{ chips: CHIPS, pending: true }} />);
    expect(container.querySelector("[data-suggestion-shimmer]")).toBeNull();
    expect(chipButtons()).toHaveLength(2);
    // Nothing coming, nothing to show: an empty row.
    rerender(<Composer taskId="t1" agent="claude" turn={turn("idle")} suggestions={{ chips: [], pending: false }} />);
    expect(container.querySelector("[data-suggestion-shimmer]")).toBeNull();
    expect(chipButtons()).toHaveLength(0);
  });

  it("generated chips replace the heuristic ones in the same row", () => {
    const { rerender } = renderComposer("idle", CHIPS, true);
    const before = row();
    const generated: ReplyChip[] = [{ label: "Open a draft PR", text: "Open a draft PR for the redirect fix.", source: "generated" }];
    rerender(<Composer taskId="t1" agent="claude" turn={turn("idle")} suggestions={{ chips: generated, pending: false }} />);
    expect(row()).toBe(before);
    expect(row().parentElement).toHaveClass("h-[26px]");
    const [chip] = chipButtons();
    expect(chip).toHaveAttribute("data-suggestion-source", "generated");
    expect(chip).toHaveAttribute("title", "Open a draft PR for the redirect fix.");
    fireEvent.click(chip!);
    expect(input()).toHaveValue("Open a draft PR for the redirect fix.");
  });

  it("terminal view keeps the static chips, which send", () => {
    render(<Composer taskId="t1" agent="claude" />);
    expect(screen.queryByRole("group", { name: "Suggested replies" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(sendMessageToTask).toHaveBeenCalledWith("t1", "Continue", true);
  });
});
