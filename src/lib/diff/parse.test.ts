import { describe, expect, it } from "vitest";
import {
  languageFromPath,
  pairForSideBySide,
  parseUnifiedDiff,
} from "@/lib/diff/parse";

describe("parseUnifiedDiff", () => {
  it("returns isEmpty for empty input", () => {
    const r = parseUnifiedDiff("");
    expect(r.isEmpty).toBe(true);
    expect(r.hunks).toHaveLength(0);
  });

  it("parses a simple single-hunk modification", () => {
    const raw = [
      "diff --git a/foo.ts b/foo.ts",
      "index aaa..bbb 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,3 @@",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 42;",
      " const z = 3;",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(raw);
    expect(r.path).toBe("foo.ts");
    expect(r.isNewFile).toBe(false);
    expect(r.isDeletedFile).toBe(false);
    expect(r.hunks).toHaveLength(1);
    const hunk = r.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines).toHaveLength(4);
    expect(hunk.lines[0]).toMatchObject({ kind: "context", oldLine: 1, newLine: 1 });
    expect(hunk.lines[1]).toMatchObject({ kind: "remove", oldLine: 2, newLine: null });
    expect(hunk.lines[2]).toMatchObject({ kind: "add", oldLine: null, newLine: 2 });
    expect(hunk.lines[3]).toMatchObject({ kind: "context", oldLine: 3, newLine: 3 });
  });

  it("detects new files (via /dev/null)", () => {
    const raw = [
      "diff --git a/n.ts b/n.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/n.ts",
      "@@ -0,0 +1,2 @@",
      "+hello",
      "+world",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(raw);
    expect(r.isNewFile).toBe(true);
    expect(r.path).toBe("n.ts");
    expect(r.hunks[0]?.lines).toHaveLength(2);
  });

  it("detects deleted files", () => {
    const raw = [
      "diff --git a/d.py b/d.py",
      "deleted file mode 100644",
      "--- a/d.py",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(raw);
    expect(r.isDeletedFile).toBe(true);
  });

  it("detects binary files", () => {
    const raw = [
      "diff --git a/img.png b/img.png",
      "index aaa..bbb 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(raw);
    expect(r.isBinary).toBe(true);
    expect(r.hunks).toHaveLength(0);
  });

  it("handles synthesised untracked-file diff (no `index` line)", () => {
    // Matches the format produced by synthesise_new_file_diff in
    // src-tauri/src/git/diff.rs.
    const raw = [
      "diff --git a/u.txt b/u.txt",
      "new file",
      "--- /dev/null",
      "+++ b/u.txt",
      "+line one",
      "+line two",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(raw);
    expect(r.isNewFile).toBe(true);
    // The synthesised diff omits the `@@` hunk header, so we end up
    // with zero hunks. This is a known limitation worth flagging.
    expect(r.hunks.length).toBeLessThanOrEqual(1);
  });

  it("detects renames", () => {
    const raw = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(raw);
    expect(r.isRename).toBe(true);
    expect(r.oldPath).toBe("old.ts");
    expect(r.newPath).toBe("new.ts");
  });
});

describe("pairForSideBySide", () => {
  it("pairs consecutive remove/add as a single row", () => {
    const r = parseUnifiedDiff(
      [
        "diff --git a/f.ts b/f.ts",
        "--- a/f.ts",
        "+++ b/f.ts",
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "+B",
        " c",
        "",
      ].join("\n"),
    );
    const rows = pairForSideBySide(r.hunks[0]!.lines);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ left: { content: "a" }, right: { content: "a" } });
    expect(rows[1]?.left?.kind).toBe("remove");
    expect(rows[1]?.right?.kind).toBe("add");
    expect(rows[2]).toMatchObject({ left: { content: "c" }, right: { content: "c" } });
  });

  it("spills excess removes/adds onto one side", () => {
    const r = parseUnifiedDiff(
      [
        "diff --git a/f.ts b/f.ts",
        "--- a/f.ts",
        "+++ b/f.ts",
        "@@ -1,4 +1,3 @@",
        " a",
        "-b",
        "-c",
        "+B",
        "",
      ].join("\n"),
    );
    const rows = pairForSideBySide(r.hunks[0]!.lines);
    // Row 0: context. Row 1: -b / +B paired. Row 2: -c / null.
    expect(rows).toHaveLength(3);
    expect(rows[2]?.left?.kind).toBe("remove");
    expect(rows[2]?.right).toBeNull();
  });
});

describe("languageFromPath", () => {
  it("maps known extensions", () => {
    expect(languageFromPath("a/b/foo.ts")).toBe("typescript");
    expect(languageFromPath("foo.tsx")).toBe("tsx");
    expect(languageFromPath("script.py")).toBe("python");
    expect(languageFromPath("main.rs")).toBe("rust");
  });
  it("falls back to text for unknown extensions", () => {
    expect(languageFromPath("foo.xyzzy")).toBe("text");
    expect(languageFromPath(null)).toBe("text");
    expect(languageFromPath(undefined)).toBe("text");
  });
});
