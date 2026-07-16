import { describe, it, expect } from "vitest";
import { humanizeError } from "./humanizeError";

describe("humanizeError", () => {
  it("humanizes a clone of a nonexistent repo (the template 404 bug)", () => {
    // The exact shape phasr surfaced: `template error - git command failed:
    // Cloning into '...'... remote: Repository not found. fatal: repository
    // 'https://github.com/lapce/tauri-react-template/' not found`.
    const raw =
      "template error - git command failed: Cloning into '/Users/x/.phasr/projects/t'... remote: Repository not found. fatal: repository 'https://github.com/lapce/tauri-react-template/' not found";
    expect(humanizeError(raw)).toBe(
      "That repository couldn't be found — check the URL; it may be private, renamed, or removed.",
    );
  });

  it("humanizes 'does not appear to be a git repository'", () => {
    expect(
      humanizeError(
        "fatal: 'https://example.com/x' does not appear to be a git repository",
      ),
    ).toMatch(/repository couldn't be found/);
  });

  it("keeps existing rules", () => {
    expect(humanizeError("destination path already exists")).toMatch(
      /already exists/,
    );
    expect(humanizeError("fatal: Authentication failed for 'x'")).toMatch(
      /authentication failed/i,
    );
    expect(humanizeError("fatal: could not resolve host: github.com")).toMatch(
      /network error/i,
    );
    expect(humanizeError("fatal: couldn't find remote ref main")).toMatch(
      /branch or ref/,
    );
  });

  it("falls back to the raw message for unrecognized errors", () => {
    expect(humanizeError("some bespoke failure")).toBe("some bespoke failure");
    expect(humanizeError(new Error("boom"))).toBe("boom");
  });
});
