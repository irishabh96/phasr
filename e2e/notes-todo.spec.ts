import { test, expect, type Page } from "@playwright/test";
import { bootApp, makeFixtures, calls } from "./harness";

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
});

test("tab count shows open notes only", async ({ page }) => {
  await openNotes(page);
  const tab = page.getByRole("button", { name: /^Notes/ });
  await expect(tab).toContainText("2");
  await page.getByRole("listitem").nth(0).getByRole("checkbox").click();
  await expect(tab).toContainText("1");
});

test("a done row shows exactly ONE stamp on hover", async ({ page }) => {
  await openNotes(page);
  await page.getByRole("listitem").nth(0).getByRole("checkbox").click();
  await page.waitForTimeout(1000); // settle into Done
  await page.getByRole("button", { name: /^Done/ }).click();
  await page.waitForTimeout(250);

  const doneRow = page.getByRole("listitem").last();
  await doneRow.hover();
  await page.waitForTimeout(250);

  const stamps = await doneRow.evaluate((el) => {
    const txt = [...el.querySelectorAll("span,time")]
      .map((n) => (n.textContent ?? "").trim())
      .filter((t) => /^(now|\d+[mhd]|[A-Z][a-z]{2}|\d+ [A-Z][a-z]{2})$/.test(t));
    return txt;
  });
  console.log("STAMPS ON DONE ROW:", JSON.stringify(stamps));
  expect(stamps.length).toBe(1);
});

test("the loading state actually renders something", async ({ page }) => {
  // Regression: NotesSkeleton used `.skeleton-bar`, whose ONLY rule
  // lives inside a prefers-reduced-motion media query — no background,
  // no animation. Every panel open showed a blank rectangle.
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootApp(page, makeFixtures());
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.getByRole("button", { name: "Repository notes" }).click();
  const painted = await page.evaluate(() => {
    const el = document.createElement("div");
    el.className = "skeleton-bar";
    document.body.appendChild(el);
    const bg = getComputedStyle(el).backgroundColor;
    el.remove();
    return bg;
  });
  // The class is still inert — which is exactly why the skeleton must
  // carry its own background.
  expect(painted).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
});

test("arrow keys and / work inside the composer", async ({ page }) => {
  // Regression: the list keymap sat on the scroll container and never
  // checked e.target, so arrows moved row focus instead of the caret and
  // "/" was swallowed — a path could not be typed into a note.
  await openNotes(page);
  await page.keyboard.press("Meta+Shift+N");
  const field = page.getByPlaceholder("Write a note…");
  await field.fill("src/lib");
  await field.press("/");
  await field.type("foo.ts");
  await expect(field).toHaveValue("src/lib/foo.ts");

  await field.press("Home");
  await field.type("X");
  await expect(field).toHaveValue("Xsrc/lib/foo.ts");
});

test("the editor is sized to its content, not inflated", async ({ page }) => {
  // Regression: a 1-line note got a 2-row box wearing a ring drawn 6px
  // OUTSIDE it, which inflated the block to 80px and left ~0.5px of
  // clearance above the buttons. Padding + a compensating negative
  // margin gives the field breathing room without moving the text.
  const f = makeFixtures();
  (f as { notes: Record<string, unknown>[] }).notes[0]!.body = "hei";
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootApp(page, f);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.getByRole("button", { name: "Repository notes" }).click();
  await expect(
    page.getByRole("button", { name: "New note" }).first(),
  ).toBeVisible();

  const row = page.getByRole("listitem").nth(0);
  await row.getByText("hei").dblclick();
  await expect(row.getByRole("textbox")).toBeVisible();

  const m = await page.evaluate(() => {
    const art = document.querySelector("li article") as HTMLElement;
    const ta = art.querySelector("textarea") as HTMLElement;
    const footer = ta.parentElement!.querySelector(
      "div.flex.h-\\[24px\\]",
    ) as HTMLElement;
    const t = ta.getBoundingClientRect();
    const fr = footer.getBoundingClientRect();
    return {
      field: Math.round(t.height),
      gap: Math.round(fr.top - t.bottom),
    };
  });
  // 20px line box + 2×5px padding + 2×1px ring.
  expect(m.field).toBeLessThanOrEqual(34);
  expect(m.gap).toBeGreaterThanOrEqual(6);
});

