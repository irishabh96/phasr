import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Suggestion, TranscriptItem } from "@/lib/types";
import { writeSuggestReplies } from "./suggestPref";
import { useReplySuggestions } from "./useReplySuggestions";
import { transcriptKeys } from "./useTranscript";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a), Channel: class {} }));
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  },
}));

const ts = "2026-11-11T10:00:00.000Z";
const TURN: TranscriptItem[] = [
  { kind: "user", id: "u1", ts, text: "Fix the login redirect" },
  { kind: "assistant", id: "a1", ts, text: "Fixed. Want me to open a draft PR, or also handle the mobile deep-link case?", streaming: false },
  { kind: "result", id: "r1", ts, durationMs: 1, costUsd: null, isError: false },
];
const GENERATED: Suggestion[] = [
  { label: "Open a draft PR", text: "Open a draft PR for the redirect fix.", source: "generated" },
];

function setup(items: TranscriptItem[] = TURN) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(transcriptKeys.task("t1"), items);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}
const suggestCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "suggest_replies");

beforeEach(() => {
  invoke.mockReset();
  handlers.clear();
  localStorage.clear();
});
afterEach(() => localStorage.clear());

describe("useReplySuggestions", () => {
  it("shows the heuristics at once, then the generated ones", async () => {
    let answer!: (v: Suggestion[]) => void;
    invoke.mockImplementation((cmd: string) => (cmd === "suggest_replies" ? new Promise((r) => (answer = r)) : Promise.resolve([])));
    const { wrapper } = setup();
    const { result } = renderHook(() => useReplySuggestions("t1", true, "idle"), { wrapper });
    expect(result.current.chips.map((c) => c.label)).toEqual(["Open a draft PR", "Also handle the mobile deep-link case"]);
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(suggestCalls()).toEqual([["suggest_replies", { taskId: "t1" }]]));
    await act(async () => answer(GENERATED));
    expect(result.current.chips).toEqual([{ ...GENERATED[0], source: "generated" }]);
    expect(result.current.pending).toBe(false);
  });

  it("takes them from phasr://suggestions for this task's turn", async () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    const { wrapper } = setup();
    const { result } = renderHook(() => useReplySuggestions("t1", true, "idle"), { wrapper });
    await waitFor(() => expect(handlers.has("phasr://suggestions")).toBe(true));
    // Another task's, or an older turn's: ignored.
    act(() => handlers.get("phasr://suggestions")!({ payload: { taskId: "t2", turnId: "r1", suggestions: GENERATED } }));
    act(() => handlers.get("phasr://suggestions")!({ payload: { taskId: "t1", turnId: "r0", suggestions: GENERATED } }));
    expect(result.current.chips[0]?.source).toBe("heuristic");
    act(() => handlers.get("phasr://suggestions")!({ payload: { taskId: "t1", turnId: "r1", suggestions: GENERATED } }));
    expect(result.current.chips.map((c) => [c.label, c.source])).toEqual([["Open a draft PR", "generated"]]);
  });

  it("keeps the heuristics when generation finds nothing or fails", async () => {
    invoke.mockRejectedValue("boom");
    const { wrapper } = setup();
    const { result } = renderHook(() => useReplySuggestions("t1", true, "idle"), { wrapper });
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.chips.map((c) => c.source)).toEqual(["heuristic", "heuristic"]);
  });

  it("asks once per turn, and not mid-turn or on an approval", async () => {
    invoke.mockResolvedValue([]);
    const { wrapper } = setup();
    const { result, rerender } = renderHook(({ state }) => useReplySuggestions("t1", true, state), {
      wrapper,
      initialProps: { state: "working" as "working" | "idle" | "needs-you" },
    });
    expect(result.current.chips).toEqual([]);
    rerender({ state: "needs-you" });
    expect(result.current.chips).toEqual([]);
    expect(suggestCalls()).toHaveLength(0);
    rerender({ state: "idle" });
    await waitFor(() => expect(suggestCalls()).toHaveLength(1));
    rerender({ state: "idle" });
    rerender({ state: "idle" });
    expect(suggestCalls()).toHaveLength(1);
  });

  it("with the setting off, never calls suggest_replies (heuristics only)", async () => {
    writeSuggestReplies(false);
    invoke.mockResolvedValue(GENERATED);
    const { wrapper } = setup();
    const { result } = renderHook(() => useReplySuggestions("t1", true, "idle"), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(suggestCalls()).toHaveLength(0);
    expect(handlers.has("phasr://suggestions")).toBe(false);
    expect(result.current).toEqual({
      chips: [
        { label: "Open a draft PR", text: "Open a draft PR", source: "heuristic" },
        { label: "Also handle the mobile deep-link case", text: "Also handle the mobile deep-link case", source: "heuristic" },
      ],
      pending: false,
    });
    // Turned on: asks for the turn that already ended.
    act(() => writeSuggestReplies(true));
    await waitFor(() => expect(suggestCalls()).toHaveLength(1));
  });

  it("does nothing for a terminal-view task", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useReplySuggestions("t1", false, "idle"), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toEqual({ chips: [], pending: false });
    expect(invoke).not.toHaveBeenCalled();
  });
});
