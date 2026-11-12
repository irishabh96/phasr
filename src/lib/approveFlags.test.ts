import { describe, expect, it } from "vitest";
import { approveOptions, NO_APPROVE_FLAGS, withApproveFlags } from "./approveFlags";

describe("approve confirmations", () => {
  it("a fresh attempt sends no overrides", () => {
    expect(approveOptions(NO_APPROVE_FLAGS)).toEqual({});
  });

  it("checks confirmed, then dirty confirmed: the retry carries both", () => {
    const afterChecks = withApproveFlags(NO_APPROVE_FLAGS, { overrideChecks: true });
    expect(approveOptions(afterChecks)).toEqual({ overrideChecks: true });
    const afterDirty = withApproveFlags(afterChecks, { commitDirty: true });
    expect(approveOptions(afterDirty)).toEqual({ overrideChecks: true, commitDirty: true });
  });

  it("dirty confirmed, then checks confirmed: the retry carries both", () => {
    const afterDirty = withApproveFlags(NO_APPROVE_FLAGS, { commitDirty: true });
    const afterChecks = withApproveFlags(afterDirty, { overrideChecks: true });
    expect(approveOptions(afterChecks)).toEqual({ overrideChecks: true, commitDirty: true });
  });

  it("never drops a confirmation", () => {
    const both = { overrideChecks: true, commitDirty: true };
    expect(withApproveFlags(both, { overrideChecks: false })).toEqual(both);
  });
});
