import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/session/Composer";
import { queuedMessages } from "@/lib/transcript/sendQueue";

const sendMessageToTask = vi.fn();
const showToast = vi.fn();

// Voice input reads the downloaded-model list; none here.
vi.mock("@/lib/voice/useVoiceModels", () => ({ useVoiceModels: () => ({ data: [] }) }));
vi.mock("@/lib/tauri", () => ({
  tauri: { sendMessageToTask: (...args: unknown[]) => sendMessageToTask(...args) },
}));
vi.mock("@/lib/toast", () => ({ showToast: (t: unknown) => showToast(t) }));

beforeEach(() => {
  sendMessageToTask.mockReset();
  sendMessageToTask.mockResolvedValue(undefined);
  showToast.mockReset();
});
afterEach(() => queuedMessages.set("t1", null));

type State = "working" | "idle" | "needs-you" | "exited" | null;
const turn = (state: State, onStop = vi.fn().mockResolvedValue(undefined)) => ({ state, onStop });
const type = (text: string) => fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
const sendChord = () => fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", metaKey: true });

describe("Composer in transcript view", () => {
  it("swaps Send for Stop while the agent works, and Stop interrupts the turn", async () => {
    const onStop = vi.fn().mockResolvedValue(undefined);
    render(<Composer taskId="t1" agent="claude" turn={turn("working", onStop)} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    // Empty box: the mic beside Stop; typed text: Queue beside Stop.
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument();
    type("later");
    expect(screen.getByRole("button", { name: "Queue message" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
  });

  it("toasts when the interrupt fails", async () => {
    render(<Composer taskId="t1" agent="claude" turn={turn("working", vi.fn().mockRejectedValue("no turn"))} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "error", title: "Couldn't stop Claude" })));
  });

  it("queues a message sent mid-turn, then sends it when the turn ends", async () => {
    const { rerender } = render(<Composer taskId="t1" agent="claude" turn={turn("working")} />);
    type("Also handle deep links");
    sendChord();
    expect(sendMessageToTask).not.toHaveBeenCalled();
    expect(screen.getByRole("status", { name: "Queued message" })).toHaveTextContent("QueuedAlso handle deep links");
    // The input stays usable.
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("textbox")).not.toBeDisabled();

    // A second message joins the first.
    type("and the tests");
    sendChord();
    expect(screen.getByRole("status", { name: "Queued message" })).toHaveTextContent("Also handle deep links and the tests");

    // Not on an approval mid-turn…
    rerender(<Composer taskId="t1" agent="claude" turn={turn("needs-you")} />);
    expect(sendMessageToTask).not.toHaveBeenCalled();
    // …but once the turn is over.
    rerender(<Composer taskId="t1" agent="claude" turn={turn("idle")} />);
    await waitFor(() =>
      expect(sendMessageToTask).toHaveBeenCalledWith("t1", "Also handle deep links\n\nand the tests", true),
    );
    expect(sendMessageToTask).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("status", { name: "Queued message" })).toBeNull());
  });

  it("puts a refused queued message back in the box", async () => {
    sendMessageToTask.mockRejectedValue("agent not running");
    const { rerender } = render(<Composer taskId="t1" agent="claude" turn={turn("working")} />);
    type("Keep this");
    sendChord();
    rerender(<Composer taskId="t1" agent="claude" turn={turn("exited")} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Keep this"));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ intent: "warning" }));
  });

  it("cancelling the queued message returns it to the input", () => {
    render(<Composer taskId="t1" agent="claude" turn={turn("working")} />);
    type("Never mind");
    sendChord();
    fireEvent.click(screen.getByRole("button", { name: "Cancel queued message" }));
    expect(screen.queryByRole("status", { name: "Queued message" })).toBeNull();
    expect(screen.getByRole("textbox")).toHaveValue("Never mind");
  });

  it("keeps the queue across a remount (switching tasks and back)", async () => {
    const first = render(<Composer taskId="t1" agent="claude" turn={turn("working")} />);
    type("Survive the switch");
    sendChord();
    first.unmount();
    render(<Composer taskId="t1" agent="claude" turn={turn("working")} />);
    expect(screen.getByRole("status", { name: "Queued message" })).toHaveTextContent("Survive the switch");
  });

  it("sends straight away when the agent isn't working", async () => {
    render(<Composer taskId="t1" agent="claude" turn={turn("idle")} />);
    type("Go");
    await act(async () => {
      sendChord();
    });
    expect(sendMessageToTask).toHaveBeenCalledWith("t1", "Go", true);
    // Sent and cleared: the slot is the mic again, not Stop.
    expect(screen.getByRole("button", { name: "Dictate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop turn" })).toBeNull();
  });

  it("still hides behind an approval, as in terminal view", () => {
    render(<Composer taskId="t1" agent="claude" awaitingAnswer turn={turn("needs-you")} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop turn" })).toBeNull();
  });

  it("terminal view (no turn) never queues or shows Stop", async () => {
    render(<Composer taskId="t1" agent="claude" />);
    type("Straight through");
    await act(async () => {
      sendChord();
    });
    expect(sendMessageToTask).toHaveBeenCalledWith("t1", "Straight through", true);
    expect(screen.queryByRole("button", { name: "Stop turn" })).toBeNull();
  });
});
