/**
 * The webview end of the PTY wire.
 *
 * A terminal channel carries **two shapes**, and this file is the one place
 * that knows which is which:
 *
 *   - an `ArrayBuffer` — the PTY's raw output bytes, verbatim
 *     (`InvokeResponseBody::Raw` from `src-tauri/src/commands/pty_stream.rs`);
 *   - a small JSON object — `exit` or `desync`, the control plane.
 *
 * Output used to be base64 inside a JSON envelope, decoded here with `atob`
 * plus a byte-by-byte loop (`Uint8Array.from(s, cb)` was measurably slower).
 * That whole path is gone: perf phase 4 moved output to tauri's raw payloads,
 * which deletes the encode, the envelope, the decode and the loop in one
 * move. Measured on the real channel at 32 KiB, 12.8 MB/s → 80.1 MB/s.
 *
 * Wrapping the buffer in a `Uint8Array` is a view, not a copy — the bytes are
 * never touched between the IPC and the emulator.
 */

import { tauri } from "@/lib/tauri";
import type { PtyOutputMessage, PtyStreamMessage } from "@/lib/types";

/**
 * Is this message the PTY's output rather than a control event?
 *
 * A type predicate rather than a nullable getter, so the `else` branch
 * narrows to the control events and the three handlers keep an exhaustive
 * `type` switch.
 */
export function isPtyOutput(
  message: PtyStreamMessage,
): message is PtyOutputMessage {
  return message instanceof ArrayBuffer || message.type === "output";
}

/**
 * The emulator's view of an output message, whichever shape it arrived in.
 *
 * The raw arm is free: a `Uint8Array` over the buffer is a view, not a copy,
 * so nothing rewrites those bytes between the IPC and the terminal. The
 * base64 arm is the small-chunk path, where the envelope is what keeps the
 * message on tauri's cheap `eval` transport; `atob` plus a typed-array fill
 * is the fast way to undo it (`Uint8Array.from(s, cb)` is several times
 * slower, and it is why this was never a one-liner).
 */
export function ptyChunkBytes(output: PtyOutputMessage): Uint8Array {
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  const binary = atob(output.chunk);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Channels already told to stop. The trigger for a detach is "a chunk
 * arrived for a surface that no longer exists", and chunks keep arriving
 * until the backend actually stops — so without this a busy evicted agent
 * would fire one invoke per chunk in the gap.
 *
 * Never cleaned up on purpose: ids come from a monotonic counter, so a
 * detached id is never reused, and each entry is a small integer.
 */
const detached = new Set<number>();

/**
 * Tear down one terminal's Rust-side forwarder. The child process is
 * untouched; the next mount re-attaches through the same replay path a cold
 * attach uses.
 *
 * Fire-and-forget and idempotent: the stream may have ended on its own
 * (the process exited) between the last chunk and this call, which the
 * backend reports as success anyway.
 */
export function detachTerminalStream(channelId: number): void {
  if (detached.has(channelId)) return;
  detached.add(channelId);
  void tauri.detachTerminalStream(channelId).catch(() => {});
}

/** Test seam: forget which channels have been detached. */
export function __resetDetachedStreams(): void {
  detached.clear();
}

/**
 * Push the visibility hint for one terminal's PTY (see
 * `tauri.setTerminalVisible`).
 *
 * Swallows failures because a legitimate one exists: a finished workspace
 * showing its log, or a terminal whose process already exited, has no live
 * stream to hint at. The hint is advisory — losing it costs latency, never
 * a byte.
 */
export function hintTerminalVisible(
  channelId: number | null | undefined,
  visible: boolean,
): void {
  if (channelId == null) return;
  void tauri.setTerminalVisible(channelId, visible).catch(() => {});
}

/**
 * What to write into a surface when the backend reports a `desync`.
 *
 * A desync means bytes were dropped by the broadcast **and** could not be
 * read back from the log because it had already rotated past them
 * (`src-tauri/src/pty/backfill.rs`). Everything on screen from that point is
 * a fiction: a VT stream is cursor moves and erases, so painting the next
 * frame over a hole corrupts the display until the program happens to repaint
 * in full — which a paused agent may never do.
 *
 * So: erase the screen, home the cursor, and say so in one dim line. A TUI
 * overwrites the notice on its next frame (which is the recovery); a shell
 * leaves it visible, which is the honest answer to "why did my scrollback
 * jump". Deliberately NOT a full reset (`\x1bc`) — that would drop the modes
 * an alt-screen program set and it has no way to learn they are gone.
 */
export function desyncNotice(missedBytes: number): string {
  return (
    `\x1b[2J\x1b[H` +
    `\x1b[2m[phasr: ${missedBytes} bytes of output were lost and could not be ` +
    `recovered from the log — the screen was cleared rather than painted over]\x1b[0m\r\n`
  );
}
