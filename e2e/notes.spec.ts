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

/**
 * Open the rail on Notes. The composer is summoned, not pinned, so the
 * settled state is the Notes tab being selected.
 * ("New note" deliberately names two affordances — the header icon and
 * the canvas row — so tests scope rather than match it globally.)
 */
async function openNotesTab(page: Page) {
  await page.getByRole("button", { name: "Repository notes" }).click();
  await expect(
    page.getByRole("button", { name: "New note" }).first(),
  ).toBeVisible();
}

/** Summon the composer (⌘⇧N path). */
async function openComposer(page: Page) {
  await page.keyboard.press("Meta+Shift+N");
  await expect(page.getByPlaceholder("Write a note…")).toBeVisible();
}

/** Open a row's ⋯ menu and pick an item. */
async function rowMenu(page: Page, index: number, item: string) {
  const row = page.getByRole("listitem").nth(index);
  await row.hover();
  await row.getByRole("button", { name: "Note actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
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
    // Origin is icon-only now; the label lives in its tooltip.
    await expect(page.getByText("Terminal 2")).toHaveCount(0);
    // Provenance costs no vertical space now: the workspace ref lives in
    // the origin glyph's tooltip and menu header, not on the row. The
    // removed-workspace fact stays in the row's accessible name.
    await expect(page.getByText("checkout-flow")).toHaveCount(0);
    const codexRow = page.getByRole("listitem").nth(1);
    await expect(codexRow.getByRole("article")).toHaveAttribute(
      "aria-label",
      /\(workspace removed\)/,
    );
    // …and is shown, struck through, once the menu is open.
    await rowMenu(page, 1, "Edit");
    await page.keyboard.press("Escape");

    // The resting panel is a reading surface: no pinned composer.
    await expect(page.getByPlaceholder("Write a note…")).toHaveCount(0);

    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("creating a note fires create_note with body and workspace provenance", async ({
    page,
  }) => {
    await boot(page);
    await openNotesTab(page);
    await openComposer(page);

    const composer = page.getByPlaceholder("Write a note…");
    await composer.fill("pin the vite config in the prompt");
    await composer.press("Meta+Enter");

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

    // Cancel path — via the ⋯ menu.
    await rowMenu(page, 1, "Edit");
    const editor = codexRow.getByRole("textbox");
    await expect(editor).toHaveValue(/Codex keeps rewriting/);
    await editor.fill("should be discarded");
    await editor.press("Escape");
    expect(await argsFor(page, "update_note")).toHaveLength(0);

    // Save path — via the keyboard (Enter on a focused row).
    await codexRow.click();
    await codexRow.press("Enter");
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

    await rowMenu(page, 1, "Delete…");

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

    await expect(page.getByText("No notes yet")).toBeVisible();
    // The composer IS the empty state's affordance — present, but not
    // stealing focus, and there is no second dead CTA beside it.
    await expect(page.getByPlaceholder("Write a note…")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Write a note" }),
    ).toHaveCount(0);
    expect(realErrors(errors), realErrors(errors).join("\n")).toHaveLength(0);
  });

  test("a long single-paragraph note can be expanded (regression)", async ({
    page,
  }) => {
    const fixtures = makeFixtures();
    const notes = (fixtures as { notes: Record<string, unknown>[] }).notes;
    notes[0]!.body =
      "The seed script silently no-ops when DATABASE_URL points at the pooled connection string, which is what .env.local has by default, so you get an empty database and no error at all. Use the direct connection string instead, and remember the pooler port differs by one digit which is very easy to miss when copying.";
    await boot(page, fixtures);
    await openNotesTab(page);

    // Newline-free but visually clamped: the old newline-count gate hid
    // "Show more" here and the rest of the note was unreachable.
    const expand = page.getByRole("button", { name: "Expand note" }).first();
    await expect(expand).toBeVisible();
    await expand.click();
    await expect(
      page.getByRole("button", { name: "Collapse note" }).first(),
    ).toBeVisible();
  });

  test("keyboard: ↓ moves between notes and ↵ opens the editor", async ({
    page,
  }) => {
    await boot(page);
    await openNotesTab(page);
    const first = page.getByRole("listitem").nth(0);
    await first.click();
    await first.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("listitem").nth(1).getByRole("textbox"),
    ).toBeVisible();
  });
});
