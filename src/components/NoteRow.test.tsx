import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
  { alive = true }: { alive?: boolean } = {},
  onSave = vi.fn().mockResolvedValue(undefined),
  onDelete = vi.fn(),
) {
  render(
    <ul>
      <NoteRow
        note={note}
        originWorkspaceAlive={alive}
        onSave={onSave}
        onDelete={onDelete}
      />
    </ul>,
  );
  return { onSave, onDelete };
}

describe("NoteRow", () => {
  it("renders body, provenance label, and workspace name", () => {
    renderRow(makeNote());
    expect(
      screen.getByText(/Seed script needs DATABASE_URL/),
    ).toBeInTheDocument();
    expect(screen.getByText("Terminal 2")).toBeInTheDocument();
    expect(screen.getByText("fix-auth")).toBeInTheDocument();
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();
  });

  it("shows the Removed chip from the snapshot when the workspace is gone", () => {
    renderRow(makeNote(), { alive: false });
    // The snapshot still renders — that's the whole point.
    expect(screen.getByText("fix-auth")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
  });

  it("shows the edited badge only when updatedAt moved past createdAt", () => {
    renderRow(makeNote({ updatedAt: "2026-08-01T11:00:00Z" }));
    expect(screen.getByText(/· edited/)).toBeInTheDocument();
  });

  it("tolerates sub-second insert jitter without claiming edited", () => {
    renderRow(makeNote({ updatedAt: "2026-08-01T10:00:00.500Z" }));
    expect(screen.queryByText(/· edited/)).not.toBeInTheDocument();
  });

  it("saves an edit with the loaded updatedAt as the concurrency guard", async () => {
    const { onSave } = renderRow(makeNote());
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    const field = screen.getByDisplayValue(/Seed script/);
    fireEvent.change(field, { target: { value: "updated body" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    await vi.waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        "updated body",
        "2026-08-01T10:00:00Z",
      ),
    );
  });

  it("Escape cancels the edit without saving", () => {
    const { onSave } = renderRow(makeNote());
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    const field = screen.getByDisplayValue(/Seed script/);
    fireEvent.change(field, { target: { value: "discarded" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/Seed script needs DATABASE_URL/)).toBeInTheDocument();
  });

  it("keeps the text and shows a retry strip when save fails", async () => {
    const onSave = vi.fn().mockRejectedValue("network gone");
    renderRow(makeNote(), {}, onSave);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    const field = screen.getByDisplayValue(/Seed script/);
    fireEvent.change(field, { target: { value: "precious edit" } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/network gone/);
    expect(screen.getByDisplayValue("precious edit")).toBeInTheDocument();
  });

  it("delete action routes through the confirm callback", () => {
    const { onDelete } = renderRow(makeNote());
    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
