import { useEffect, useRef, useState } from "react";
import type { Note } from "@/lib/types";

/**
 * Layout rules for the notes list.
 *
 * The list holds two populations with DIFFERENT sort keys — open notes
 * by `createdAt` DESC, done notes by `doneAt` DESC — in one surface.
 *
 * The subtlety is *when* a row is allowed to move. Checking a note
 * changes which population it belongs to, and reflowing immediately
 * yanks every row below it out from under the pointer mid-click. So
 * membership comes from a **settled snapshot** that only recomputes
 * once the user is demonstrably not interacting with the panel. Tone
 * and the checkbox itself update instantly; only *position* waits.
 *
 * Additions and removals are never deferred — a note you just wrote
 * must appear now, and a deleted note must vanish now. Only an existing
 * note changing section is held back.
 */

export interface NotePartition {
  open: Note[];
  done: Note[];
}

const byCreatedDesc = (a: Note, b: Note) =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

const byDoneDesc = (a: Note, b: Note) =>
  (b.doneAt ?? "").localeCompare(a.doneAt ?? "") || b.id.localeCompare(a.id);

/** Split by live done-state and apply each population's own sort key. */
export function partition(notes: Note[]): NotePartition {
  const open: Note[] = [];
  const done: Note[] = [];
  for (const n of notes) (n.doneAt ? done : open).push(n);
  open.sort(byCreatedDesc);
  done.sort(byDoneDesc);
  return { open, done };
}

/** Which section a row is *rendered* in — not necessarily its live state. */
export type Section = "open" | "done";

/** id → section, the part that is held still while the user interacts. */
export type LayoutSnapshot = Record<string, Section>;

export function snapshotOf(notes: Note[]): LayoutSnapshot {
  const snap: LayoutSnapshot = {};
  for (const n of notes) snap[n.id] = n.doneAt ? "done" : "open";
  return snap;
}

/**
 * Reconcile a held snapshot against current data: brand-new ids adopt
 * their live section immediately, vanished ids drop out, and ids the
 * snapshot already knows keep their held section.
 */
export function reconcile(
  snapshot: LayoutSnapshot,
  notes: Note[],
): LayoutSnapshot {
  const next: LayoutSnapshot = {};
  for (const n of notes) {
    next[n.id] = snapshot[n.id] ?? (n.doneAt ? "done" : "open");
  }
  return next;
}

/** Apply a snapshot: rows sit where the snapshot says, sorted per section. */
export function applySnapshot(
  notes: Note[],
  snapshot: LayoutSnapshot,
): NotePartition {
  const open: Note[] = [];
  const done: Note[] = [];
  for (const n of notes) {
    (snapshot[n.id] === "done" ? done : open).push(n);
  }
  // Open keeps createdAt order. Done rows that are only *pending* a move
  // have no doneAt-based position yet, so sorting them by doneAt with a
  // createdAt fallback keeps them stable either way.
  open.sort(byCreatedDesc);
  done.sort((a, b) =>
    a.doneAt && b.doneAt ? byDoneDesc(a, b) : byCreatedDesc(a, b),
  );
  return { open, done };
}

/**
 * Holds layout still while `held` is true, then settles after a beat.
 * `held` should be true whenever the pointer or focus is inside the
 * panel — the two ways a user can have a row targeted.
 */
export function useSettledLayout(
  notes: Note[],
  held: boolean,
  settleDelayMs = 250,
): NotePartition {
  const [snapshot, setSnapshot] = useState<LayoutSnapshot>(() =>
    snapshotOf(notes),
  );
  const notesRef = useRef(notes);
  notesRef.current = notes;

  // Adopt new/removed ids immediately, without moving existing rows.
  const reconciled = reconcile(snapshot, notes);

  useEffect(() => {
    if (held) return;
    const t = setTimeout(
      () => setSnapshot(snapshotOf(notesRef.current)),
      settleDelayMs,
    );
    return () => clearTimeout(t);
    // `notes` is included so a change arriving while unheld still settles.
  }, [held, notes, settleDelayMs]);

  return applySnapshot(notes, reconciled);
}
