import { describe, expect, it } from "vitest";
import { rowWidth, trimHistoryForReflow, type SnapshotRow } from "./serialize";

const row = (text: string, cols: number, wrapped = false): SnapshotRow => ({
  cells: Array.from({ length: cols }, (_, i) => ({ text: text[i] ?? " ", fg: null, bg: null, flags: 0 })),
  wrapped,
});

describe("rowWidth", () => {
  it("counts up to the last non-blank cell", () => {
    expect(rowWidth(row("abc", 10))).toBe(3);
    expect(rowWidth(row("", 10))).toBe(0);
  });
});

describe("trimHistoryForReflow", () => {
  it("keeps everything when unlimited", () => {
    const h = [row("a", 10), row("b", 10)];
    expect(trimHistoryForReflow(h, [], 10, 5, Number.POSITIVE_INFINITY)).toBe(h);
  });

  it("counts rows at the NEW width: lines that re-wrap use more of the limit", () => {
    // Ten 20-char lines from an 80-col grid; at 10 cols each takes 2 rows.
    const h = Array.from({ length: 10 }, (_, i) => row(`line ${i}`.padEnd(20, "x"), 80));
    const kept = trimHistoryForReflow(h, [], 10, 5, 6);
    expect(kept).toHaveLength(3); // 3 lines × 2 rows = 6
    expect(rowWidth(kept[0]!)).toBe(20);
  });

  it("reserves room for screen rows that spill into history on a shorter grid", () => {
    const h = Array.from({ length: 10 }, (_, i) => row(`h${i}`, 10));
    const screen = Array.from({ length: 6 }, (_, i) => row(`s${i}`, 10));
    // New grid is 4 rows high: 2 screen rows spill, leaving 3 of a 5 limit.
    expect(trimHistoryForReflow(h, screen, 10, 4, 5)).toHaveLength(3);
  });

  it("drops whole logical lines, never half of a wrapped one", () => {
    const h = [row("a".repeat(10), 10), row("b".repeat(10), 10, true), row("c", 10)];
    // Budget 2 at 10 cols: "c" (1 row) fits; the 20-char wrapped line (2 rows) doesn't.
    const kept = trimHistoryForReflow(h, [], 10, 5, 2);
    expect(kept.map((r) => r.cells[0]!.text)).toEqual(["c"]);
  });
});
