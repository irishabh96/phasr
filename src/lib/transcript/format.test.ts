import { describe, expect, it } from "vitest";
import {
  diffFromToolInput,
  formatClock,
  formatCost,
  formatDuration,
  formatResult,
  formatThought,
  lineDiff,
  outputLines,
  outputTail,
  splitTitle,
  stripAnsi,
} from "./format";

const kinds = (lines: { kind: string; text: string }[]) => lines.map((l) => `${l.kind[0]}:${l.text}`);

describe("lineDiff", () => {
  it("is −old, +new for a one-line change", () => {
    expect(kinds(lineDiff("a", "b"))).toEqual(["r:a", "a:b"]);
  });

  it("keeps shared leading and trailing lines as context", () => {
    expect(kinds(lineDiff("x\nold\ny", "x\nnew\ny"))).toEqual(["c:x", "r:old", "a:new", "c:y"]);
  });

  it("diffs the middle by LCS: unchanged lines inside stay context", () => {
    expect(kinds(lineDiff("a\nb\nc\nd", "a\nB\nc\nD"))).toEqual(["c:a", "r:b", "a:B", "c:c", "r:d", "a:D"]);
  });

  it("handles pure insertions and deletions", () => {
    expect(kinds(lineDiff("", "one\ntwo"))).toEqual(["a:one", "a:two"]);
    expect(kinds(lineDiff("one\ntwo", ""))).toEqual(["r:one", "r:two"]);
  });

  it("ignores a trailing newline and normalises CRLF", () => {
    expect(kinds(lineDiff("a\r\nb\r\n", "a\nb\n"))).toEqual(["c:a", "c:b"]);
  });
});

describe("diffFromToolInput", () => {
  it("builds an Edit's diff from old_string / new_string", () => {
    const d = diffFromToolInput("Edit", { file_path: "a.ts", old_string: "return 1;", new_string: "return 2;" });
    expect(d && kinds(d.lines)).toEqual(["r:return 1;", "a:return 2;"]);
    expect(d).toMatchObject({ adds: 1, removes: 1 });
  });

  it("joins a MultiEdit's edits with a gap between them", () => {
    const d = diffFromToolInput("MultiEdit", {
      file_path: "a.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B\nB2" },
        { nonsense: true },
      ],
    });
    expect(d!.lines.map((l) => l.kind)).toEqual(["remove", "add", "gap", "remove", "add", "add"]);
    expect(d).toMatchObject({ adds: 3, removes: 2 });
  });

  it("shows a Write's content as all additions", () => {
    const d = diffFromToolInput("Write", { file_path: "a.ts", content: "one\ntwo\n" });
    expect(d && kinds(d.lines)).toEqual(["a:one", "a:two"]);
    expect(d).toMatchObject({ adds: 2, removes: 0 });
  });

  it("is null for other tools and inputs that don't parse", () => {
    expect(diffFromToolInput("Bash", { command: "ls" })).toBeNull();
    expect(diffFromToolInput("Edit", { old_string: "a" })).toBeNull();
    expect(diffFromToolInput("Edit", null)).toBeNull();
    expect(diffFromToolInput("Edit", "old → new")).toBeNull();
    expect(diffFromToolInput("MultiEdit", { edits: "nope" })).toBeNull();
    expect(diffFromToolInput("MultiEdit", { edits: [] })).toBeNull();
    expect(diffFromToolInput("Write", { content: 3 })).toBeNull();
  });

  it("falls back to −all/+all past the LCS size limit", () => {
    const big = (p: string) => Array.from({ length: 600 }, (_, i) => `${p}${i}`).join("\n");
    const d = diffFromToolInput("Edit", { old_string: big("a"), new_string: big("b") })!;
    expect(d.removes).toBe(600);
    expect(d.adds).toBe(600);
    expect(d.lines[0]!.kind).toBe("remove");
    expect(d.lines[600]!.kind).toBe("add");
  });
});

describe("output tail", () => {
  const out = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");

  it("keeps the last 12 lines and counts the rest", () => {
    const t = outputTail(out);
    expect(t.lines).toHaveLength(12);
    expect(t.lines[0]).toBe("line 9");
    expect(t.lines[11]).toBe("line 20");
    expect(t).toMatchObject({ hidden: 8, total: 20 });
  });

  it("shows short output whole", () => {
    expect(outputTail("a\nb")).toEqual({ lines: ["a", "b"], hidden: 0, total: 2 });
    expect(outputTail(undefined)).toEqual({ lines: [], hidden: 0, total: 0 });
  });

  it("drops trailing blank lines, ANSI colour and progress-bar redraws", () => {
    expect(outputLines("\u001b[32m✓ ok\u001b[0m\r\n10%\r50%\r100%\n\n  \n")).toEqual(["✓ ok", "100%"]);
    expect(stripAnsi("\u001b[1;31mred\u001b[0m")).toBe("red");
  });

  it("takes any tail length", () => {
    expect(outputTail(out, 3).lines).toEqual(["line 18", "line 19", "line 20"]);
  });
});

describe("formatting", () => {
  it("splits a title into its verb and object", () => {
    expect(splitTitle("Editing src/a.ts")).toEqual({ verb: "Editing", object: "src/a.ts" });
    expect(splitTitle('Searching "foo bar"')).toEqual({ verb: "Searching", object: '"foo bar"' });
    expect(splitTitle("TodoWrite")).toEqual({ verb: "TodoWrite", object: "" });
  });

  it("formats local HH:MM:SS", () => {
    const d = new Date(2026, 10, 11, 9, 5, 7);
    expect(formatClock(d.toISOString())).toBe("09:05:07");
    expect(formatClock("not a date")).toBe("");
  });

  it("formats durations, cost and the result line", () => {
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(23_000)).toBe("23s");
    expect(formatDuration(252_000)).toBe("4m 12s");
    expect(formatDuration(3_780_000)).toBe("1h 3m");
    expect(formatCost(0.04)).toBe("$0.04");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(null)).toBeNull();
    expect(formatResult({ durationMs: 23_000, costUsd: 0.04, isError: false })).toBe("Done in 23s · $0.04");
    expect(formatResult({ durationMs: 23_000, costUsd: null, isError: false })).toBe("Done in 23s");
    expect(formatResult({ durationMs: 5_000, costUsd: 0.01, isError: true })).toBe("Stopped after 5s · $0.01");
  });

  it("says how long a thought took", () => {
    expect(formatThought(4_200)).toBe("Thought for 4s");
    expect(formatThought(200)).toBe("Thought for 1s");
    expect(formatThought(undefined)).toBe("Thought");
  });
});
