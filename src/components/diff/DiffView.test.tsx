import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, beforeEach } from "vitest";
import { RawDiffViewer } from "@/components/diff/RawDiffViewer";
import { SAMPLE_DIFFS } from "@/components/diff/sampleDiffs";

const SIMPLE_DIFF = SAMPLE_DIFFS.find((s) => s.id === "ts-modify")!;

describe("RawDiffViewer", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders an empty-state message for a blank diff", () => {
    render(<RawDiffViewer raw="" filePath="foo.ts" />);
    expect(screen.getByText("No changes.")).toBeInTheDocument();
  });

  it("renders added/removed line counts in the header", () => {
    render(<RawDiffViewer raw={SIMPLE_DIFF.raw} filePath={SIMPLE_DIFF.filePath} />);
    // Both +N and −N appear with mono styling.
    expect(screen.getByText(/^\+\d+$/)).toBeInTheDocument();
    expect(screen.getByText(/^−\d+$/)).toBeInTheDocument();
  });

  it("renders the file path in the header", () => {
    render(<RawDiffViewer raw={SIMPLE_DIFF.raw} filePath={SIMPLE_DIFF.filePath} />);
    expect(screen.getByText(SIMPLE_DIFF.filePath)).toBeInTheDocument();
  });

  it("shows a 'new' pill for a new file", () => {
    const sample = SAMPLE_DIFFS.find((s) => s.id === "rs-new")!;
    render(<RawDiffViewer raw={sample.raw} filePath={sample.filePath} />);
    expect(screen.getByText("new")).toBeInTheDocument();
  });

  it("shows a 'deleted' pill for a deleted file", () => {
    const sample = SAMPLE_DIFFS.find((s) => s.id === "py-delete")!;
    render(<RawDiffViewer raw={sample.raw} filePath={sample.filePath} />);
    expect(screen.getByText("deleted")).toBeInTheDocument();
  });

  it("shows a binary placeholder", () => {
    const sample = SAMPLE_DIFFS.find((s) => s.id === "binary")!;
    render(<RawDiffViewer raw={sample.raw} filePath={sample.filePath} />);
    expect(screen.getByText(/Binary file/)).toBeInTheDocument();
  });

  it("toggles view mode when ⌘\\ is pressed", () => {
    render(
      <RawDiffViewer
        raw={SIMPLE_DIFF.raw}
        filePath={SIMPLE_DIFF.filePath}
        initialMode="side-by-side"
      />,
    );
    const split = screen.getByRole("button", { name: /Split/ });
    const inline = screen.getByRole("button", { name: /Inline/ });
    expect(split).toHaveAttribute("aria-pressed", "true");
    expect(inline).toHaveAttribute("aria-pressed", "false");

    fireEvent.keyDown(window, { key: "\\", metaKey: true });

    expect(screen.getByRole("button", { name: /Split/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: /Inline/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("toggles view mode via the header buttons and persists to localStorage", () => {
    render(
      <RawDiffViewer
        raw={SIMPLE_DIFF.raw}
        filePath={SIMPLE_DIFF.filePath}
        initialMode="side-by-side"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Inline/ }));
    expect(window.localStorage.getItem("phasr.diff.viewMode")).toBe("inline");
  });

  it("offers a 'Show more' control for diffs that exceed the hunk cap", () => {
    const sample = SAMPLE_DIFFS.find((s) => s.id === "many-hunks")!;
    render(<RawDiffViewer raw={sample.raw} filePath={sample.filePath} />);
    expect(screen.getByRole("button", { name: /Show.*more hunk/ })).toBeInTheDocument();
  });
});
