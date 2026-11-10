import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolItem, TranscriptItem } from "@/lib/transcript/contract";
import { useTranscriptFocus } from "@/lib/transcript/focus";
import { LINGER_MS } from "@/lib/transcript/running";
import { useSubagentStore } from "@/lib/transcript/subagentStore";
import { transcriptKeys } from "@/lib/transcript/useTranscript";
import { RunningStrip } from "./RunningStrip";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const ts = () => new Date(Date.now() - 75_000).toISOString();
const bash = (id: string, command: string, backgroundStatus?: "running" | "done" | "killed"): TranscriptItem => ({
  kind: "tool",
  id,
  ts: ts(),
  tool: "Bash",
  input: { command, run_in_background: true },
  title: `Running ${command}`,
  status: "done",
  ...(backgroundStatus ? { background: true, backgroundStatus } : {}),
});
const agent = (id: string, description: string, status: ToolItem["status"] = "running", steps = 3): TranscriptItem => ({
  kind: "tool",
  id,
  ts: ts(),
  tool: "Agent",
  input: { description },
  title: `Running a subagent: ${description}`,
  status,
  subagent: { type: "general-purpose", description, steps },
});

function show(items: TranscriptItem[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(transcriptKeys.task("task-1"), items);
  const ui = render(
    <QueryClientProvider client={client}>
      <RunningStrip taskId="task-1" />
    </QueryClientProvider>,
  );
  const update = (next: TranscriptItem[]) => act(() => void client.setQueryData(transcriptKeys.task("task-1"), next));
  return { ...ui, update };
}

const strip = () => screen.getByRole("group", { name: "Running" });
const chipIds = () => Array.from(document.querySelectorAll("[data-running-chip]"), (c) => c.getAttribute("data-running-chip"));

describe("RunningStrip", () => {
  beforeEach(() => {
    invoke.mockReset();
    useTranscriptFocus.setState({ request: null });
    useSubagentStore.setState({ selectedSubagent: {}, pinned: {}, dismissed: {}, openSeq: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing while nothing runs", () => {
    const { container } = show([bash("a", "ls"), bash("b", "sleep 3", "done"), agent("s", "Old", "done")]);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a chip per subagent at work (its description, live steps) and per running command (its command, elapsed)", () => {
    show([agent("s1", "Map the auth module"), bash("a", "pnpm dev", "running"), bash("b", "sleep 3", "done"), agent("s2", "Find callers", "running", 1)]);
    expect(strip()).toHaveTextContent("Running");
    expect(chipIds()).toEqual(["s1", "a", "s2"]);
    const sub = screen.getByRole("button", { name: "Open subagent Map the auth module, running, 3 steps" });
    expect(sub).toHaveTextContent("Map the auth module3 steps");
    expect(screen.getByRole("button", { name: /Open subagent Find callers, running, 1 step$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Show background command pnpm dev, running for 1m 1\ds/ })).toBeInTheDocument();
    // Running subagents can't be dismissed; running commands can be stopped.
    expect(screen.queryByRole("button", { name: /Dismiss/ })).toBeNull();
  });

  it("a subagent chip opens its panel; a command chip shows its item; × stops the command", async () => {
    invoke.mockResolvedValue(null);
    show([agent("s1", "Map the auth module"), bash("a", "pnpm dev", "running")]);
    fireEvent.click(screen.getByRole("button", { name: /Open subagent Map the auth module/ }));
    expect(useSubagentStore.getState().selectedSubagent).toEqual({ "task-1": "s1" });
    expect(screen.getByRole("button", { name: /Open subagent Map the auth module/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: /Show background command pnpm dev/ }));
    expect(useTranscriptFocus.getState().request).toMatchObject({ taskId: "task-1", itemId: "a", expand: true });
    fireEvent.click(screen.getByRole("button", { name: "Stop pnpm dev" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stop_background_shell", { taskId: "task-1", toolUseId: "a" }));
    expect(screen.getByRole("button", { name: "Stop pnpm dev" })).toBeDisabled();
  });

  it("a finished chip shows ✓ for a moment, then drops off; a pinned one stays until dismissed", async () => {
    // The clock (and the linger) only: the query cache notifies on a real timeout.
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { update } = show([agent("s1", "Map"), agent("s2", "Find"), bash("a", "pnpm dev", "running")]);
    // Pin the second subagent (the toggle is a button, revealed on hover/focus).
    const pin = screen.getByRole("button", { name: "Pin Find" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);
    expect(screen.getByRole("button", { name: "Unpin Find" })).toHaveAttribute("aria-pressed", "true");
    expect(useSubagentStore.getState().pinned).toEqual({ "task-1": ["s2"] });

    update([agent("s1", "Map", "done"), agent("s2", "Find", "error"), bash("a", "pnpm dev", "killed")]);
    await waitFor(() => expect(document.querySelector('[data-running-chip="s1"]')).toHaveAttribute("data-status", "done"));
    expect(chipIds()).toEqual(["s1", "s2", "a"]);
    const s1 = document.querySelector('[data-running-chip="s1"]')!;
    expect(s1).toHaveAttribute("data-status", "done");
    expect(within(s1 as HTMLElement).getByRole("button", { name: /Open subagent Map, done/ })).toHaveTextContent("✓");
    expect(document.querySelector('[data-running-chip="s2"]')).toHaveAttribute("data-status", "failed");
    expect(screen.getByRole("button", { name: /Show background command pnpm dev, stopped/ })).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(LINGER_MS + 1000));
    expect(chipIds()).toEqual(["s2"]);
    expect(document.querySelector('[data-running-chip="s2"]')).toHaveAttribute("data-pinned", "true");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Find" }));
    expect(screen.queryByRole("group", { name: "Running" })).toBeNull();
    expect(useSubagentStore.getState().dismissed).toEqual({ "task-1": ["s2"] });
  });

  it("a chip that was already over when the strip first saw it doesn't linger", () => {
    const { container } = show([agent("s1", "Map", "done"), bash("a", "sleep 1", "done")]);
    expect(container).toBeEmptyDOMElement();
  });

  it("chips that don't fit go behind +N, a menu of the rest", async () => {
    // jsdom lays nothing out: give the row and every chip a size.
    const widths = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-running-chip") ? 150 : 0;
    });
    const client = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.querySelector("[data-running-chip]") ? 400 : 0;
    });
    try {
      show([agent("s1", "One"), agent("s2", "Two"), agent("s3", "Three"), agent("s4", "Four")]);
      // 150 + 8 + 150 + 44 ≤ 400: two show, two go behind "+2".
      const more = await screen.findByRole("button", { name: "2 more" });
      expect(more).toHaveTextContent("+2");
      expect(screen.getByRole("button", { name: /Open subagent One/ })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Open subagent Three/ })).toBeNull();
      expect(document.querySelector('[data-running-chip="s3"]')).toHaveAttribute("aria-hidden", "true");
      // Radix menus open from the keyboard in jsdom (no pointer events).
      fireEvent.keyDown(more, { key: "Enter" });
      const menu = await screen.findByRole("menu");
      expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
        expect.stringContaining("Three"),
        expect.stringContaining("Four"),
      ]);
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Four/ }));
      expect(useSubagentStore.getState().selectedSubagent).toEqual({ "task-1": "s4" });
    } finally {
      widths.mockRestore();
      client.mockRestore();
    }
  });
});
