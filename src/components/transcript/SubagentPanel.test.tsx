import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolItem, TranscriptItem } from "@/lib/transcript/contract";
import { useTranscriptFocus } from "@/lib/transcript/focus";
import { useSubagentStore } from "@/lib/transcript/subagentStore";
import { transcriptKeys } from "@/lib/transcript/useTranscript";
import { SubagentPanel } from "./SubagentPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const start = Date.parse("2026-11-11T10:00:00.000Z");
const at = (s: number) => new Date(start + s * 1000).toISOString();
const call = (extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: "tool",
  id: "agent-1",
  ts: at(0),
  tool: "Agent",
  input: { description: "Map the auth module" },
  title: "Running a subagent: Map the auth module",
  status: "running",
  subagent: { type: "Explore", description: "Map the auth module", steps: 1 },
  ...extra,
});
const step = (id: string, title: string, parentId: string, s = 1, status: ToolItem["status"] = "done"): TranscriptItem => ({
  kind: "tool",
  id,
  ts: at(s),
  tool: title.startsWith("Reading") ? "Read" : "Bash",
  input: {},
  title,
  status,
  parentId,
});
const base = (agent: ToolItem = call()): TranscriptItem[] => [
  { kind: "user", id: "u1", ts: at(0), text: "Fix it" },
  agent,
  step("s1", "Running ls src/auth", "agent-1", 2),
  { kind: "tool", id: "other", ts: at(3), tool: "Agent", input: {}, title: "Running a subagent: Other", status: "running", subagent: { type: "general-purpose", description: "Other", steps: 0 } },
  step("o1", "Reading other.ts", "other", 3),
  {
    kind: "tool",
    id: "inner",
    ts: at(4),
    tool: "Agent",
    input: {},
    title: "Running a subagent: Dig deeper",
    status: "done",
    parentId: "agent-1",
    subagent: { type: "general-purpose", description: "Dig deeper", steps: 1 },
  },
  step("i1", "Reading src/auth/deep.ts", "inner", 5),
  step("s2", "Reading src/auth/redirect.ts", "agent-1", 6, "running"),
];

function show(items: TranscriptItem[], callId = "agent-1") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(transcriptKeys.task("task-1"), items);
  const ui = render(
    <QueryClientProvider client={client}>
      <SubagentPanel taskId="task-1" callId={callId} />
    </QueryClientProvider>,
  );
  const update = (next: TranscriptItem[]) => act(() => void client.setQueryData(transcriptKeys.task("task-1"), next));
  return { ...ui, update };
}

const panel = () => screen.getByTestId("subagent-panel");
const rowIds = () =>
  Array.from(panel().querySelectorAll("[data-subagent-body] > div > [data-transcript-item]"), (r) => r.getAttribute("data-item-id"));

describe("SubagentPanel", () => {
  beforeEach(() => {
    useSubagentStore.setState({ selectedSubagent: { "task-1": "agent-1" }, pinned: {}, dismissed: {}, openSeq: 0 });
    useTranscriptFocus.setState({ request: null });
  });

  it("heads with Back, what it was asked, and its type · status · elapsed · steps", () => {
    show(base());
    const region = screen.getByRole("region", { name: "Subagent: Map the auth module" });
    const buttons = within(region).getAllByRole("button");
    // Back comes first in tab order.
    expect(buttons[0]).toHaveAccessibleName("Back");
    expect(within(region).getByRole("heading", { level: 2 })).toHaveTextContent("Map the auth module");
    const meta = region.querySelector("[data-subagent-meta]")!;
    expect(meta).toHaveTextContent(/^Explore·running·\d+[smh].*·3 steps$/);
    // No tokens reported: none shown.
    expect(meta).not.toHaveTextContent("tokens");
  });

  it("lists only its own items, nested subagents inside their call, with no time column", () => {
    show(base());
    expect(rowIds()).toEqual(["s1", "inner", "s2"]);
    expect(panel()).not.toHaveTextContent("Reading other.ts");
    expect(panel()).not.toHaveTextContent("Fix it");
    expect(panel().querySelectorAll("time")).toHaveLength(0);
    // A nested subagent opens in the panel (switching it), its chevron inline.
    fireEvent.click(within(panel()).getByRole("button", { name: /1 step$/ }));
    expect(within(panel()).getByRole("group", { name: "Subagent: Dig deeper" })).toHaveTextContent("Reading src/auth/deep.ts");
    fireEvent.click(within(panel()).getByRole("button", { name: /Subagent Dig deeper/ }));
    expect(useSubagentStore.getState().selectedSubagent["task-1"]).toBe("inner");
  });

  it("is live: new steps appear as they arrive", async () => {
    const { update } = show(base());
    update([...base(), step("s3", "Running pnpm test", "agent-1", 7, "running")]);
    await waitFor(() => expect(rowIds()).toEqual(["s1", "inner", "s2", "s3"]));
    expect(panel().querySelector("[data-subagent-meta]")).toHaveTextContent("4 steps");
  });

  it("once done: its elapsed time, tokens, and the report (collapsible markdown)", () => {
    const done = call({
      status: "done",
      output: "The redirect lives in **redirect.ts**.",
      subagent: { type: "Explore", description: "Map the auth module", steps: 3, tokens: 14_117, finishedAt: at(83) },
    });
    show(base(done));
    const meta = panel().querySelector("[data-subagent-meta]")!;
    expect(meta).toHaveTextContent("Explore·done·1m 23s·3 steps·14.1k tokens");
    const report = screen.getByRole("region", { name: "Report" });
    expect(within(report).getByText("redirect.ts").tagName).toBe("STRONG");
    fireEvent.click(within(report).getByRole("button", { name: "Report" }));
    expect(within(report).queryByText("redirect.ts")).toBeNull();
  });

  it("without an end time, a finished subagent's elapsed runs to its last step", () => {
    show(base(call({ status: "done" })));
    expect(panel().querySelector("[data-subagent-elapsed]")).toHaveTextContent("6s");
  });

  it("Back, or Esc, returns to the inspector; Esc in a text field elsewhere doesn't", () => {
    show(base());
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useSubagentStore.getState().selectedSubagent["task-1"]).toBe("agent-1");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useSubagentStore.getState().selectedSubagent["task-1"]).toBeUndefined();
    input.remove();

    useSubagentStore.getState().selectSubagent("task-1", "agent-1");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(useSubagentStore.getState().selectedSubagent["task-1"]).toBeUndefined();
  });

  it("closes itself when its call leaves the transcript", async () => {
    const { update } = show(base());
    update([{ kind: "user", id: "u1", ts: at(0), text: "Fix it" }]);
    await waitFor(() => expect(useSubagentStore.getState().selectedSubagent["task-1"]).toBeUndefined());
  });

  it("“Show in transcript” reveals its row there without expanding it", () => {
    show(base());
    fireEvent.click(screen.getByRole("button", { name: /Show in transcript/ }));
    expect(useTranscriptFocus.getState().request).toMatchObject({ taskId: "task-1", itemId: "agent-1", expand: false });
  });
});
