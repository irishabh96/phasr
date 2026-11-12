import { describe, expect, it } from "vitest";
import { formatTokens, isRunning, modelLabel } from "@/components/session/Inspector";

describe("modelLabel (inspector Agent row)", () => {
  it("shortens current Claude ids", () => {
    expect(modelLabel("claude-opus-4-5-20251101")).toBe("Opus 4.5");
    expect(modelLabel("claude-sonnet-4-20250514")).toBe("Sonnet 4");
    expect(modelLabel("claude-haiku-4-5")).toBe("Haiku 4.5");
  });

  it("shortens legacy Claude ids", () => {
    expect(modelLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(modelLabel("claude-3-opus-20240229")).toBe("Opus 3");
  });

  it("passes other models through", () => {
    expect(modelLabel("gpt-5-codex")).toBe("GPT-5-codex");
    expect(modelLabel("o3")).toBe("o3");
    expect(modelLabel(null)).toBeNull();
    expect(modelLabel("")).toBeNull();
  });
});

describe("formatTokens", () => {
  it("reads like A-Workspace (48.2k tokens)", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(48_200)).toBe("48.2k");
    expect(formatTokens(4_000)).toBe("4k");
    expect(formatTokens(148_400)).toBe("148k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(2_000_000)).toBe("2M");
  });
});

describe("isRunning", () => {
  it("is true only for a live process of that command", () => {
    const running = [
      { runCommandId: "a", workspaceId: "w", startedAt: "", running: true, exitCode: null, port: 3000 },
      { runCommandId: "b", workspaceId: "w", startedAt: "", running: false, exitCode: 1, port: null },
    ];
    expect(isRunning(running, "a")).toBe(true);
    expect(isRunning(running, "b")).toBe(false);
    expect(isRunning(undefined, "a")).toBe(false);
  });
});
