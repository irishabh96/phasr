import { describe, expect, it } from "vitest";
import { mergeTargetBranch } from "./mergeTarget";

describe("mergeTargetBranch", () => {
  const repo = { defaultBranch: "main" };

  it("uses the base branch the backend reports", () => {
    expect(mergeTargetBranch({ baseBranch: "develop" }, { baseBranch: "main" }, repo)).toBe("develop");
  });

  it("falls back to the task's base when an older backend omits it", () => {
    expect(mergeTargetBranch({} as never, { baseBranch: "develop" }, repo)).toBe("develop");
    expect(mergeTargetBranch({ baseBranch: "" }, { baseBranch: "develop" }, repo)).toBe("develop");
    expect(mergeTargetBranch(undefined, { baseBranch: "release/2" }, repo)).toBe("release/2");
  });

  it("then the repository default, then main", () => {
    expect(mergeTargetBranch(undefined, { baseBranch: null }, { defaultBranch: "trunk" })).toBe("trunk");
    expect(mergeTargetBranch(undefined, undefined, undefined)).toBe("main");
  });
});
