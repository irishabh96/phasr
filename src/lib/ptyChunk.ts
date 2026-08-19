/**
 * Decode a `PtyEvent.output` chunk into the bytes the PTY actually produced.
 *
 * The chunk crosses the IPC base64-encoded because a terminal is a byte
 * protocol, not a text one. It used to arrive as a lossy UTF-8 string, which
 * cost a carry buffer on the Rust side (to avoid splitting a codepoint
 * across reads, which corrupted column tracking) and turned every non-UTF-8
 * byte into U+FFFD before any emulator could see it.
 *
 * `atob` + a typed-array fill is the fast path: `Uint8Array.from(s, cb)` is
 * several times slower, and these chunks are up to 32 KiB and arrive at
 * whatever rate an agent repaints.
 */
export function decodePtyChunk(chunk: string): Uint8Array {
  const binary = atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
