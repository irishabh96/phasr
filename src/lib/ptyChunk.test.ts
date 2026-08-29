import { beforeEach, describe, expect, it, vi } from "vitest";

const detachTerminalStreamCmd = vi.fn(async (_id: number) => {});
const setTerminalVisibleCmd = vi.fn(async (_id: number, _visible: boolean) => {});

vi.mock("@/lib/tauri", () => ({
  tauri: {
    detachTerminalStream: (id: number) => detachTerminalStreamCmd(id),
    setTerminalVisible: (id: number, visible: boolean) =>
      setTerminalVisibleCmd(id, visible),
  },
}));

import {
  __resetDetachedStreams,
  desyncNotice,
  detachTerminalStream,
  hintTerminalVisible,
  isPtyOutput,
  ptyChunkBytes,
} from "@/lib/ptyChunk";
import type { PtyStreamMessage } from "@/lib/types";

beforeEach(() => {
  detachTerminalStreamCmd.mockClear();
  setTerminalVisibleCmd.mockClear();
  __resetDetachedStreams();
});

describe("the wire shape", () => {
  // Output arrives in TWO shapes and the size decides which: a chunk whose
  // base64 envelope still fits tauri's eval threshold keeps the envelope,
  // anything bigger crosses raw. Both are output; neither is a control
  // event.
  it("reads both output shapes as output, and control events as control", () => {
    expect(isPtyOutput(new Uint8Array([1, 2, 3]).buffer)).toBe(true);
    expect(
      isPtyOutput({ type: "output", taskId: "t", chunk: "aGk=" }),
    ).toBe(true);
    expect(
      isPtyOutput({ type: "exit", taskId: "t", exitCode: 0 } as PtyStreamMessage),
    ).toBe(false);
    expect(
      isPtyOutput({
        type: "desync",
        taskId: "t",
        missedBytes: 4096,
      } as PtyStreamMessage),
    ).toBe(false);
  });

  it("hands the emulator a view of the buffer, not a copy of it", () => {
    // The point of the raw arm: nothing between the IPC and the terminal
    // touches these bytes.
    const buffer = new Uint8Array([0x1b, 0x5b, 0x32, 0x4b]).buffer;
    const bytes = ptyChunkBytes(buffer);
    expect(bytes.buffer).toBe(buffer);
    expect(bytes.byteOffset).toBe(0);
  });

  it("decodes the base64 arm to the same bytes the raw arm would carry", () => {
    // The two arms are the same stream framed differently, so a spec that
    // exercises one must be able to trust the other.
    const raw = new Uint8Array([0x1b, 0x5b, 0x32, 0x4b, 0x41]);
    const viaBase64 = ptyChunkBytes({
      type: "output",
      taskId: "t",
      chunk: btoa(String.fromCharCode(...raw)),
    });
    expect(Array.from(viaBase64)).toEqual(Array.from(raw));
    expect(Array.from(ptyChunkBytes(raw.buffer))).toEqual(Array.from(raw));
  });

  it("carries bytes that are not valid UTF-8, on both arms", () => {
    // These are exactly what the old lossy-string wire destroyed. Base64
    // carries them because it is not text; raw carries them because it is
    // not encoded at all.
    const raw = new Uint8Array([0x1b, 0xff, 0xfe, 0x80, 0x00, 0x41]);
    expect(Array.from(ptyChunkBytes(raw.buffer))).toEqual(Array.from(raw));
    expect(
      Array.from(
        ptyChunkBytes({
          type: "output",
          taskId: "t",
          chunk: btoa(String.fromCharCode(...raw)),
        }),
      ),
    ).toEqual(Array.from(raw));
  });
});

describe("detachTerminalStream", () => {
  it("tells the backend once per channel, however many chunks arrive", async () => {
    // Chunks keep coming until the forwarder actually stops, so the trigger
    // fires repeatedly. One invoke, not one per chunk.
    detachTerminalStream(7);
    detachTerminalStream(7);
    detachTerminalStream(7);
    await Promise.resolve();
    expect(detachTerminalStreamCmd).toHaveBeenCalledTimes(1);
    expect(detachTerminalStreamCmd).toHaveBeenCalledWith(7);
  });

  it("keeps channels apart", async () => {
    detachTerminalStream(1);
    detachTerminalStream(2);
    await Promise.resolve();
    expect(detachTerminalStreamCmd.mock.calls.map(([id]) => id)).toEqual([1, 2]);
  });

  it("does not reject when the stream has already ended", async () => {
    detachTerminalStreamCmd.mockRejectedValueOnce(new Error("no such stream"));
    expect(() => detachTerminalStream(9)).not.toThrow();
    await Promise.resolve();
  });
});

describe("hintTerminalVisible", () => {
  it("pushes the hint for a live channel", async () => {
    hintTerminalVisible(4, false);
    await Promise.resolve();
    expect(setTerminalVisibleCmd).toHaveBeenCalledWith(4, false);
  });

  it("is a no-op before a channel exists", async () => {
    // A finished workspace replaying its log never opens one.
    hintTerminalVisible(null, true);
    hintTerminalVisible(undefined, true);
    await Promise.resolve();
    expect(setTerminalVisibleCmd).not.toHaveBeenCalled();
  });

  it("swallows the error when there is no live stream to hint at", async () => {
    setTerminalVisibleCmd.mockRejectedValueOnce(new Error("no such stream"));
    expect(() => hintTerminalVisible(5, true)).not.toThrow();
    await Promise.resolve();
  });
});

describe("desyncNotice", () => {
  it("erases the screen rather than painting over a hole, and says why", () => {
    const notice = desyncNotice(4096);
    expect(notice.startsWith("\x1b[2J\x1b[H")).toBe(true);
    expect(notice).toContain("4096 bytes");
    // NOT a full reset: an alt-screen program's modes must survive, because
    // it has no way to learn they were dropped.
    expect(notice).not.toContain("\x1bc");
  });
});
