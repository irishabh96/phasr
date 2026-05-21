import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskStatusPill } from "@/components/TaskStatusPill";

describe("TaskStatusPill", () => {
  it("renders the human label for each status", () => {
    const cases = [
      ["pending", "Pending"],
      ["running", "Running"],
      ["completed", "Completed"],
      ["failed", "Failed"],
      ["stopped", "Stopped"],
      ["archived", "Archived"],
    ] as const;
    for (const [status, label] of cases) {
      const { unmount } = render(<TaskStatusPill status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      // The whole pill exposes the status to assistive tech.
      expect(screen.getByLabelText(`Status: ${label}`)).toBeInTheDocument();
      unmount();
    }
  });
});
