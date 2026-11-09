import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TerminalStatus } from "@/components/TerminalStatus";

describe("TerminalStatus", () => {
  it("shows a calm, action-free state for a draft that wasn't started here", () => {
    render(<TerminalStatus state="not-started" onRetry={() => {}} />);
    expect(screen.getByText("Not started on this Mac")).toBeInTheDocument();
    // Informational, not an alert — and no Retry, which can't help.
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByText("Couldn't start")).not.toBeInTheDocument();
  });

  it("still offers Retry for a genuine start failure", () => {
    render(<TerminalStatus state="failed" error="boom" onRetry={() => {}} />);
    expect(screen.getByText("Couldn't start")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
