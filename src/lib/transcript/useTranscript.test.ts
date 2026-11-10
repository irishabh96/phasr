import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptEvent, TranscriptItem } from "./contract";
import { applyTranscriptBatch, loadTranscript, transcriptKeys } from "./useTranscript";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const ts = "2026-11-11T10:00:00.000Z";
const item = (id: string, text: string): TranscriptItem => ({ kind: "assistant", id, ts, text, streaming: false });
const ev = (taskId: string, i: TranscriptItem, op: "append" | "update" = "append"): TranscriptEvent => ({ taskId, op, item: i });

beforeEach(() => invoke.mockReset());

describe("transcript cache", () => {
  it("patches only transcripts that are cached", () => {
    const qc = new QueryClient();
    qc.setQueryData(transcriptKeys.task("t1"), [item("a", "one")]);
    applyTranscriptBatch(qc, [ev("t1", item("b", "two")), ev("t2", item("c", "three"))]);
    expect(qc.getQueryData<TranscriptItem[]>(transcriptKeys.task("t1"))?.map((i) => i.id)).toEqual(["a", "b"]);
    // Not loaded yet: it loads whole when first shown.
    expect(qc.getQueryData(transcriptKeys.task("t2"))).toBeUndefined();
  });

  it("replays events that arrived while the snapshot was loading", async () => {
    let resolve!: (v: TranscriptItem[]) => void;
    invoke.mockImplementation(() => new Promise((r) => (resolve = r)));
    const qc = new QueryClient();
    const loading = loadTranscript("t1");
    expect(invoke).toHaveBeenCalledWith("get_transcript", { taskId: "t1" });
    // Emitted after the backend read its JSONL, delivered before the answer.
    applyTranscriptBatch(qc, [ev("t1", item("b", "late")), ev("t1", item("a", "one, updated"), "update")]);
    resolve([item("a", "one")]);
    const items = await loading;
    expect(items.map((i) => [i.id, (i as { text: string }).text])).toEqual([
      ["a", "one, updated"],
      ["b", "late"],
    ]);
    // …and only for that load.
    invoke.mockResolvedValue([item("a", "one")]);
    expect((await loadTranscript("t1")).map((i) => i.id)).toEqual(["a"]);
  });
});
