import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/session/Composer";
import { isAwaitingAnswerError } from "@/lib/humanizeError";

const sendMessageToTask = vi.fn();
const showToast = vi.fn();

vi.mock("@/lib/tauri", () => ({
  tauri: { sendMessageToTask: (...args: unknown[]) => sendMessageToTask(...args) },
}));
vi.mock("@/lib/toast", () => ({ showToast: (t: unknown) => showToast(t) }));

beforeEach(() => {
  sendMessageToTask.mockReset();
  showToast.mockReset();
});

describe("Composer while the agent waits on a permission dialog", () => {
  it("offers nothing that would type into the agent", () => {
    render(<Composer taskId="t1" agent="claude" awaitingAnswer />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/answer the request above/i);
  });

  it("is the normal composer otherwise", () => {
    render(<Composer taskId="t1" agent="claude" />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("turns the backend's refusal into a calm info toast", async () => {
    sendMessageToTask.mockRejectedValue("the agent is waiting for your answer");
    render(<Composer taskId="t1" agent="claude" />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast.mock.calls[0]?.[0]).toMatchObject({ intent: "info" });
  });
});

describe("Composer send key (D8: ⌘↵ sends, Enter is a newline)", () => {
  it("shows the A-Workspace placeholder and send hint", () => {
    render(<Composer taskId="t1" agent="claude" />);
    expect(screen.getByPlaceholderText("Reply to Claude…")).toBeInTheDocument();
    expect(screen.getByText("⌘↵ send")).toBeInTheDocument();
  });

  it("a bare Enter does not send", () => {
    sendMessageToTask.mockResolvedValue(undefined);
    render(<Composer taskId="t1" agent="claude" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "first line" } });
    const notPrevented = fireEvent.keyDown(box, { key: "Enter" });
    // Not prevented: the textarea inserts the newline itself.
    expect(notPrevented).toBe(true);
    expect(sendMessageToTask).not.toHaveBeenCalled();
  });

  it("Shift+Enter and ⌥↵ do not send either", () => {
    render(<Composer taskId="t1" agent="claude" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hello" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true, altKey: true });
    expect(sendMessageToTask).not.toHaveBeenCalled();
  });

  it("⌘↵ sends the trimmed message and clears the box", async () => {
    sendMessageToTask.mockResolvedValue(undefined);
    render(<Composer taskId="t1" agent="claude" />);
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "  line one\nline two  " } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(sendMessageToTask).toHaveBeenCalledWith("t1", "line one\nline two", true));
    await waitFor(() => expect(box.value).toBe(""));
  });

  it("Ctrl+↵ sends too (non-mac keyboards)", async () => {
    sendMessageToTask.mockResolvedValue(undefined);
    render(<Composer taskId="t1" agent="claude" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "hi" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(sendMessageToTask).toHaveBeenCalledTimes(1));
  });

  it("⌘↵ mid-IME-composition does not send", () => {
    render(<Composer taskId="t1" agent="claude" />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "にほん" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true, isComposing: true });
    expect(sendMessageToTask).not.toHaveBeenCalled();
  });

  it("⌘↵ on an empty box sends nothing", () => {
    render(<Composer taskId="t1" agent="claude" />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });
    expect(sendMessageToTask).not.toHaveBeenCalled();
  });
});

describe("isAwaitingAnswerError", () => {
  it("matches the backend string, raw or wrapped", () => {
    expect(isAwaitingAnswerError("the agent is waiting for your answer")).toBe(true);
    expect(isAwaitingAnswerError(new Error("send failed: the agent is waiting for your answer"))).toBe(true);
    expect(isAwaitingAnswerError("agent not running")).toBe(false);
  });
});
