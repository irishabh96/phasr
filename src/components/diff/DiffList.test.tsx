import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, beforeEach, vi } from "vitest";
import { DiffList } from "@/components/diff/DiffList";
import { SAMPLE_DIFF_LIST } from "@/components/diff/sampleDiffs";

const FILES = SAMPLE_DIFF_LIST.map((f) => ({ path: f.path, raw: f.raw }));

describe("DiffList", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders one card per file", () => {
    render(<DiffList files={FILES} />);
    for (const f of FILES) {
      expect(screen.getByText(f.path)).toBeInTheDocument();
    }
  });

  it("shows an empty-state message when files is empty", () => {
    render(<DiffList files={[]} />);
    expect(screen.getByText("No changes.")).toBeInTheDocument();
  });

  it("collapses and expands a card via the chevron", () => {
    render(<DiffList files={FILES.slice(0, 1)} />);
    const firstPath = FILES[0]!.path;
    const collapseBtn = screen.getByRole("button", { name: "Collapse file" });
    expect(collapseBtn).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapseBtn);
    // After collapse the same control becomes "Expand file".
    const expandBtn = screen.getByRole("button", { name: "Expand file" });
    expect(expandBtn).toHaveAttribute("aria-expanded", "false");
    // The path is still visible (it's in the always-rendered header).
    expect(screen.getByText(firstPath)).toBeInTheDocument();
  });

  it("respects defaultExpanded=false (all cards collapsed)", () => {
    render(<DiffList files={FILES} defaultExpanded={false} />);
    const expandButtons = screen.getAllByRole("button", { name: /Expand file/ });
    expect(expandButtons.length).toBe(FILES.length);
  });

  it("respects defaultExpanded=N (only first N expanded)", () => {
    render(<DiffList files={FILES} defaultExpanded={2} />);
    expect(screen.getAllByRole("button", { name: "Collapse file" }).length).toBe(2);
    expect(screen.getAllByRole("button", { name: "Expand file" }).length).toBe(
      FILES.length - 2,
    );
  });

  it("shows action icons only when callbacks are provided", () => {
    const onDiscard = vi.fn();
    const { rerender } = render(<DiffList files={FILES} />);
    expect(screen.queryAllByLabelText("Discard changes").length).toBe(0);
    rerender(<DiffList files={FILES} onDiscard={onDiscard} />);
    expect(screen.getAllByLabelText("Discard changes").length).toBe(FILES.length);
  });

  it("opens the discard confirmation dialog and invokes onDiscard on confirm", () => {
    const onDiscard = vi.fn();
    render(<DiffList files={FILES.slice(0, 1)} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByLabelText("Discard changes"));
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledWith(FILES[0]!.path);
  });

  it("toggles split/inline mode globally when ⌘\\ is pressed", () => {
    render(<DiffList files={FILES.slice(0, 2)} />);
    // Initial state is side-by-side.
    expect(window.localStorage.getItem("phasr.diff.viewMode")).toBeNull();
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(window.localStorage.getItem("phasr.diff.viewMode")).toBe("inline");
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(window.localStorage.getItem("phasr.diff.viewMode")).toBe("side-by-side");
  });
});
