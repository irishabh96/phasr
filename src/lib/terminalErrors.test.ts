import { describe, expect, it } from "vitest";
import { isNotStartedError } from "@/lib/terminalErrors";

describe("isNotStartedError", () => {
  it("recognizes the backend's NotStarted refusal (a plain string over IPC)", () => {
    expect(
      isNotStartedError("this task hasn't been started on this Mac yet"),
    ).toBe(true);
    expect(
      isNotStartedError(
        new Error("this task hasn't been started on this Mac yet"),
      ),
    ).toBe(true);
  });

  it("leaves every other start failure to the normal error overlay", () => {
    expect(
      isNotStartedError("repository path `/x` does not exist on disk"),
    ).toBe(false);
    expect(isNotStartedError(undefined)).toBe(false);
  });
});
