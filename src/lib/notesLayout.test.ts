import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  partition,
  reconcile,
  snapshotOf,
} from "@/lib/notesLayout";
import type { Note } from "@/lib/types";

const note = (id: string, createdAt: string, doneAt: string | null): Note => ({
  id,
  repositoryId: "repo-1",
  body: id,
  originKind: "repository",
  originWorkspaceId: null,
  originWorkspaceName: null,
  originTerminalId: null,
  originLabel: "Repository home",
  createdAt,
  updatedAt: createdAt,
  doneAt,
});

describe("partition — the two sort keys", () => {
  it("orders open notes by createdAt DESC", () => {
    const notes = [
      note("a", "2026-08-01T10:00:00Z", null),
      note("c", "2026-08-03T10:00:00Z", null),
      note("b", "2026-08-02T10:00:00Z", null),
    ];
    expect(partition(notes).open.map((n) => n.id)).toEqual(["c", "b", "a"]);
  });

  it("orders done notes by doneAt DESC — NOT by createdAt", () => {
    // Oldest note, completed most recently, must come first.
    const notes = [
      note("old", "2026-01-01T10:00:00Z", "2026-08-05T10:00:00Z"),
      note("new", "2026-08-04T10:00:00Z", "2026-08-04T11:00:00Z"),
    ];
    expect(partition(notes).done.map((n) => n.id)).toEqual(["old", "new"]);
  });

  it("splits the two populations", () => {
    const notes = [
      note("open1", "2026-08-01T10:00:00Z", null),
      note("done1", "2026-08-02T10:00:00Z", "2026-08-03T10:00:00Z"),
    ];
    const p = partition(notes);
    expect(p.open.map((n) => n.id)).toEqual(["open1"]);
    expect(p.done.map((n) => n.id)).toEqual(["done1"]);
  });
});

describe("settled layout — nothing moves while the user is interacting", () => {
  const before = [
    note("a", "2026-08-03T10:00:00Z", null),
    note("b", "2026-08-02T10:00:00Z", null),
    note("c", "2026-08-01T10:00:00Z", null),
  ];

  it("keeps a just-checked note exactly where it was", () => {
    const snapshot = snapshotOf(before);
    // User ticks "b". Live data changes; the held snapshot does not.
    const after = before.map((n) =>
      n.id === "b" ? { ...n, doneAt: "2026-08-06T10:00:00Z" } : n,
    );
    const held = applySnapshot(after, reconcile(snapshot, after));

    expect(held.open.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(held.done).toHaveLength(0);
    // …but its live state is done, which is what the checkbox reads.
    expect(held.open.find((n) => n.id === "b")?.doneAt).toBeTruthy();
  });

  it("moves it into Done once the layout settles", () => {
    const after = before.map((n) =>
      n.id === "b" ? { ...n, doneAt: "2026-08-06T10:00:00Z" } : n,
    );
    const settled = applySnapshot(after, snapshotOf(after));
    expect(settled.open.map((n) => n.id)).toEqual(["a", "c"]);
    expect(settled.done.map((n) => n.id)).toEqual(["b"]);
  });

  it("a NEW note appears immediately, even while held", () => {
    const snapshot = snapshotOf(before);
    const after = [note("fresh", "2026-08-07T10:00:00Z", null), ...before];
    const held = applySnapshot(after, reconcile(snapshot, after));
    expect(held.open[0]?.id).toBe("fresh");
  });

  it("a DELETED note disappears immediately, even while held", () => {
    const snapshot = snapshotOf(before);
    const after = before.filter((n) => n.id !== "b");
    const held = applySnapshot(after, reconcile(snapshot, after));
    expect(held.open.map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("unchecking while held also leaves position alone", () => {
    const start = [
      note("a", "2026-08-03T10:00:00Z", null),
      note("d", "2026-08-01T10:00:00Z", "2026-08-05T10:00:00Z"),
    ];
    const snapshot = snapshotOf(start);
    const after = start.map((n) => (n.id === "d" ? { ...n, doneAt: null } : n));
    const held = applySnapshot(after, reconcile(snapshot, after));
    expect(held.done.map((n) => n.id)).toEqual(["d"]);
    expect(held.open.map((n) => n.id)).toEqual(["a"]);
  });

  it("rapid multi-check holds every row still", () => {
    const snapshot = snapshotOf(before);
    const after = before.map((n) =>
      n.id === "a" || n.id === "c"
        ? { ...n, doneAt: "2026-08-06T10:00:00Z" }
        : n,
    );
    const held = applySnapshot(after, reconcile(snapshot, after));
    expect(held.open.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });
});
