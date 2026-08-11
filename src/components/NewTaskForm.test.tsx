import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTaskForm } from "@/components/NewTaskForm";
import type { AgentOption, Repository, StartedTask, Workspace } from "@/lib/types";

const startTask = vi.fn();
const listAgents = vi.fn();
const getRepository = vi.fn();
const listLocalBranches = vi.fn();

vi.mock("@/lib/tauri", () => ({
  tauri: {
    startTask: (...args: unknown[]) => startTask(...args),
    listAgents: () => listAgents(),
    getRepository: (id: string) => getRepository(id),
    listLocalBranches: (path: string) => listLocalBranches(path),
  },
}));

function makeAgent(overrides: Partial<AgentOption> = {}): AgentOption {
  return {
    agent: "claude",
    label: "Claude",
    command: "claude --dangerously-skip-permissions",
    isDefault: true,
    ...overrides,
  };
}

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: "repo-1",
    name: "phasr",
    remoteUrl: null,
    localPath: "/tmp/phasr",
    defaultBranch: "main",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "task-1",
    repositoryId: "repo-1",
    workspaceKind: "agent",
    name: "fix login bug",
    prompt: null,
    agent: "claude",
    command: "claude --dangerously-skip-permissions",
    status: "running",
    branch: "phasr/abcd1234",
    worktreePath: "/tmp/phasr/.phasr/worktrees/task-1",
    exitCode: null,
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:01Z",
    finishedAt: null,
    archivedAt: null,
    updatedAt: "2026-01-01T00:00:01Z",
    ...overrides,
  };
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  startTask.mockReset();
  listAgents.mockReset();
  getRepository.mockReset();
  listLocalBranches.mockReset();
  listLocalBranches.mockResolvedValue([
    "develop",
    "main",
    "phasr/old-task-abc1234",
  ]);
  listAgents.mockResolvedValue([
    makeAgent({ agent: "claude", label: "Claude", isDefault: true }),
    makeAgent({
      agent: "codex",
      label: "Codex",
      command: "codex",
      isDefault: false,
    }),
  ]);
  getRepository.mockResolvedValue(makeRepository());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("NewTaskForm", () => {
  it("disables the submit button until a name is entered", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const submit = screen.getByRole("button", { name: "Start task" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/fix login redirect bug/), {
      target: { value: "fix bug" },
    });
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it("seeds the base-branch field from the repository's default branch", async () => {
    getRepository.mockResolvedValue(makeRepository({ defaultBranch: "trunk" }));
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const baseInput = await screen.findByDisplayValue("trunk");
    expect(baseInput).toBeInTheDocument();
  });

  it("calls start_task with the form values and fires onCreated", async () => {
    const created: StartedTask = {
      taskId: "task-1",
      workspace: makeWorkspace({
        name: "fix login bug",
        prompt: "make it work",
      }),
    };
    startTask.mockResolvedValue(created);
    const onCreated = vi.fn();
    renderWithClient(
      <NewTaskForm repositoryId="repo-1" onCreated={onCreated} />,
    );

    // Wait for default agent to populate before submitting.
    await screen.findByText("claude --dangerously-skip-permissions");

    fireEvent.change(screen.getByPlaceholderText(/fix login redirect bug/), {
      target: { value: "fix login bug" },
    });
    fireEvent.change(screen.getByPlaceholderText(/What should the agent do/), {
      target: { value: "make it work" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({
      repositoryId: "repo-1",
      agent: "claude",
      name: "fix login bug",
      prompt: "make it work",
      baseBranch: "main",
    });
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(created.workspace),
    );
  });

  it("⌘↵ from any field submits the form", async () => {
    startTask.mockResolvedValue({
      taskId: "task-1",
      workspace: makeWorkspace(),
    });
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await screen.findByText("claude --dangerously-skip-permissions");

    const nameInput = screen.getByPlaceholderText(/fix login redirect bug/);
    fireEvent.change(nameInput, { target: { value: "fix bug" } });
    fireEvent.keyDown(nameInput, { key: "Enter", metaKey: true });

    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
  });

  it("⌘↵ does nothing while the form is incomplete", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await screen.findByText("claude --dangerously-skip-permissions");

    const nameInput = screen.getByPlaceholderText(/fix login redirect bug/);
    fireEvent.keyDown(nameInput, { key: "Enter", metaKey: true });

    expect(startTask).not.toHaveBeenCalled();
  });

  it("surfaces backend errors inline without throwing", async () => {
    startTask.mockRejectedValue("repository has no local path");
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await screen.findByText("claude --dangerously-skip-permissions");

    fireEvent.change(screen.getByPlaceholderText(/fix login redirect bug/), {
      target: { value: "broken task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() =>
      expect(
        screen.getByText(/repository has no local path/),
      ).toBeInTheDocument(),
    );
  });

  it("opens the branch list on focus and commits a clicked branch", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const baseInput = await screen.findByDisplayValue("main");

    fireEvent.focus(baseInput);
    const option = await screen.findByText("develop");
    fireEvent.click(option);

    expect(baseInput).toHaveValue("develop");
    // Committing closes the list.
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });

  it("collapses phasr/* task branches behind a count until expanded", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const baseInput = await screen.findByDisplayValue("main");

    fireEvent.focus(baseInput);
    await screen.findByRole("listbox");
    expect(screen.queryByText("phasr/old-task-abc1234")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Phasr task branches"));
    expect(screen.getByText("phasr/old-task-abc1234")).toBeInTheDocument();
  });

  it("offers an unmatched query as a custom ref; Enter keeps it without submitting", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await screen.findByText("claude --dangerously-skip-permissions");
    const baseInput = await screen.findByDisplayValue("main");

    fireEvent.change(baseInput, { target: { value: "v1.2.0" } });
    await screen.findByText(/as a custom ref/);

    fireEvent.keyDown(baseInput, { key: "Enter" });
    expect(baseInput).toHaveValue("v1.2.0");
    expect(startTask).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
    );
  });

  it("⌘↵ with the list open commits the highlighted branch instead of submitting", async () => {
    startTask.mockResolvedValue({
      taskId: "task-1",
      workspace: makeWorkspace(),
    });
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await screen.findByText("claude --dangerously-skip-permissions");
    fireEvent.change(screen.getByPlaceholderText(/fix login redirect bug/), {
      target: { value: "fix bug" },
    });

    const baseInput = await screen.findByDisplayValue("main");
    fireEvent.focus(baseInput);
    await screen.findByRole("listbox");
    // Cursor parks on "main" (current value); ↓ moves it to "develop".
    fireEvent.keyDown(baseInput, { key: "ArrowDown" });
    fireEvent.keyDown(baseInput, { key: "Enter", metaKey: true });

    // The commit must NOT double as a form submit — that would fire
    // start_task with the value from before the commit flushed.
    expect(startTask).not.toHaveBeenCalled();
    expect(baseInput).toHaveValue("develop");

    // With the list closed, ⌘↵ submits — now carrying the committed ref.
    fireEvent.keyDown(baseInput, { key: "Enter", metaKey: true });
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({
      baseBranch: "develop",
    });
  });

  it("shows the branch-list error state and keeps the field typable", async () => {
    listLocalBranches.mockRejectedValue("git failed");
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const baseInput = await screen.findByDisplayValue("main");

    fireEvent.focus(baseInput);
    await screen.findByText(/Type a branch name instead/);

    fireEvent.change(baseInput, { target: { value: "origin/main" } });
    expect(baseInput).toHaveValue("origin/main");
  });

  it("lets the base-branch field be cleared without re-seeding", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const baseInput = await screen.findByDisplayValue("main");

    fireEvent.change(baseInput, { target: { value: "" } });
    await waitFor(() => expect(baseInput).toHaveValue(""));
  });
});
