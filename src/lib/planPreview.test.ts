import { describe, expect, it } from "vitest";
import { buildPlanPreview, nameFromPrompt } from "./planPreview";

describe("nameFromPrompt", () => {
  it("takes the first clause, lower-cased, at most six words", () => {
    expect(nameFromPrompt("Fix the login redirect bug: after refreshing the cookie…")).toBe(
      "fix the login redirect bug",
    );
    expect(nameFromPrompt("Add missing tests for src/utils and the date helpers please")).toBe(
      "add missing tests for src/utils and",
    );
    expect(nameFromPrompt("   ")).toBe("");
  });
});

describe("buildPlanPreview", () => {
  it("worktree: branch off the base, then the agent in that worktree", () => {
    const plan = buildPlanPreview({
      name: "Fix login redirect",
      baseBranch: "main",
      runIn: "worktree",
      agentCommand: "claude --permission-mode acceptEdits",
    });
    expect(plan[0]!.line).toBe("git worktree add ~/.phasr/worktrees/<task> -b phasr/fix-login-redirect main");
    expect(plan[1]).toEqual({ line: "claude --permission-mode acceptEdits", note: "in that worktree" });
  });
  it("in place: just the agent, in the checkout", () => {
    const plan = buildPlanPreview({ name: "x", baseBranch: "main", runIn: "in-place", agentCommand: "codex" });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.note).toMatch(/checkout/);
  });
});
