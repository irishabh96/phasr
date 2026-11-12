import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./contract";
import { applyTranscriptEvents, mergeItem } from "./reduce";

const ts = "2026-11-11T10:42:03.000Z";
const user = (id: string, text = "hi"): TranscriptItem => ({ kind: "user", id, ts, text });
const say = (id: string, text: string, streaming = true): TranscriptItem => ({ kind: "assistant", id, ts, text, streaming });
const tool = (id: string, status: "running" | "done" | "error" | "denied", output?: string): TranscriptItem => ({
  kind: "tool",
  id,
  ts,
  tool: "Bash",
  input: { command: "pnpm test" },
  title: "Running pnpm test",
  status,
  ...(output !== undefined ? { output } : {}),
});
const append = (item: TranscriptItem) => ({ op: "append" as const, item });
const update = (item: TranscriptItem) => ({ op: "update" as const, item });

describe("applyTranscriptEvents", () => {
  it("appends new items in arrival order", () => {
    const out = applyTranscriptEvents([], [append(user("u1")), append(say("a1", "On it"))]);
    expect(out.map((i) => i.id)).toEqual(["u1", "a1"]);
  });

  it("replaces an item in place on update, keeping the others by identity", () => {
    const u = user("u1");
    const before = [u, say("a1", "The redirect")];
    const out = applyTranscriptEvents(before, [update(say("a1", "The redirect loses ?next="))]);
    expect(out).not.toBe(before);
    expect(out[0]).toBe(u);
    expect(out[1]).toMatchObject({ text: "The redirect loses ?next=" });
    expect(out).toHaveLength(2);
  });

  it("returns the same array when nothing changed", () => {
    const a = say("a1", "x", false);
    const before = [a];
    expect(applyTranscriptEvents(before, [update(a)])).toBe(before);
    expect(applyTranscriptEvents(before, [])).toBe(before);
  });

  it("treats an update for an unseen id as an append (its append was coalesced away)", () => {
    const out = applyTranscriptEvents([user("u1")], [update(tool("t1", "done", "ok"))]);
    expect(out.map((i) => i.id)).toEqual(["u1", "t1"]);
  });

  it("treats an append of a known id as an update (the snapshot already had it)", () => {
    const out = applyTranscriptEvents([tool("t1", "running")], [append(tool("t1", "done", "ok"))]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: "done", output: "ok" });
  });

  it("never moves a finished tool back to running (an out-of-order update)", () => {
    const done = tool("t1", "done", "14 passed");
    const out = applyTranscriptEvents([done], [update(tool("t1", "running"))]);
    expect(out[0]).toBe(done);
    for (const s of ["error", "denied"] as const) {
      const settled = tool("t2", s);
      expect(applyTranscriptEvents([settled], [update(tool("t2", "running"))])[0]).toBe(settled);
    }
  });

  it("keeps a background command that ended ended, while a running one takes its live output", () => {
    const bg = (backgroundStatus: "running" | "done" | "killed", output: string): TranscriptItem => ({
      ...(tool("bg", "done", output) as Extract<TranscriptItem, { kind: "tool" }>),
      background: true,
      backgroundStatus,
    });
    const live = applyTranscriptEvents([bg("running", "tick 1")], [update(bg("running", "tick 1\ntick 2"))]);
    expect(live[0]).toMatchObject({ output: "tick 1\ntick 2", backgroundStatus: "running" });
    const killed = bg("killed", "tick 1\ntick 2\ntick 3");
    // A coalesced live tail landing after the final state.
    expect(applyTranscriptEvents([killed], [update(bg("running", "tick 1\ntick 2"))])[0]).toBe(killed);
    expect(applyTranscriptEvents([bg("done", "a")], [update(killed)])[0]).toBe(killed);
  });

  it("still lets a finished tool change between settled states", () => {
    const out = applyTranscriptEvents([tool("t1", "done")], [update(tool("t1", "error", "boom"))]);
    expect(out[0]).toMatchObject({ status: "error", output: "boom" });
  });

  it("keeps a finished reply finished, and ignores a stale shorter delta", () => {
    const final = say("a1", "Done here.", false);
    expect(applyTranscriptEvents([final], [update(say("a1", "Done", true))])[0]).toBe(final);
    const long = say("a1", "The redirect loses", true);
    expect(applyTranscriptEvents([long], [update(say("a1", "The red", true))])[0]).toBe(long);
    // A rewrite that isn't a prefix is taken as is.
    expect(applyTranscriptEvents([long], [update(say("a1", "Other", true))])[0]).toMatchObject({ text: "Other" });
  });

  it("applies a mixed batch: update before append, append, then updates", () => {
    const out = applyTranscriptEvents(
      [user("u1")],
      [update(say("a1", "Look")), append(tool("t1", "running")), update(say("a1", "Looking")), update(tool("t1", "done"))],
    );
    expect(out.map((i) => i.id)).toEqual(["u1", "a1", "t1"]);
    expect(out[1]).toMatchObject({ text: "Looking" });
    expect(out[2]).toMatchObject({ status: "done" });
  });

  it("tolerates an undefined starting list", () => {
    expect(applyTranscriptEvents(undefined, [append(user("u1"))])).toHaveLength(1);
  });
});

describe("mergeItem", () => {
  it("takes the new item when the kind changed", () => {
    const next = say("x", "now a reply", false);
    expect(mergeItem(tool("x", "done"), next)).toBe(next);
  });
});
