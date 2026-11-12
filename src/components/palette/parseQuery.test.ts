import { describe, expect, it } from "vitest";
import { parseQuery, scoreMatch } from "./parseQuery";

describe("parseQuery", () => {
  it.each([
    ["redir", "all", "redir"],
    ["> new task", "commands", "new task"],
    ["#fix", "tasks", "fix"],
    ["@src/auth", "files", "src/auth"],
    ["?", "help", ""],
    ["  #  login ", "tasks", "login"],
  ])("%j → %s %j", (raw, mode, text) => {
    expect(parseQuery(raw)).toEqual({ mode, text });
  });
});

describe("scoreMatch", () => {
  it("substring beats subsequence", () => {
    const sub = scoreMatch("redir", "fix login redirect bug")!;
    const seq = scoreMatch("rdr", "fix login redirect bug")!;
    expect(sub.score).toBeGreaterThan(seq.score);
    expect(sub.range).toEqual([10, 15]);
    expect(seq.range).toBeNull();
  });
  it("word-start beats mid-word", () => {
    expect(scoreMatch("auth", "src/auth/x.ts")!.score).toBeGreaterThan(scoreMatch("auth", "oauthx")!.score);
  });
  it("no match is null; empty query matches everything", () => {
    expect(scoreMatch("zzz", "abc")).toBeNull();
    expect(scoreMatch("", "abc")).toEqual({ score: 0, range: null });
  });
});
