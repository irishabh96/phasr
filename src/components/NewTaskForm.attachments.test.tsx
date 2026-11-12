import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewTaskForm } from "@/components/NewTaskForm";
import type { Repository, StartedTask, Workspace } from "@/lib/types";

const startTask = vi.fn();
const createTaskDraft = vi.fn();
const openDialog = vi.fn();

const repository: Repository = {
  id: "repo-1",
  name: "phasr",
  remoteUrl: null,
  localPath: "/tmp/phasr",
  defaultBranch: "main",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const workspace = {
  id: "task-1",
  repositoryId: "repo-1",
  workspaceKind: "agent",
  name: "t",
  prompt: null,
  agent: "claude",
  command: "claude",
  status: "running",
  branch: "phasr/t",
  worktreePath: "/tmp/phasr/.phasr/worktrees/task-1",
  exitCode: null,
  createdAt: "2026-01-01T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  archivedAt: null,
  updatedAt: "2026-01-01T00:00:00Z",
} as Workspace;

vi.mock("@/lib/tauri", () => ({
  tauri: {
    startTask: (...args: unknown[]) => startTask(...args),
    createTaskDraft: (...args: unknown[]) => createTaskDraft(...args),
    listAgents: () =>
      Promise.resolve([{ agent: "claude", label: "Claude", command: "claude", isDefault: true }]),
    detectAgents: () => Promise.resolve([]),
    getRepository: () => Promise.resolve(repository),
    getRepositoryConfig: () => Promise.resolve({ repositoryId: "repo-1", defaultBaseBranch: null }),
    listLocalBranches: () => Promise.resolve(["main"]),
    listRunCommands: () => Promise.resolve([]),
    listUntrustedRunCommands: () => Promise.resolve([]),
    startRunCommandForTask: () => Promise.resolve(),
    saveAttachment: () => Promise.resolve("/x.png"),
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => openDialog(...args) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: () => Promise.resolve() }));

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NewTaskForm repositoryId="repo-1" />
    </QueryClientProvider>,
  );
}

async function agentReady() {
  fireEvent.click(await screen.findByRole("button", { name: "Show commands" }));
  await screen.findByText("claude");
}

beforeEach(() => {
  startTask.mockReset();
  createTaskDraft.mockReset();
  openDialog.mockReset();
  startTask.mockResolvedValue({ taskId: "task-1", workspace } satisfies StartedTask);
  createTaskDraft.mockResolvedValue(workspace);
});

describe("NewTaskForm attachments", () => {
  it("Attach → chips → remove one → Start sends the prompt with the block", async () => {
    renderForm();
    await agentReady();
    openDialog.mockResolvedValue(["/tmp/phasr/src/login.ts", "/Users/me/Desktop/error.png", "/tmp/notes.md"]);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith(expect.objectContaining({ multiple: true, directory: false })),
    );

    const list = await screen.findByRole("list", { name: "Attachments" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.md" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Fix the login error" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({
      name: "fix the login error",
      prompt: "Fix the login error\n\nAttached files:\n- src/login.ts\n- /Users/me/Desktop/error.png",
    });
  });

  it("starts with only attachments, named after the first file", async () => {
    renderForm();
    await agentReady();
    const start = screen.getByRole("button", { name: "Start task" });
    expect(start).toBeDisabled();
    openDialog.mockResolvedValue(["/Users/me/Desktop/Crash-Report.png"]);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await screen.findByRole("button", { name: "Crash-Report.png" });
    expect(screen.getByLabelText("Task name")).toHaveAttribute("placeholder", "crash-report");
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({
      name: "crash-report",
      prompt: "Attached files:\n- /Users/me/Desktop/Crash-Report.png",
    });
  });

  it("Save as draft stores the prompt with the block", async () => {
    renderForm();
    await agentReady();
    openDialog.mockResolvedValue(["/tmp/phasr/README.md"]);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await screen.findByRole("button", { name: "README.md" });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Tidy the readme" } });
    fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Enter", metaKey: true, shiftKey: true });
    await waitFor(() => expect(createTaskDraft).toHaveBeenCalledTimes(1));
    expect(createTaskDraft.mock.calls[0]?.[0]).toMatchObject({
      prompt: "Tidy the readme\n\nAttached files:\n- README.md",
    });
  });

  it("a cancelled picker attaches nothing", async () => {
    renderForm();
    openDialog.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Attach files" }));
    await waitFor(() => expect(openDialog).toHaveBeenCalled());
    expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
  });
});
