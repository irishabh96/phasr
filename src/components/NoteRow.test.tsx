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
    doneAt: null,
    ...overrides,
  };
}

function renderRow(
  note: Note,
  {
    alive = true,
    presentation = "open" as "open" | "done",
    onToggleDone = vi.fn(),
  }: {
    alive?: boolean;
    presentation?: "open" | "done";
    onToggleDone?: (done: boolean) => void;
  } = {},
  onSave = vi.fn().mockResolvedValue(undefined),
  onDelete = vi.fn(),
) {
  render(
    <ul>
      <NoteRow
        note={note}
        originWorkspaceAlive={alive}
        presentation={presentation}
        onToggleDone={onToggleDone}
        focusable
        onFocusRow={() => {}}
        registerRef={() => {}}
        onSave={onSave}
        onDelete={onDelete}
      />
    </ul>,
  );
  return { onSave, onDelete, onToggleDone };
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
  it("renders body, workspace ref, and a timestamp — origin label is icon-only", () => {
    renderRow(makeNote());
    expect(
      screen.getByText(/Seed script needs DATABASE_URL/),
    ).toBeInTheDocument();
    // Provenance no longer costs a line: the ref and the absolute time
    // live in the origin glyph's tooltip + menu, not on the row.
    expect(screen.queryByText("fix-auth")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Note actions" }),
    ).toBeInTheDocument();
  });

  it("keeps origin and time in the row's accessible name (the SR path)", () => {
    // With the label off-screen, aria-label is the ONLY queryable home
    // for origin text — a future cleanup must not silently drop it.
    renderRow(makeNote());
    const label = screen.getByRole("article").getAttribute("aria-label") ?? "";
    expect(label).toContain("Terminal 2");
    expect(label).toContain("fix-auth");
    expect(label).toMatch(/\d{2}:\d{2}/);
  });

  it("names a removed workspace in the accessible name too", () => {
    renderRow(makeNote(), { alive: false });
    expect(screen.getByRole("article").getAttribute("aria-label")).toContain(
      "(workspace removed)",
    );
  });

  it("adds no extra tab stops — the roving list owns the tab order", () => {
    renderRow(makeNote(), { alive: false });
    const row = screen.getByRole("article");
    const stops = row.querySelectorAll('[tabindex="0"]');
    // Only the row itself is focusable; tooltips are pointer affordances.
    expect(stops.length).toBe(0);
    expect(row).toHaveAttribute("tabindex", "0");
  });

  it("names a removed origin workspace in the accessible name", () => {
    renderRow(makeNote(), { alive: false });
    expect(screen.getByRole("article").getAttribute("aria-label")).toContain(
      "(workspace removed)",
    );
  });

  it("shows the edited badge only when updatedAt moved past createdAt", () => {
    renderRow(makeNote({ updatedAt: "2026-08-01T11:00:00Z" }));
    expect(screen.getByText(/edited/)).toBeInTheDocument();
  });

  it("tolerates sub-second insert jitter without claiming edited", () => {
    renderRow(makeNote({ updatedAt: "2026-08-01T10:00:00.500Z" }));
    expect(screen.queryByText(/edited/)).not.toBeInTheDocument();
  });

  it("offers Show more for a long SINGLE-PARAGRAPH note (measured, not newline-counted)", () => {
    // Regression: "Show more" was gated on newline COUNT while the clamp
    // is visual, so a long note with no hard newlines got clipped by CSS
    // with no way to expand — the text was unreachable.
    fakeParagraphMetrics(200, 100);
    renderRow(makeNote({ body: "x".repeat(600) }));

    // The affordance is a chevron in the hover cluster now, not a
    // text button that cost the row a line.
    const expand = screen.getByRole("button", { name: "Expand note" });
    fireEvent.click(expand);
    expect(
      screen.getByRole("button", { name: "Collapse note" }),
    ).toBeInTheDocument();
  });

  it("does not offer Show more when the body fits", () => {
    fakeParagraphMetrics(40, 40);
    renderRow(makeNote({ body: "short" }));
    expect(
      screen.queryByRole("button", { name: "Expand note" }),
    ).not.toBeInTheDocument();
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

  it("→ expands an overflowing note and ← collapses it", () => {
    fakeParagraphMetrics(200, 100);
    renderRow(makeNote({ body: "x".repeat(600) }));
    const row = screen.getByRole("article");
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(
      screen.getByRole("button", { name: "Collapse note" }),
    ).toBeInTheDocument();
    fireEvent.keyDown(row, { key: "ArrowLeft" });
    expect(
      screen.getByRole("button", { name: "Expand note" }),
    ).toBeInTheDocument();
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

  it("the editor offers Delete — not just Cancel/Save", () => {
    // Reported gap: a note you opened to fix and then decided to bin
    // had no way out of the editor except cancelling first.
    const { onDelete } = renderRow(makeNote());
    fireEvent.keyDown(screen.getByRole("article"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledTimes(1);
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
  it("Space on a focused row toggles done", () => {
    const onToggleDone = vi.fn();
    renderRow(makeNote(), { onToggleDone });
    fireEvent.keyDown(screen.getByRole("article"), { key: " " });
    expect(onToggleDone).toHaveBeenCalledWith(true);
  });

  it("Space on a done note reopens it", () => {
    const onToggleDone = vi.fn();
    renderRow(makeNote({ doneAt: "2026-08-02T10:00:00Z" }), { onToggleDone });
    fireEvent.keyDown(screen.getByRole("article"), { key: " " });
    expect(onToggleDone).toHaveBeenCalledWith(false);
  });

  it("the checkbox reflects LIVE done state even while rendered as open", () => {
    // The anti-yank split: a just-checked note keeps its open position
    // (presentation) but must show as checked (live state) immediately.
    renderRow(makeNote({ doneAt: "2026-08-02T10:00:00Z" }), {
      presentation: "open",
    });
    expect(screen.getByRole("checkbox")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // …and still renders its full open-row body, not the collapsed one.
    expect(
      screen.getByText(/Seed script needs DATABASE_URL/),
    ).toBeInTheDocument();
  });

  it("a done-presentation row collapses to one truncated line", () => {
    renderRow(makeNote({ doneAt: new Date().toISOString() }), {
      presentation: "done",
    });
    const body = screen.getByText(/Seed script needs DATABASE_URL/);
    expect(body.className).toContain("truncate");
  });

  it("states done-ness in the accessible name", () => {
    renderRow(makeNote({ doneAt: "2026-08-02T10:00:00Z" }));
    expect(screen.getByRole("article").getAttribute("aria-label")).toMatch(
      /^Done,/,
    );
  });

  it("keeps the ⋯ trigger present but out of the tab order", () => {
    renderRow(makeNote());
    const trigger = screen.getByRole("button", { name: "Note actions" });
    expect(trigger).toHaveAttribute("tabindex", "-1");
  });
});
