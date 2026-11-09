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

describe("isAwaitingAnswerError", () => {
  it("matches the backend string, raw or wrapped", () => {
    expect(isAwaitingAnswerError("the agent is waiting for your answer")).toBe(true);
    expect(isAwaitingAnswerError(new Error("send failed: the agent is waiting for your answer"))).toBe(true);
    expect(isAwaitingAnswerError("agent not running")).toBe(false);
  });
});
