import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTaskForm } from "@/components/NewTaskForm";
import type { AgentOption, Repository, StartedTask, Workspace } from "@/lib/types";

const startTask = vi.fn();
const listAgents = vi.fn();
const getRepository = vi.fn();

vi.mock("@/lib/tauri", () => ({
  tauri: {
    startTask: (...args: unknown[]) => startTask(...args),
    listAgents: () => listAgents(),
    getRepository: (id: string) => getRepository(id),
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
    shippedAt: null,
    interruptedAt: null,
    parentId: null,
    role: null,
    autopilotEnabled: false,
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
});
