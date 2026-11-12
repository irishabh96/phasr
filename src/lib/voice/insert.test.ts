import { describe, expect, it } from "vitest";
import { formatElapsed, insertDictation } from "./insert";

describe("insertDictation", () => {
  it("fills an empty box", () => {
    expect(insertDictation("", 0, 0, "  Add a test. ")).toEqual({ value: "Add a test.", caret: 11 });
  });

  it("spaces itself after a word and before one", () => {
    expect(insertDictation("Please now", 6, 6, "run the tests")).toEqual({
      value: "Please run the tests now",
      caret: 20,
    });
  });

  it("doesn't double up whitespace or pad punctuation", () => {
    expect(insertDictation("Fix it\n", 7, 7, "then ship")).toEqual({ value: "Fix it\nthen ship", caret: 16 });
    expect(insertDictation("Fix it .", 7, 7, "now")).toEqual({ value: "Fix it now.", caret: 10 });
  });

  it("replaces the selection", () => {
    expect(insertDictation("Use foo here", 4, 7, "the parser")).toEqual({ value: "Use the parser here", caret: 14 });
  });

  it("leaves the text alone when nothing was said", () => {
    expect(insertDictation("abc", 1, 2, "  ")).toEqual({ value: "abc", caret: 2 });
  });
});

it("formats elapsed time", () => {
  expect(formatElapsed(0)).toBe("0:00");
  expect(formatElapsed(7_900)).toBe("0:07");
  expect(formatElapsed(102_000)).toBe("1:42");
});
