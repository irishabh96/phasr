import { test, expect, type Page } from "@playwright/test";
import { bootApp, calls } from "./harness";

/**
 * The workflow context menu (Phase 3 of the completion program): the sidebar
 * epic node's right-click closes the product's last unmanageable surface —
 * a workflow can now be archived (cascade keeps branches) or deleted
 * (cascade removes refs too), each behind an honest confirm.
 */

async function boot(page: Page) {
  const res = await bootApp(page);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  return res;
}

const epicNode = (page: Page) =>
  page.getByRole("button", { name: /Workflow: Add a task-comments API/ });

async function firedCall(page: Page, cmd: string) {
  const all = await calls(page);
  return all.find((c) => c.cmd === cmd);
}

test.describe("Workflow context menu (sidebar)", () => {
  test("Archive workflow: confirm names the cascade, fires archive_epic", async ({
    page,
  }) => {
    await boot(page);
    await epicNode(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive workflow" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/Archive workflow/);
    // The copy is honest about what happens: worktrees go, branches stay.
    await expect(dialog).toContainText(/Branches are kept/);
    await dialog.getByRole("button", { name: "Archive workflow" }).click();

    await expect
      .poll(async () => {
        const c = await firedCall(page, "archive_epic");
        return c && (c.args as { parentId?: string }).parentId;
      })
      .toBe("epic-1");
  });

  test("Delete workflow: pre-flight check + a danger confirm that admits ref loss", async ({
    page,
  }) => {
    await boot(page);
    await epicNode(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete workflow" }).click();

    // The unpushed pre-flight ran against the parent.
    await expect
      .poll(async () => {
        const c = await firedCall(page, "check_workspace_delete");
        return c && (c.args as { id?: string }).id;
      })
      .toBe("epic-1");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(/Delete workflow/);
    await expect(dialog).toContainText(/branches/i);
    await dialog.getByRole("button", { name: "Delete workflow" }).click();

    await expect
      .poll(async () => {
        const c = await firedCall(page, "delete_workspace");
        return c && (c.args as { id?: string }).id;
      })
      .toBe("epic-1");
  });

  test("Rename… routes through the shared rename modal", async ({ page }) => {
    await boot(page);
    await epicNode(page).first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    // The shell-mounted RenameWorkspaceModal picks the request up.
    await expect(page.getByRole("dialog")).toContainText(/Rename/);
  });
});

test.describe("Workflow brief (E5)", () => {
  test("the board header's Brief opens the editable PRD/TRD and saves a section", async ({
    page,
  }) => {
    await boot(page);
    await page.goto("/repositories/repo-1/board/epic-1");
    await page.getByTestId("board-epic-brief").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Workflow brief");
    // Loaded from read_epic_brief — the fixture PRD renders for editing.
    const prd = dialog.getByRole("textbox", { name: "PRD content" });
    await expect(prd).toHaveValue("# Epic PRD");

    await prd.fill("# Epic PRD\n\nSharper scope.");
    await dialog.getByRole("button", { name: "Save" }).first().click();
    await expect
      .poll(async () => {
        const all = await calls(page);
        const c = all.find((x) => x.cmd === "write_epic_section");
        return c && (c.args as { section?: string }).section;
      })
      .toBe("prd");
    await expect(
      dialog.getByRole("button", { name: /Saved/ }),
    ).toBeVisible();
  });
});
