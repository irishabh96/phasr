import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "@/components/session/Composer";

const sendMessageToTask = vi.fn();
const saveAttachment = vi.fn();
const openDialog = vi.fn();
const showToast = vi.fn();

// Voice input reads the downloaded-model list; none here.
vi.mock("@/lib/voice/useVoiceModels", () => ({ useVoiceModels: () => ({ data: [] }) }));
vi.mock("@/lib/tauri", () => ({
  tauri: {
    sendMessageToTask: (...args: unknown[]) => sendMessageToTask(...args),
    saveAttachment: (...args: unknown[]) => saveAttachment(...args),
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => openDialog(...args) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: () => Promise.resolve() }));
vi.mock("@/lib/toast", () => ({ showToast: (t: unknown) => showToast(t) }));

const WT = "/repo/.phasr/worktrees/t1";

beforeEach(() => {
  sendMessageToTask.mockReset();
  saveAttachment.mockReset();
  openDialog.mockReset();
  showToast.mockReset();
});

async function attachViaPaperclip(paths: string[]) {
  openDialog.mockResolvedValue(paths);
  fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
  await waitFor(() => expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, directory: false })));
}

describe("Composer attachments", () => {
  it("paperclip → chip → ⌘↵ sends the text with the block, then clears", async () => {
    sendMessageToTask.mockResolvedValue(undefined);
    render(<Composer taskId="t1" agent="claude" roots={[WT, "/repo"]} />);
    await attachViaPaperclip([`${WT}/src/app.ts`, "/Users/me/Desktop/bug.png"]);

    const list = await screen.findByRole("list", { name: "Attachments" });
    expect(within(list).getByRole("button", { name: "app.ts" })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "bug.png" })).toBeInTheDocument();

    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "  why does this crash?  " } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });

    await waitFor(() =>
      expect(sendMessageToTask).toHaveBeenCalledWith(
        "t1",
        "why does this crash?\n\nAttached files:\n- src/app.ts\n- /Users/me/Desktop/bug.png",
        true,
      ),
    );
    await waitFor(() => expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull());
    expect(box.value).toBe("");
  });

  it("a removed chip is not sent; attachments alone can be sent", async () => {
    sendMessageToTask.mockResolvedValue(undefined);
    render(<Composer taskId="t1" agent="claude" />);
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeDisabled();
    await attachViaPaperclip(["/a/one.txt", "/a/two.txt"]);
    fireEvent.click(await screen.findByRole("button", { name: "Remove one.txt" }));
    expect(screen.queryByRole("button", { name: "one.txt" })).toBeNull();
    expect(send).toBeEnabled();
    fireEvent.click(send);
    await waitFor(() => expect(sendMessageToTask).toHaveBeenCalledWith("t1", "Attached files:\n- /a/two.txt", true));
  });

  it("keeps the attachments when the send is refused", async () => {
    sendMessageToTask.mockRejectedValue("the agent is waiting for your answer");
    render(<Composer taskId="t1" agent="claude" />);
    await attachViaPaperclip(["/a/one.txt"]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "go" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect(showToast.mock.calls[0]?.[0]).toMatchObject({ intent: "info" });
    expect(screen.getByRole("button", { name: "one.txt" })).toBeInTheDocument();
  });

  it("pasting a screenshot saves it through save_attachment and adds an image chip", async () => {
    saveAttachment.mockResolvedValue("/app-data/attachments/abc.png");
    render(<Composer taskId="t1" agent="claude" />);
    // jsdom's File has no arrayBuffer(); WebKit's does.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = { name: "image.png", type: "image/png", size: png.length, arrayBuffer: () => Promise.resolve(png.buffer) };
    const pasted = fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        getData: () => "",
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      },
    });
    expect(pasted).toBe(false); // default prevented: nothing lands in the box
    await waitFor(() => expect(saveAttachment).toHaveBeenCalledTimes(1));
    const [bytes, ext] = saveAttachment.mock.calls[0] as [Uint8Array, string];
    expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(ext).toBe("png");
    expect(await screen.findByRole("button", { name: "Pasted image.png" })).toHaveAttribute(
      "title",
      "/app-data/attachments/abc.png",
    );
  });

  it("a plain-text paste is left to the textarea", () => {
    render(<Composer taskId="t1" agent="claude" />);
    const pasted = fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: { getData: (t: string) => (t === "text/plain" ? "hello" : ""), items: [] },
    });
    expect(pasted).toBe(true);
    expect(saveAttachment).not.toHaveBeenCalled();
  });
});
