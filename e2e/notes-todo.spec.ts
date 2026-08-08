import { test, expect, type Page } from "@playwright/test";
import { bootApp, makeFixtures, calls } from "./harness";

const OUT =
  "/private/tmp/claude-501/-Users-rishabh-code-phasr/48f586d1-376e-40d2-a464-744fddb2c6c2/scratchpad";

async function openNotes(page: Page, fixtures = makeFixtures()) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootApp(page, fixtures);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-theme", "dark"),
  );
  await page.getByRole("button", { name: "Repository notes" }).click();
  await expect(
    page.getByRole("button", { name: "New note" }).first(),
  ).toBeVisible();
  await page.waitForTimeout(350);
}

test("checking a note fires set_note_done and does NOT move the row", async ({
  page,
}) => {
  await openNotes(page);
  const rows = page.getByRole("listitem");
  const firstText = (await rows.nth(0).innerText()).slice(0, 30);

  const box = rows.nth(0).getByRole("checkbox");
  await expect(box).toHaveAttribute("aria-checked", "false");
  await box.click();

  await expect(box).toHaveAttribute("aria-checked", "true");
  const args = (await calls(page)).filter((c) => c.cmd === "set_note_done");
  expect(args).toHaveLength(1);
  expect(args[0]!.args).toMatchObject({ done: true });

  // The anti-yank contract: still row 0, still the same note, while the
  // pointer is inside the panel.
  expect((await rows.nth(0).innerText()).slice(0, 30)).toBe(firstText);
  await page.screenshot({ path: `${OUT}/todo-checked.png` });
});

test("the row settles into Done WITHOUT the pointer leaving", async ({
  page,
}) => {
  await openNotes(page);
  const rows = page.getByRole("listitem");
  await rows.nth(0).getByRole("checkbox").click();

  // Regression: settle used to wait for the pointer to leave the panel.
  // After clicking a checkbox the pointer is by definition still in the
  // panel, so a checked note could sit in the open list indefinitely and
  // the feature read as "it doesn't update". Pointer stays put here.
  await page.waitForTimeout(1000);

  const doneToggle = page.getByRole("button", { name: /Done/ });
  await expect(doneToggle).toBeVisible();
  await doneToggle.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/todo-done-open.png` });
});

test("tab count shows open notes only", async ({ page }) => {
  await openNotes(page);
  const tab = page.getByRole("button", { name: /^Notes/ });
  await expect(tab).toContainText("2");
  await page.getByRole("listitem").nth(0).getByRole("checkbox").click();
  await expect(tab).toContainText("1");
});
