import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewTaskForm } from "@/components/NewTaskForm";
import type { AgentDetection, AgentOption, Repository, RunCommand, StartedTask, Workspace } from "@/lib/types";

const startTask = vi.fn();
const createTaskDraft = vi.fn();
const listAgents = vi.fn();
const detectAgents = vi.fn();
const getRepository = vi.fn();
const listLocalBranches = vi.fn();
const getRepositoryConfig = vi.fn();
const listRunCommands = vi.fn();
const listUntrustedRunCommands = vi.fn();
const startRunCommandForTask = vi.fn();

vi.mock("@/lib/tauri", () => ({
  tauri: {
    startTask: (...args: unknown[]) => startTask(...args),
    createTaskDraft: (...args: unknown[]) => createTaskDraft(...args),
    listAgents: () => listAgents(),
    detectAgents: () => detectAgents(),
    getRepository: (id: string) => getRepository(id),
    getRepositoryConfig: (id: string) => getRepositoryConfig(id),
    listLocalBranches: (path: string) => listLocalBranches(path),
    listRunCommands: (id: string) => listRunCommands(id),
    listUntrustedRunCommands: (id: string) => listUntrustedRunCommands(id),
    startRunCommandForTask: (...args: unknown[]) => startRunCommandForTask(...args),
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

function makeRunCommand(overrides: Partial<RunCommand> = {}): RunCommand {
  return {
    id: "rc-dev",
    repositoryId: "repo-1",
    name: "dev",
    command: "pnpm dev",
    shortcut: null,
    pinned: true,
    sortOrder: 0,
    runWhen: "manual",
    detectPort: true,
    requiredForApprove: false,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function detection(agent: AgentDetection["agent"], overrides: Partial<AgentDetection> = {}): AgentDetection {
  return {
    agent,
    binary: agent,
    path: `/usr/local/bin/${agent}`,
    version: null,
    status: "installed",
    installHint: `npm i -g ${agent}`,
    detectedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as AgentDetection;
}

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** Radix menus open from the keyboard in jsdom (no pointer events). */
function openMenu(name: RegExp) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
}

/** The base branch chip opens a popover holding the branch search. */
async function openBranchPicker(): Promise<HTMLInputElement> {
  const chip = await screen.findByRole("button", { name: /^Base branch: main/ });
  // Disabled until the repository (and its branch seed) has loaded.
  await waitFor(() => expect(chip).toBeEnabled());
  fireEvent.click(chip);
  const input = (await screen.findByRole("combobox")) as HTMLInputElement;
  expect(input.id).toBe("new-task-base-branch");
  return input;
}

/** Wait until the default agent loaded (the plan prints its command). */
async function agentReady() {
  fireEvent.click(await screen.findByRole("button", { name: "Show commands" }));
  await screen.findByText("claude --dangerously-skip-permissions");
}

beforeEach(() => {
  startTask.mockReset();
  createTaskDraft.mockReset();
  listAgents.mockReset();
  detectAgents.mockReset();
  getRepository.mockReset();
  listLocalBranches.mockReset();
  listRunCommands.mockReset();
  listUntrustedRunCommands.mockReset();
  startRunCommandForTask.mockReset();
  listLocalBranches.mockResolvedValue(["develop", "main", "phasr/old-task-abc1234"]);
  listAgents.mockResolvedValue([
    makeAgent({ agent: "claude", label: "Claude", isDefault: true }),
    makeAgent({ agent: "codex", label: "Codex", command: "codex", isDefault: false }),
  ]);
  detectAgents.mockResolvedValue([]);
  getRepository.mockResolvedValue(makeRepository());
  getRepositoryConfig.mockReset();
  getRepositoryConfig.mockResolvedValue({ repositoryId: "repo-1", defaultBaseBranch: null });
  listRunCommands.mockResolvedValue([]);
  listUntrustedRunCommands.mockResolvedValue([]);
  startRunCommandForTask.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("NewTaskForm", () => {
  it("disables the submit button until a name is entered", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const submit = screen.getByRole("button", { name: "Start task" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "fix bug" },
    });
    await waitFor(() => expect(submit).not.toBeDisabled());
  });

  it("focuses the prompt first; the title shows the name derived from it", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const prompt = screen.getByLabelText("Prompt");
    const name = screen.getByLabelText("Task name");
    expect(document.activeElement).toBe(prompt);
    // Tab order: prompt, then name (the title sits above it visually).
    expect(prompt.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(prompt, { target: { value: "Fix the login redirect: it drops ?next" } });
    expect(name).toHaveAttribute("placeholder", "fix the login redirect");
    // The footer names the branch the task creates.
    expect(screen.getByText("phasr/fix-the-login-redirect")).toBeInTheDocument();
    // Once edited, the name is the user's.
    fireEvent.change(name, { target: { value: "login fix" } });
    fireEvent.change(prompt, { target: { value: "Something else entirely" } });
    expect(name).toHaveValue("login fix");
    expect(screen.getByText("phasr/login-fix")).toBeInTheDocument();
  });

  it("seeds the base-branch chip from the repository's default branch", async () => {
    getRepository.mockResolvedValue(makeRepository({ defaultBranch: "trunk" }));
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    expect(await screen.findByRole("button", { name: "Base branch: trunk" })).toHaveTextContent("trunk");
  });

  it("prefers the repository's \"Default base branch\" rule and sends it", async () => {
    getRepositoryConfig.mockResolvedValue({ repositoryId: "repo-1", defaultBaseBranch: "develop" });
    startTask.mockResolvedValue({
      taskId: "task-1",
      workspace: makeWorkspace(),
    } satisfies StartedTask);
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    expect(await screen.findByRole("button", { name: "Base branch: develop" })).toBeInTheDocument();
    await agentReady();
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "fix it" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({ baseBranch: "develop" });
  });

  it("calls start_task with the form values and fires onCreated", async () => {
    const created: StartedTask = {
      taskId: "task-1",
      workspace: makeWorkspace({ name: "fix login bug", prompt: "make it work" }),
    };
    startTask.mockResolvedValue(created);
    const onCreated = vi.fn();
    renderWithClient(<NewTaskForm repositoryId="repo-1" onCreated={onCreated} />);
    await agentReady();

    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "fix login bug" },
    });
    fireEvent.change(screen.getByPlaceholderText(/What should the agent do/), {
      target: { value: "make it work" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toEqual({
      repositoryId: "repo-1",
      agent: "claude",
      name: "fix login bug",
      prompt: "make it work",
      baseBranch: "main",
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created.workspace));
    // No run command picked: nothing else starts.
    expect(startRunCommandForTask).not.toHaveBeenCalled();
  });

  it("⌘↵ from any field submits the form", async () => {
    startTask.mockResolvedValue({ taskId: "task-1", workspace: makeWorkspace() });
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();

    const nameInput = screen.getByLabelText("Task name");
    fireEvent.change(nameInput, { target: { value: "fix bug" } });
    fireEvent.keyDown(nameInput, { key: "Enter", metaKey: true });

    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
  });

  it("⌘↵ does nothing while the form is incomplete", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();

    fireEvent.keyDown(screen.getByLabelText("Task name"), { key: "Enter", metaKey: true });

    expect(startTask).not.toHaveBeenCalled();
  });

  it("⌘⇧↵ saves a draft instead of starting", async () => {
    createTaskDraft.mockResolvedValue(makeWorkspace({ status: "draft" as Workspace["status"] }));
    const onCreated = vi.fn();
    renderWithClient(<NewTaskForm repositoryId="repo-1" onCreated={onCreated} />);
    await agentReady();
    const prompt = screen.getByLabelText("Prompt");
    fireEvent.change(prompt, { target: { value: "Draft this one" } });
    fireEvent.keyDown(prompt, { key: "Enter", metaKey: true, shiftKey: true });

    await waitFor(() => expect(createTaskDraft).toHaveBeenCalledTimes(1));
    expect(createTaskDraft.mock.calls[0]?.[0]).toMatchObject({
      repositoryId: "repo-1",
      name: "draft this one",
      agent: "claude",
      prompt: "Draft this one",
      baseBranch: "main",
      queue: false,
    });
    expect(startTask).not.toHaveBeenCalled();
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it("Save as draft also sits behind the Start task caret", async () => {
    createTaskDraft.mockResolvedValue(makeWorkspace());
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "later" } });
    openMenu(/More start options/);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Save as draft/ }));
    await waitFor(() => expect(createTaskDraft).toHaveBeenCalledTimes(1));
    expect(startTask).not.toHaveBeenCalled();
  });

  it("surfaces backend errors inline without throwing", async () => {
    startTask.mockRejectedValue("repository has no local path");
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();

    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "broken task" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));

    await waitFor(() => expect(screen.getByText(/repository has no local path/)).toBeInTheDocument());
  });

  it("the agent chip opens a radiogroup; the pick is sent; missing agents offer their install hint", async () => {
    listAgents.mockResolvedValue([
      makeAgent({ agent: "claude", label: "Claude", isDefault: true }),
      makeAgent({ agent: "codex", label: "Codex", command: "codex", isDefault: false }),
      makeAgent({ agent: "opencode", label: "OpenCode", command: "opencode", isDefault: false }),
    ]);
    detectAgents.mockResolvedValue([
      detection("claude", { version: "2.1.0" }),
      detection("codex", { version: "0.165.0" }),
      detection("opencode", { status: "missing", path: null, installHint: "brew install opencode" }),
    ]);
    startTask.mockResolvedValue({ taskId: "task-1", workspace: makeWorkspace() });
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();
    await waitFor(() => expect(detectAgents).toHaveBeenCalled());

    openMenu(/^Agent: Claude/);
    const group = await screen.findByRole("radiogroup", { name: "Agent" });
    expect(group.id).toBe("new-task-agent");
    const radios = within(group).getAllByRole("menuitemradio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["Claude", "Codex"]);
    expect(within(group).getByRole("menuitemradio", { name: "Claude" })).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByText("0.165.0")).toBeInTheDocument();

    // Not installed: muted, outside the radiogroup, reveals how to install.
    const missing = screen.getByRole("menuitem", { name: "OpenCode: not installed" });
    expect(missing).toHaveTextContent("Install…");
    fireEvent.click(missing);
    expect(await screen.findByText("brew install opencode")).toBeInTheDocument();

    fireEvent.click(within(group).getByRole("menuitemradio", { name: "Codex" }));
    expect(await screen.findByRole("button", { name: "Agent: Codex" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "with codex" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({ agent: "codex" });
  });

  it("the notify switch lives in the permissions popover; off is sent", async () => {
    startTask.mockResolvedValue({ taskId: "task-1", workspace: makeWorkspace() });
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();

    openMenu(/^Permissions: Ask for shell/);
    const notify = await screen.findByRole("menuitemcheckbox", { name: /Notify me when it needs you/ });
    expect(notify).toHaveAttribute("aria-checked", "true");
    fireEvent.click(notify);
    expect(notify).toHaveAttribute("aria-checked", "false");
    // A setting, not a pick: the popover stays open.
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(notify, { key: "Escape" });

    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "quiet" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({ notifyOnAttention: false });
  });

  it("hides the Run chip when the repository has no run commands", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();
    await waitFor(() => expect(listRunCommands).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /^Run command:/ })).not.toBeInTheDocument();
  });

  it("hands the picked run command to start_task; untrusted ones are disabled", async () => {
    listRunCommands.mockResolvedValue([
      makeRunCommand(),
      makeRunCommand({ id: "rc-synced", name: "seed", command: "make seed" }),
    ]);
    listUntrustedRunCommands.mockResolvedValue(["rc-synced"]);
    startTask.mockResolvedValue({ taskId: "task-9", workspace: makeWorkspace({ id: "task-9" }) });
    const onCreated = vi.fn();
    renderWithClient(<NewTaskForm repositoryId="repo-1" onCreated={onCreated} />);
    await agentReady();

    openMenu(/^Run command: None/);
    const synced = await screen.findByRole("menuitemradio", { name: /seed/ });
    expect(synced).toHaveAttribute("data-disabled");
    expect(synced).toHaveTextContent("Allow on this Mac first");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /dev/ }));
    expect(await screen.findByRole("button", { name: "Run command: dev" })).toBeInTheDocument();
    // The plan lists it too.
    expect(screen.getByText("pnpm dev")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "with dev" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    // The backend starts it once the task's worktree exists (after
    // start_task has returned); the form never calls it itself.
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({ runCommandId: "rc-dev" });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(startRunCommandForTask).not.toHaveBeenCalled();
  });

  it("the task opens while it is still being set up", async () => {
    listRunCommands.mockResolvedValue([makeRunCommand()]);
    // What start_task returns now: the row, before its worktree exists.
    const pending = makeWorkspace({ id: "task-1", status: "pending", branch: null, worktreePath: null });
    startTask.mockResolvedValue({ taskId: "task-1", workspace: pending });
    const onCreated = vi.fn();
    renderWithClient(<NewTaskForm repositoryId="repo-1" onCreated={onCreated} />);
    await agentReady();
    openMenu(/^Run command: None/);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /dev/ }));
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "t" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(pending));
    expect(startRunCommandForTask).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts without a run command when none is picked", async () => {
    listRunCommands.mockResolvedValue([makeRunCommand()]);
    startTask.mockResolvedValue({ taskId: "task-1", workspace: makeWorkspace() });
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();
    fireEvent.change(screen.getByLabelText("Task name"), { target: { value: "t" } });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).not.toHaveProperty("runCommandId");
  });

  it("opens the branch list from the chip and commits a clicked branch", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await openBranchPicker();

    fireEvent.click(await screen.findByText("develop"));

    // Committing closes the popover; the chip shows the pick.
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Base branch: develop" })).toBeInTheDocument();
  });

  it("collapses phasr/* task branches behind a count until expanded", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await openBranchPicker();
    await screen.findByText("develop");
    expect(screen.queryByText("phasr/old-task-abc1234")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Phasr task branches"));
    expect(screen.getByText("phasr/old-task-abc1234")).toBeInTheDocument();
  });

  it("offers an unmatched query as a custom ref; Enter keeps it without submitting", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();
    const baseInput = await openBranchPicker();

    fireEvent.change(baseInput, { target: { value: "v1.2.0" } });
    await screen.findByText(/as a custom ref/);

    fireEvent.keyDown(baseInput, { key: "Enter" });
    expect(startTask).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Base branch: v1.2.0" })).toBeInTheDocument();
  });

  it("⌘↵ with the list open commits the highlighted branch instead of submitting", async () => {
    startTask.mockResolvedValue({ taskId: "task-1", workspace: makeWorkspace() });
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    await agentReady();
    fireEvent.change(screen.getByLabelText("Task name"), {
      target: { value: "fix bug" },
    });

    const baseInput = await openBranchPicker();
    await screen.findByText("develop");
    // Cursor parks on "main" (current value); ↓ moves it to "develop".
    fireEvent.keyDown(baseInput, { key: "ArrowDown" });
    fireEvent.keyDown(baseInput, { key: "Enter", metaKey: true });

    // The commit must NOT double as a form submit — that would fire
    // start_task with the value from before the commit flushed.
    expect(startTask).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    const chip = screen.getByRole("button", { name: "Base branch: develop" });

    // With the list closed, ⌘↵ submits — now carrying the committed ref.
    fireEvent.keyDown(chip, { key: "Enter", metaKey: true });
    await waitFor(() => expect(startTask).toHaveBeenCalledTimes(1));
    expect(startTask.mock.calls[0]?.[0]).toMatchObject({ baseBranch: "develop" });
  });

  it("shows the branch-list error state and keeps the field typable", async () => {
    listLocalBranches.mockRejectedValue("git failed");
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const baseInput = await openBranchPicker();

    await screen.findByText(/Type a branch name instead/);

    fireEvent.change(baseInput, { target: { value: "origin/main" } });
    expect(baseInput).toHaveValue("origin/main");
  });

  it("lets the base-branch field be cleared without re-seeding", async () => {
    renderWithClient(<NewTaskForm repositoryId="repo-1" />);
    const baseInput = await openBranchPicker();

    fireEvent.change(baseInput, { target: { value: "" } });
    await waitFor(() => expect(baseInput).toHaveValue(""));
  });
});
