import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteRow } from "@/components/NoteRow";
import type { Note } from "@/lib/types";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-1",
    repositoryId: "repo-1",
    body: "Seed script needs DATABASE_URL exported first.",
    originKind: "terminal",
    originWorkspaceId: "ws-1",
    originWorkspaceName: "fix-auth",
    originTerminalId: "session:abc",
    originLabel: "Terminal 2",
    createdAt: "2026-08-01T10:00:00Z",
    updatedAt: "2026-08-01T10:00:00Z",
    ...overrides,
  };
}

function renderRow(
  note: Note,
  {
    alive = true,
    showDayStamp = false,
  }: { alive?: boolean; showDayStamp?: boolean } = {},
  onSave = vi.fn().mockResolvedValue(undefined),
  onDelete = vi.fn(),
) {
  render(
    <ul>
      <NoteRow
        note={note}
        originWorkspaceAlive={alive}
        showDayStamp={showDayStamp}
        focusable
        onFocusRow={() => {}}
        registerRef={() => {}}
        onSave={onSave}
        onDelete={onDelete}
      />
    </ul>,
  );
  return { onSave, onDelete };
}

/**
 * jsdom reports 0 for every layout metric, so a clamped paragraph is
 * indistinguishable from a short one. Force the two values the overflow
 * check reads; restore on teardown.
 */
function fakeParagraphMetrics(scrollHeight: number, clientHeight: number) {
  const proto = HTMLParagraphElement.prototype as unknown as object;
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
}

afterEach(() => {
  const proto = HTMLParagraphElement.prototype as unknown as object;
  delete (proto as Record<string, unknown>).scrollHeight;
  delete (proto as Record<string, unknown>).clientHeight;
});


describe("NoteRow", () => {
  it("renders body, provenance label, and workspace name", () => {
    renderRow(makeNote());
    expect(
      screen.getByText(/Seed script needs DATABASE_URL/),
    ).toBeInTheDocument();
    expect(screen.getByText("Terminal 2")).toBeInTheDocument();
    expect(screen.getByText("fix-auth")).toBeInTheDocument();
  });

  it("marks a dead origin workspace with strikethrough + an sr-only reason", () => {
    renderRow(makeNote(), { alive: false });
    const ref = screen.getByText(/fix-auth/);
    expect(ref.className).toContain("line-through");
    expect(screen.getByText("(workspace removed)")).toBeInTheDocument();
    // Reachable by keyboard — the explanation must not be mouse-only.
    expect(ref.closest("[tabindex='0']")).not.toBeNull();
  });

  it("shows the edited badge only when updatedAt moved past createdAt", () => {
    renderRow(makeNote({ updatedAt: "2026-08-01T11:00:00Z" }));
    expect(screen.getByText("edited")).toBeInTheDocument();
  });

  it("tolerates sub-second insert jitter without claiming edited", () => {
    renderRow(makeNote({ updatedAt: "2026-08-01T10:00:00.500Z" }));
    expect(screen.queryByText("edited")).not.toBeInTheDocument();
  });

  it("offers Show more for a long SINGLE-PARAGRAPH note (measured, not newline-counted)", () => {
    // Regression: "Show more" was gated on newline COUNT while the clamp
    // is visual, so a long note with no hard newlines got clipped by CSS
    // with no way to expand — the text was unreachable.
    fakeParagraphMetrics(200, 100);
    renderRow(makeNote({ body: "x".repeat(600) }));

    expect(screen.getByText("Show more")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Show more"));
    expect(screen.getByText("Show less")).toBeInTheDocument();
  });

  it("does not offer Show more when the body fits", () => {
    fakeParagraphMetrics(40, 40);
    renderRow(makeNote({ body: "short" }));
    expect(screen.queryByText("Show more")).not.toBeInTheDocument();
  });

  it("splits a multi-line note into a title line and a body", () => {
    renderRow(
      makeNote({ body: "Migration order matters\nRun db:reset first." }),
    );
    const title = screen.getByText("Migration order matters");
    expect(title.className).toContain("font-medium");
    expect(screen.getByText("Run db:reset first.")).toBeInTheDocument();
  });

  it("treats a long first line as prose, not a title", () => {
    const body = `${"y".repeat(200)}\ntail`;
    renderRow(makeNote({ body }));
    expect(screen.queryByText("tail")).not.toBeInTheDocument(); // one block
  });

  it("hides provenance on an optimistic row until the write lands", () => {
    renderRow(makeNote({ id: "optimistic-1" }));
    expect(screen.queryByText("Terminal 2")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Note actions" }),
    ).not.toBeInTheDocument();
  });

  it("Enter on a focused row starts editing; Escape cancels", () => {
    const { onSave } = renderRow(makeNote());
    const row = screen.getByRole("article");
    fireEvent.keyDown(row, { key: "Enter" });
    const editor = screen.getByLabelText("Edit note");
    fireEvent.change(editor, { target: { value: "discarded" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(onSave).not.toHaveBeenCalled();
    expect(
      screen.getByText(/Seed script needs DATABASE_URL/),
    ).toBeInTheDocument();
  });

  it("Backspace on a focused row asks to delete", () => {
    const { onDelete } = renderRow(makeNote());
    fireEvent.keyDown(screen.getByRole("article"), { key: "Backspace" });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("saves an edit with the loaded updatedAt as the concurrency guard", async () => {
    const { onSave } = renderRow(makeNote());
    fireEvent.keyDown(screen.getByRole("article"), { key: "Enter" });
    const editor = screen.getByLabelText("Edit note");
    fireEvent.change(editor, { target: { value: "updated body" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        "updated body",
        "2026-08-01T10:00:00Z",
      ),
    );
  });

  it("keeps the text and shows a retry strip when save fails", async () => {
    const onSave = vi.fn().mockRejectedValue("network gone");
    renderRow(makeNote(), {}, onSave);
    fireEvent.keyDown(screen.getByRole("article"), { key: "Enter" });
    const editor = screen.getByLabelText("Edit note");
    fireEvent.change(editor, { target: { value: "precious edit" } });
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/network gone/);
    expect(screen.getByDisplayValue("precious edit")).toBeInTheDocument();
  });

  // The ⋯ menu's contents need a real pointer environment (Radix +
  // jsdom has no PointerEvent) — asserted in e2e/notes.spec.ts instead.
  it("keeps the ⋯ trigger present but out of the tab order", () => {
    renderRow(makeNote());
    const trigger = screen.getByRole("button", { name: "Note actions" });
    expect(trigger).toHaveAttribute("tabindex", "-1");
  });
});
