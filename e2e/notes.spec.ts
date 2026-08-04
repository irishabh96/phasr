/**
 * CRITIQUE-MODE e2e: REPOSITORY NOTES.
 *
 * Drives the real app via the mocked-IPC harness. Covers the headline
 * requirement — a note is repository-scoped and visible from every
 * surface — plus create-with-provenance, edit/cancel, delete-confirm,
 * and the empty state. The soft-delete-on-repo-removal behavior is
 * Rust-tested ONLY (the mocked harness cannot see SQL).
 */
import { test, expect, type Page } from "@playwright/test";
import { bootApp, makeFixtures, calls, waitForCall } from "./harness";

const BENIGN =
  /__TAURI|invoke|clerk|Clerk|sentry|Sentry|supabase|favicon|sourcemap|Outdated Optimize Dep|net::|Failed to load resource|permission|ResizeObserver|homeDir|plugin:/i;

function realErrors(errors: string[]) {
  return errors.filter((e) => !BENIGN.test(e));
}

async function boot(page: Page, fixtures = makeFixtures()) {
  const res = await bootApp(page, fixtures);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  return res;
}

async function openNotesTab(page: Page) {
  await page.getByRole("button", { name: "Repository notes" }).click();
  await expect(
    page.getByPlaceholder("Write a note…"),
  ).toBeVisible();
}

async function argsFor(page: Page, cmd: string) {
  const all = await calls(page);
  return all.filter((c) => c.cmd === cmd).map((c) => c.args);
}

test.describe("Notes panel", () => {
  test("notes tab lists repository notes with provenance; dead workspace shows Removed", async ({
    page,
  }) => {
    const { errors } = await boot(page);
    await openNotesTab(page);

    await waitForCall(page, "list_notes_for_repository");
    const listArgs = await argsFor(page, "list_notes_for_repository");
    expect(listArgs.at(-1)).toMatchObject({ repositoryId: "repo-1" });

    // Fixture note bodies + provenance render.
    await expect(page.getByText(/Seed script needs DATABASE_URL/)).toBeVisible();
    await expect(page.getByText("Terminal 2")).toBeVisible();
    // note-2's origin workspace (ws-gone) doesn't exist → snapshot + chip.
    await expect(page.getByText("checkout-flow")).toBeVisible();
    await expect(page.getByText("Removed")).toBeVisible();

    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("creating a note fires create_note with body and workspace provenance", async ({
    page,
  }) => {
    await boot(page);
    await openNotesTab(page);

    const composer = page.getByPlaceholder("Write a note…");
    await composer.fill("pin the vite config in the prompt");
    await composer.press(
      process.platform === "darwin" ? "Meta+Enter" : "Control+Enter",
    );

    await waitForCall(page, "create_note");
    const created = await argsFor(page, "create_note");
    expect(created.at(-1)).toMatchObject({
      input: {
        repositoryId: "repo-1",
        body: "pin the vite config in the prompt",
        originKind: "workspace",
        originWorkspaceId: "ws-agent",
      },
    });
  });

  test("editing updates via update_note with the concurrency guard; cancel never calls it", async ({
    page,
  }) => {
    await boot(page);
    await openNotesTab(page);
    await expect(page.getByText(/Codex keeps rewriting/)).toBeVisible();

    // Positional, not text-filtered: editing replaces the body text, so
    // a hasText filter would stop matching its own row mid-test.
    const codexRow = page.getByRole("listitem").nth(1);
    await expect(codexRow).toContainText("Codex keeps rewriting");
    await codexRow.getByRole("button", { name: "Edit note" }).click();
    const editor = codexRow.getByRole("textbox");
    await expect(editor).toHaveValue(/Codex keeps rewriting/);
    await editor.fill("should be discarded");
    await editor.press("Escape");
    expect(await argsFor(page, "update_note")).toHaveLength(0);

    // Save path.
    await codexRow.getByRole("button", { name: "Edit note" }).click();
    const editor2 = codexRow.getByRole("textbox");
    await editor2.fill("updated body");
    await codexRow.getByRole("button", { name: "Save" }).click();
    await waitForCall(page, "update_note");
    const updated = await argsFor(page, "update_note");
    expect(updated.at(-1)).toMatchObject({
      id: "note-2",
      input: { body: "updated body" },
    });
    expect(
      (updated.at(-1) as { input: { expectedUpdatedAt?: string } }).input
        .expectedUpdatedAt,
    ).toBeTruthy();
  });

  test("delete confirms before firing delete_note, quoting the note", async ({
    page,
  }) => {
    await boot(page);
    await openNotesTab(page);
    await expect(page.getByText(/Codex keeps rewriting/)).toBeVisible();

    const codexRow = page
      .getByRole("listitem")
      .filter({ hasText: "Codex keeps rewriting" });
    await codexRow.getByRole("button", { name: "Delete note" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Codex keeps rewriting/)).toBeVisible();
    // Nothing fired yet — confirm is required.
    expect(await argsFor(page, "delete_note")).toHaveLength(0);

    await dialog.getByRole("button", { name: "Delete" }).click();
    await waitForCall(page, "delete_note");
    expect((await argsFor(page, "delete_note")).at(-1)).toMatchObject({
      id: "note-2",
    });
  });

  test("empty repository shows the empty state, not a spinner or error", async ({
    page,
  }) => {
    const fixtures = makeFixtures();
    (fixtures as { notes: unknown[] }).notes = [];
    const { errors } = await boot(page, fixtures);
    await openNotesTab(page);

    await expect(
      page.getByText("No notes for this repository"),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Write a note" }),
    ).toBeVisible();
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });
});
