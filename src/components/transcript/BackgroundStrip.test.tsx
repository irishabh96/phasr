import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "@/lib/transcript/contract";
import { useTranscriptFocus } from "@/lib/transcript/focus";
import { transcriptKeys } from "@/lib/transcript/useTranscript";
import { BackgroundStrip } from "./BackgroundStrip";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const ts = new Date(Date.now() - 75_000).toISOString();
const bash = (id: string, command: string, backgroundStatus?: "running" | "done" | "killed"): TranscriptItem => ({
  kind: "tool",
  id,
  ts,
  tool: "Bash",
  input: { command, run_in_background: true },
  title: `Running ${command}`,
  status: "done",
  ...(backgroundStatus ? { background: true, backgroundStatus } : {}),
});

function show(items: TranscriptItem[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(transcriptKeys.task("task-1"), items);
  return render(
    <QueryClientProvider client={client}>
      <BackgroundStrip taskId="task-1" />
    </QueryClientProvider>,
  );
}

describe("BackgroundStrip", () => {
  beforeEach(() => {
    invoke.mockReset();
    useTranscriptFocus.setState({ request: null });
  });

  it("renders nothing while no background command runs", () => {
    const { container } = show([bash("a", "ls"), bash("b", "sleep 3", "done")]);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows one chip per running command: its command and how long it's run", () => {
    show([bash("a", "pnpm dev", "running"), bash("b", "sleep 3", "done"), bash("c", "cargo watch", "running")]);
    const strip = screen.getByRole("group", { name: "Background commands" });
    expect(strip).toHaveTextContent("Background");
    const chips = strip.querySelectorAll("[data-background-chip]");
    expect(Array.from(chips, (c) => c.getAttribute("data-background-chip"))).toEqual(["a", "c"]);
    expect(chips[0]).toHaveTextContent(/pnpm dev1m 1\ds/);
  });

  it("a chip asks the transcript to show its item; × stops the command", async () => {
    invoke.mockResolvedValue(null);
    show([bash("a", "pnpm dev", "running")]);
    fireEvent.click(screen.getByRole("button", { name: /Show background command pnpm dev/ }));
    expect(useTranscriptFocus.getState().request).toMatchObject({ taskId: "task-1", itemId: "a" });
    fireEvent.click(screen.getByRole("button", { name: "Stop pnpm dev" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stop_background_shell", { taskId: "task-1", toolUseId: "a" }));
    expect(screen.getByRole("button", { name: "Stop pnpm dev" })).toBeDisabled();
  });
});
