import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ tauri: { launchApp: vi.fn() } }));

const { findPathTokens, resolvePathToken } = await import(
  "@/lib/terminal/links"
);

describe("findPathTokens", () => {
  it("matches bare relative paths with a :line:col suffix", () => {
    const tokens = findPathTokens("error in src/lib/foo.ts:123:7 — fix it");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.path).toBe("src/lib/foo.ts");
    // Full link text includes the :line:col suffix.
    const text = "error in src/lib/foo.ts:123:7 — fix it";
    expect(text.slice(tokens[0]!.start, tokens[0]!.end)).toBe(
      "src/lib/foo.ts:123:7",
    );
  });

  it("matches absolute and dot-relative paths", () => {
    expect(findPathTokens("see /Users/x/app.log")[0]?.path).toBe(
      "/Users/x/app.log",
    );
    expect(findPathTokens("run ./scripts/dev.sh first")[0]?.path).toBe(
      "./scripts/dev.sh",
    );
    expect(findPathTokens("cat ../other/file.txt")[0]?.path).toBe(
      "../other/file.txt",
    );
  });

  it("matches paths wrapped in quotes and brackets", () => {
    expect(findPathTokens("open 'src/a/b.rs' now")[0]?.path).toBe("src/a/b.rs");
    expect(findPathTokens("(src/a/b.rs:9)")[0]?.path).toBe("src/a/b.rs");
  });

  it("does not match URLs or their path segments", () => {
    expect(findPathTokens("visit https://example.com/a/b now")).toHaveLength(0);
    expect(findPathTokens("http://x.dev/y")).toHaveLength(0);
  });

  it("does not match bare words, domains, or ~ paths", () => {
    expect(findPathTokens("plain words example.com nothing")).toHaveLength(0);
    // ~ can't be expanded on the frontend — deliberately not a link.
    expect(findPathTokens("see ~/Downloads/x.txt")).toHaveLength(0);
    expect(findPathTokens("a/b")).toHaveLength(1); // minimal slash path IS a path
  });

  it("finds multiple tokens on one line", () => {
    const tokens = findPathTokens("moved src/a.ts -> src/b.ts");
    expect(tokens.map((t) => t.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("resolvePathToken", () => {
  it("passes absolute paths through, cwd or not", () => {
    expect(resolvePathToken("/tmp/x.log", null)).toBe("/tmp/x.log");
    expect(resolvePathToken("/tmp/x.log", "/repo")).toBe("/tmp/x.log");
  });

  it("resolves relative paths against the cwd", () => {
    expect(resolvePathToken("src/lib/foo.ts", "/repo")).toBe(
      "/repo/src/lib/foo.ts",
    );
    expect(resolvePathToken("./scripts/dev.sh", "/repo/")).toBe(
      "/repo/scripts/dev.sh",
    );
    expect(resolvePathToken("../other/f.txt", "/repo/sub")).toBe(
      "/repo/sub/../other/f.txt",
    );
  });

  it("returns null for relative paths without a cwd", () => {
    expect(resolvePathToken("src/lib/foo.ts", null)).toBeNull();
  });
});
