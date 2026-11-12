import { afterEach, describe, expect, it } from "vitest";
import {
  __resetHighlighterForTests,
  ensureLanguage,
  getHighlighter,
  isSupportedLanguage,
  tokenizeLine,
} from "@/lib/diff/shiki";

afterEach(() => {
  __resetHighlighterForTests();
});

describe("lazy shiki", () => {
  it("resolves unsupported languages to text", async () => {
    expect(isSupportedLanguage("ruby")).toBe(false);
    await expect(ensureLanguage("ruby")).resolves.toBe("text");
    await expect(ensureLanguage("")).resolves.toBe("text");
    await expect(ensureLanguage("text")).resolves.toBe("text");
    // Not inherited Object.prototype keys either.
    await expect(ensureLanguage("toString")).resolves.toBe("text");
  });

  it("loads a grammar on demand and highlights with it", async () => {
    expect(isSupportedLanguage("typescript")).toBe(true);
    await expect(ensureLanguage("typescript")).resolves.toBe("typescript");
    const hl = await getHighlighter();
    expect(hl.getLoadedLanguages()).toContain("typescript");
    // Only the requested grammar (and its embedded deps) is registered.
    expect(hl.getLoadedLanguages()).not.toContain("rust");

    const tokens = tokenizeLine(hl, "const x: number = 1;", "typescript", "github-dark");
    expect(tokens.map((t) => t.content).join("")).toBe("const x: number = 1;");
    expect(new Set(tokens.map((t) => t.color)).size).toBeGreaterThan(1);
  });

  it("dedupes concurrent loads and shares one highlighter", async () => {
    const [a, b] = await Promise.all([ensureLanguage("rust"), ensureLanguage("rust")]);
    expect(a).toBe("rust");
    expect(b).toBe("rust");
    expect(getHighlighter()).toBe(getHighlighter());
  });

  it("tokenises a grammar that isn't loaded yet as plaintext", async () => {
    const hl = await getHighlighter();
    const tokens = tokenizeLine(hl, "fn main() {}", "rust", "github-light");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.content).toBe("fn main() {}");
  });
});
