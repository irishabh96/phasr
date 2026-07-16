import { test, expect, type Page } from "@playwright/test";

/** Force the app to a known resolved theme via the harness toggle. */
async function setTheme(page: Page, want: "light" | "dark") {
  for (let i = 0; i < 3; i++) {
    const current = await page.locator("html").getAttribute("data-theme");
    if (current === want) return;
    await page.getByTestId("theme-toggle").click();
  }
  await expect(page.locator("html")).toHaveAttribute("data-theme", want);
}

test.describe("design-fix validation (/design-test)", () => {
  let consoleErrors: string[] = [];

  // Errors that are artifacts of running the frontend in a plain browser
  // (no Tauri shell) rather than design regressions — filtered out.
  const BENIGN = /invoke|__TAURI|auth callback|favicon|sourcemap|Outdated Optimize Dep/i;

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    // Stub the Tauri IPC layer so stray `invoke` calls (e.g. the root
    // AuthCallbackHandler) resolve instead of throwing + popping an error
    // toast that would overlay the UI under test.
    await page.addInitScript(() => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: () => Promise.resolve(null),
        transformCallback: (cb: unknown) => cb,
        convertFileSrc: (s: string) => s,
      };
    });
    page.on("console", (m) => {
      if (m.type() === "error" && !BENIGN.test(m.text())) consoleErrors.push(m.text());
    });
    await page.goto("/design-test");
    await expect(page.getByRole("heading", { name: "Design test harness" })).toBeVisible();
  });

  test("harness renders with no console errors", async () => {
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("theme toggle flips the resolved data-theme", async ({ page }) => {
    await setTheme(page, "light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await setTheme(page, "dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  // Batch 0 T1 — primary CTA text is the dark accent-onfill ink (#010409) in
  // BOTH themes, so it clears AA on the theme-invariant coral fill.
  test("T1: primary button uses accent-onfill (#010409) text in both themes", async ({
    page,
  }) => {
    const btn = page.getByTestId("btn-primary");
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      const color = await btn.evaluate((el) => getComputedStyle(el).color);
      expect(color, `primary text color in ${theme}`).toBe("rgb(1, 4, 9)");
    }
  });

  // Batch 0 T2 — danger fill is the darker --color-danger-solid so white text
  // clears AA. Dark theme = #c93c37 = rgb(201, 60, 55).
  test("T2: danger button fill is danger-solid in dark theme", async ({ page }) => {
    await setTheme(page, "dark");
    const bg = await page
      .getByTestId("btn-danger")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgb(201, 60, 55)");
  });

  // Batch 1 — keyboard focus shows the standardized --ring-focus ring.
  test("focus-visible ring appears on keyboard focus", async ({ page }) => {
    await page.getByTestId("theme-toggle").focus();
    await page.keyboard.press("Tab"); // → first button
    const shadow = await page.evaluate(
      () => getComputedStyle(document.activeElement as Element).boxShadow,
    );
    expect(shadow).not.toBe("none");
    expect(shadow.length).toBeGreaterThan(0);
  });

  // Batch 3 — toasts render on the glass system with an intent icon + role.
  test("success toast renders with icon and role=status", async ({ page }) => {
    await page.getByTestId("toast-success").click();
    const toast = page.getByRole("status").filter({ hasText: "Saved" });
    await expect(toast).toBeVisible();
    await expect(toast.locator("svg").first()).toBeVisible(); // leading intent icon
  });

  // Batch 3 — error toasts are assertive (role=alert) and do not auto-dismiss.
  test("error toast is role=alert and persists", async ({ page }) => {
    await page.getByTestId("toast-error").click();
    const toast = page.getByRole("alert").filter({ hasText: "Failed to push" });
    await expect(toast).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(toast).toBeVisible(); // still there — error toasts don't auto-dismiss
  });

  // Batch 4 — shared Dialog: opens, has accessible name, traps focus, Esc closes.
  test("dialog opens, traps focus, closes on Escape", async ({ page }) => {
    await page.getByTestId("open-dialog").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(/Example dialog/);
    const focusInside = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!d && d.contains(document.activeElement);
    });
    expect(focusInside).toBe(true); // initial focus is inside, not on body
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  test("confirm dialog shows a destructive Delete action", async ({ page }) => {
    await page.getByTestId("open-confirm").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Delete" })).toBeVisible();
  });

  // Batch 2 — PanelState: error is role=alert + humanized; empty has a CTA.
  test("PanelState error is role=alert; empty shows CTA", async ({ page }) => {
    const err = page.getByTestId("panel-error");
    await expect(err.getByRole("alert")).toBeVisible();
    const empty = page.getByTestId("panel-empty");
    await expect(empty.getByText("No repositories yet")).toBeVisible();
    await expect(empty.getByRole("button", { name: "Add repository" })).toBeVisible();
  });

  // Batch 0 T5 — diff renders; body must never scroll the page horizontally.
  test("diff list renders sample files", async ({ page }) => {
    const diff = page.getByTestId("diff");
    await expect(diff).toBeVisible();
    await expect(diff.getByText(/\.(ts|tsx|rs|css|md|json)/).first()).toBeVisible();
  });

  test("page body has no horizontal overflow", async ({ page }) => {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
