import { describe, expect, it } from "vitest";
import {
  initSectionState,
  sectionReducer,
  type SectionState,
} from "./briefSectionReducer";
import type { BriefSectionContent } from "@/lib/types";

const base: BriefSectionContent = {
  content: "# Original\n\nbody",
  mtimeMs: 1000,
  lastEditedBy: "you",
  lastEditedAtMs: 900,
};

const onDisk: BriefSectionContent = {
  content: "# Someone else's version",
  mtimeMs: 2000,
  lastEditedBy: null,
  lastEditedAtMs: 1900,
};

/** Drive the reducer through a sequence of actions from a fresh read state. */
function run(...actions: Parameters<typeof sectionReducer>[1][]): SectionState {
  return actions.reduce(sectionReducer, initSectionState(base));
}

describe("briefSectionReducer", () => {
  it("starts read-first with the persisted base", () => {
    const s = initSectionState(base);
    expect(s.mode).toBe("read");
    expect(s.base).toBe(base);
    expect(s.draft).toBe("");
  });

  it("edit → seeds the draft from the base content", () => {
    const s = run({ type: "edit" });
    expect(s.mode).toBe("edit");
    expect(s.draft).toBe(base.content);
  });

  it("cancel discards the draft and returns to read", () => {
    const s = run({ type: "edit" }, { type: "change", draft: "wip" }, {
      type: "cancel",
    });
    expect(s.mode).toBe("read");
    expect(s.draft).toBe("");
    expect(s.base).toBe(base); // untouched
  });

  it("saved ADOPTS the returned section's mtime as the new base", () => {
    const written: BriefSectionContent = {
      content: "# Edited",
      mtimeMs: 3000, // fresh on-disk mtime the backend stamped
      lastEditedBy: "you",
      lastEditedAtMs: 2999,
    };
    const s = run(
      { type: "edit" },
      { type: "change", draft: "# Edited" },
      { type: "save" },
      { type: "saved", section: written },
    );
    expect(s.mode).toBe("read");
    expect(s.base).toBe(written);
    expect(s.base.mtimeMs).toBe(3000); // next save is checked against THIS
    expect(s.draft).toBe("");
    expect(s.onDisk).toBeNull();
  });

  it("conflict keeps the draft and stashes the on-disk version", () => {
    const s = run(
      { type: "edit" },
      { type: "change", draft: "# My edit" },
      { type: "save" },
      { type: "conflict", onDisk },
    );
    expect(s.mode).toBe("conflict");
    expect(s.draft).toBe("# My edit"); // not lost
    expect(s.onDisk).toBe(onDisk);
    expect(s.base).toBe(base); // base NOT advanced — nothing was written
  });

  it("conflict → reload takes the on-disk version wholesale (draft discarded)", () => {
    const s = run(
      { type: "edit" },
      { type: "change", draft: "# My edit" },
      { type: "save" },
      { type: "conflict", onDisk },
      { type: "reload" },
    );
    expect(s.mode).toBe("read");
    expect(s.base).toBe(onDisk);
    expect(s.base.mtimeMs).toBe(2000);
    expect(s.draft).toBe("");
    expect(s.onDisk).toBeNull();
  });

  it("conflict → keep-mine re-enters saving against the fresh on-disk mtime, draft intact", () => {
    const s = run(
      { type: "edit" },
      { type: "change", draft: "# My edit" },
      { type: "save" },
      { type: "conflict", onDisk },
      { type: "keepMine" },
    );
    expect(s.mode).toBe("saving");
    expect(s.draft).toBe("# My edit"); // preserved for the re-save
    // The re-save's baseMtimeMs is now the on-disk mtime (2000), not the stale 1000.
    expect(s.base).toBe(onDisk);
    expect(s.base.mtimeMs).toBe(2000);
    expect(s.onDisk).toBeNull();
  });

  it("keep-mine → saved then adopts the newest mtime (the full happy resolution)", () => {
    const merged: BriefSectionContent = {
      content: "# My edit",
      mtimeMs: 4000,
      lastEditedBy: "you",
      lastEditedAtMs: 3999,
    };
    const s = run(
      { type: "edit" },
      { type: "change", draft: "# My edit" },
      { type: "save" },
      { type: "conflict", onDisk },
      { type: "keepMine" },
      { type: "saved", section: merged },
    );
    expect(s.mode).toBe("read");
    expect(s.base.mtimeMs).toBe(4000);
  });

  it("error preserves the draft and returns to edit for a retry", () => {
    const s = run(
      { type: "edit" },
      { type: "change", draft: "# My edit" },
      { type: "save" },
      { type: "error", error: new Error("disk full") },
    );
    expect(s.mode).toBe("edit");
    expect(s.draft).toBe("# My edit");
    expect(s.error).toBeInstanceOf(Error);
  });

  it("reset adopts an external base ONLY in read mode (never clobbers a buffer)", () => {
    const next: BriefSectionContent = { ...base, content: "# Refreshed", mtimeMs: 1500 };
    // read mode: adopts
    expect(run({ type: "reset", base: next }).base).toBe(next);
    // edit mode: ignored
    const editing = run({ type: "edit" }, { type: "change", draft: "wip" }, {
      type: "reset",
      base: next,
    });
    expect(editing.mode).toBe("edit");
    expect(editing.draft).toBe("wip");
    expect(editing.base).toBe(base);
  });

  it("externalChange raises the conflict prompt while editing (never a silent overwrite)", () => {
    const s = run(
      { type: "edit" },
      { type: "change", draft: "# My edit" },
      { type: "externalChange", onDisk },
    );
    expect(s.mode).toBe("conflict");
    expect(s.onDisk).toBe(onDisk);
    expect(s.draft).toBe("# My edit");
  });
});
