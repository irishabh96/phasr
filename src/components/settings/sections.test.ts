import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS, SETTINGS_SECTION_IDS, searchSettings } from "./sections";
import { validateSettingsSearch } from "./useSettingsRoute";

describe("settings registry", () => {
  it("has one entry per section id, in nav order", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([...SETTINGS_SECTION_IDS]);
  });

  it("repository-scoped sections are run commands, worktrees and branch rules", () => {
    expect(SETTINGS_SECTIONS.filter((s) => s.scope === "repo").map((s) => s.id)).toEqual([
      "run-commands",
      "worktrees",
      "branch-rules",
    ]);
  });

  it("search finds a row by keyword and keeps its section", () => {
    const hits = searchSettings("blink");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.section.id).toBe("terminal");
    expect(hits[0]!.rows.map((r) => r.id)).toEqual(["cursor"]);
  });

  it("an empty query lists every section with no row hits", () => {
    const hits = searchSettings("  ");
    expect(hits).toHaveLength(SETTINGS_SECTIONS.length);
    expect(hits.every((h) => h.rows.length === 0)).toBe(true);
  });
});

describe("validateSettingsSearch", () => {
  it("keeps a known section and its repo/row", () => {
    expect(validateSettingsSearch({ settings: "worktrees", settingsRepo: "r1", settingsRow: "location" })).toEqual({
      settings: "worktrees",
      settingsRepo: "r1",
      settingsRow: "location",
    });
  });

  it("drops an unknown section so a stale link can't open a blank sheet", () => {
    expect(validateSettingsSearch({ settings: "renderer" })).toEqual({});
  });

  it("ignores unrelated params", () => {
    expect(validateSettingsSearch({ pane: "changes" })).toEqual({});
  });
});
