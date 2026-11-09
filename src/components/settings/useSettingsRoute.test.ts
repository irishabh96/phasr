import { describe, expect, it } from "vitest";
import { keepSettingsSearch } from "./useSettingsRoute";

describe("keepSettingsSearch", () => {
  it("keeps the sheet's params across a redirect", () => {
    expect(
      keepSettingsSearch({ settings: "agents", settingsRow: "permission-mode", settingsRepo: "r1" }),
    ).toEqual({ settings: "agents", settingsRow: "permission-mode", settingsRepo: "r1" });
  });

  it("drops everything else, and unknown sections", () => {
    expect(keepSettingsSearch({ pane: "changes", other: 1 })).toEqual({});
    expect(keepSettingsSearch({ settings: "nope" })).toEqual({});
  });
});
