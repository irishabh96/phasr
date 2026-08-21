import { describe, expect, it } from "vitest";
import { ReplayLog } from "@/lib/terminal/replayLog";

const bytes = (s: string) => new TextEncoder().encode(s);
const joined = (log: ReplayLog) =>
  log
    .read()
    .map((c) => (typeof c === "string" ? c : new TextDecoder().decode(c)))
    .join("");

describe("ReplayLog", () => {
  it("replays what it was given, in order", () => {
    const log = new ReplayLog(1024);
    log.append("a");
    log.append(bytes("b"));
    log.append("c");
    expect(joined(log)).toBe("abc");
    expect(log.size).toBe(3);
    expect(log.isEmpty).toBe(false);
  });

  it("starts empty, which is how a surface knows it has no buffer to protect", () => {
    expect(new ReplayLog(16).isEmpty).toBe(true);
  });

  it("ignores empty chunks rather than logging a no-op", () => {
    const log = new ReplayLog(16);
    log.append("");
    log.append(new Uint8Array(0));
    expect(log.isEmpty).toBe(true);
  });

  it("evicts oldest-first until the budget holds", () => {
    const log = new ReplayLog(10);
    log.append("aaaa");
    log.append("bbbb");
    log.append("cccc"); // 12 > 10 — the first chunk goes
    expect(joined(log)).toBe("bbbbcccc");
    expect(log.size).toBe(8);
  });

  it("keeps the TAIL of a single chunk that is bigger than the whole budget", () => {
    const log = new ReplayLog(4);
    log.append("abcdefgh");
    // Not "the write was too big so nothing is retained", and not
    // unbounded memory either: the most recent 4 bytes.
    expect(joined(log)).toBe("efgh");
    expect(log.size).toBe(4);
  });

  it("keeps the tail of an oversized byte chunk too", () => {
    const log = new ReplayLog(3);
    log.append(bytes("hello"));
    expect(joined(log)).toBe("llo");
  });

  describe("retention marks", () => {
    it("reports a chunk as retained until it is evicted", () => {
      const log = new ReplayLog(8);
      log.append("aaaa");
      const first = log.lastSeq;
      expect(log.hasRetained(first)).toBe(true);

      log.append("bbbb");
      expect(log.hasRetained(first)).toBe(true);

      log.append("cccc");
      // The mark is the point in the stream a caller cares about — for the
      // surface, where the alternate screen was entered. Once its bytes
      // are gone the answer has to be no, or a rebuild would replay a
      // TUI's frames onto the primary screen.
      expect(log.hasRetained(first)).toBe(false);
      expect(log.hasRetained(log.lastSeq)).toBe(true);
    });

    it("never reports a mark that was never appended", () => {
      const log = new ReplayLog(8);
      expect(log.hasRetained(0)).toBe(false);
      log.append("a");
      expect(log.hasRetained(log.lastSeq + 1)).toBe(false);
    });

    it("treats a chunk whose head was sliced away as no longer retained", () => {
      const log = new ReplayLog(4);
      log.append("abcdefgh");
      // Its bytes are still the best reconstruction available and are
      // still replayed — but whatever was at the front of it is gone, so
      // a mark inside it cannot be honoured.
      expect(joined(log)).toBe("efgh");
      expect(log.hasRetained(log.lastSeq)).toBe(false);
    });

    it("survives a clear without reusing sequence numbers", () => {
      const log = new ReplayLog(8);
      log.append("aaaa");
      const first = log.lastSeq;
      log.clear();
      expect(log.isEmpty).toBe(true);
      expect(log.hasRetained(first)).toBe(false);
      log.append("bbbb");
      expect(log.lastSeq).not.toBe(first);
      expect(log.hasRetained(log.lastSeq)).toBe(true);
    });
  });
});
