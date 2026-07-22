import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoEntryChoice } from "@/components/RepoEntryChoice";
import { useUiStore } from "@/lib/store";
import type { Repository } from "@/lib/types";

const requestDecompose = vi.fn();
const openRepoInnerTerminalTab = vi.fn();

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

beforeEach(() => {
  requestDecompose.mockReset();
  openRepoInnerTerminalTab.mockReset();
  // Swap the two store actions the choice surface fires for spies so each
  // click can be asserted against the real wiring (zustand merges partials).
  useUiStore.setState({ requestDecompose, openRepoInnerTerminalTab });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("RepoEntryChoice", () => {
  it("renders the three onboarding options", () => {
    render(<RepoEntryChoice repo={makeRepository()} onNewTask={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "New task in phasr" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New epic in phasr" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open terminal in phasr" }),
    ).toBeInTheDocument();
  });

  it("marks the epic as the optional / richer path", () => {
    render(<RepoEntryChoice repo={makeRepository()} onNewTask={vi.fn()} />);
    expect(screen.getByText("Optional")).toBeInTheDocument();
  });

  it("fires onNewTask (single-agent task form) for New task", () => {
    const onNewTask = vi.fn();
    render(<RepoEntryChoice repo={makeRepository()} onNewTask={onNewTask} />);
    fireEvent.click(screen.getByRole("button", { name: "New task in phasr" }));
    expect(onNewTask).toHaveBeenCalledTimes(1);
    expect(requestDecompose).not.toHaveBeenCalled();
    expect(openRepoInnerTerminalTab).not.toHaveBeenCalled();
  });

  it("opens the decomposition (New epic) flow for the repo", () => {
    const onNewTask = vi.fn();
    render(<RepoEntryChoice repo={makeRepository()} onNewTask={onNewTask} />);
    fireEvent.click(screen.getByRole("button", { name: "New epic in phasr" }));
    expect(requestDecompose).toHaveBeenCalledTimes(1);
    expect(requestDecompose).toHaveBeenCalledWith("repo-1");
    expect(onNewTask).not.toHaveBeenCalled();
    expect(openRepoInnerTerminalTab).not.toHaveBeenCalled();
  });

  it("opens a plain terminal tab for the repo", () => {
    const onNewTask = vi.fn();
    render(<RepoEntryChoice repo={makeRepository()} onNewTask={onNewTask} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open terminal in phasr" }),
    );
    expect(openRepoInnerTerminalTab).toHaveBeenCalledTimes(1);
    expect(openRepoInnerTerminalTab).toHaveBeenCalledWith("repo-1");
    expect(onNewTask).not.toHaveBeenCalled();
    expect(requestDecompose).not.toHaveBeenCalled();
  });
});
