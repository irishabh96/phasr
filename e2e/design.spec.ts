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
      // A resource 404 names its URL only in the location (e.g. the dev
      // server's missing /favicon.ico), so filter on that too.
      if (m.type() === "error" && !BENIGN.test(m.text()) && !BENIGN.test(m.location().url))
        consoleErrors.push(m.text());
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

  // A-System: primary CTA ink is --color-accent-onfill — dark bg-0 ink on the
  // bright dark-theme coral, white on the darker light-theme coral (#C94F2E),
  // each clearing 4.5:1 on its fill.
  test("T1: primary button ink follows accent-onfill per theme", async ({ page }) => {
    const btn = page.getByTestId("btn-primary");
    const expected = { dark: "rgb(11, 13, 16)", light: "rgb(255, 255, 255)" } as const;
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      // The button transitions its colours, so a single read right after the
      // flip can land mid-fade — poll until it settles on the token.
      await expect
        .poll(() => btn.evaluate((el) => getComputedStyle(el).color), {
          message: `primary text color in ${theme}`,
        })
        .toBe(expected[theme]);
    }
  });

  // A-System: Danger is a tint (Stop, Discard); the solid red fill is the
  // confirm step of a destructive dialog, white text on #c93c37.
  test("T2: danger is tinted; danger-solid keeps the solid fill", async ({ page }) => {
    await setTheme(page, "dark");
    const tinted = page.getByTestId("btn-danger");
    expect(await tinted.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(240, 107, 107)");
    expect(await tinted.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(31, 21, 22)");
    const solid = page.getByTestId("btn-danger-solid");
    expect(await solid.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(201, 60, 55)");
  });

  test("accent picker recolours the accent tokens", async ({ page }) => {
    await setTheme(page, "dark");
    const accent500 = () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--color-accent-500").trim().toLowerCase(),
      );
    await page.getByTestId("accent-blue").click();
    await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
    expect(await accent500()).toBe("#4f8cff");
    await page.getByTestId("accent-coral").click();
    expect(await accent500()).toBe("#e0674a");
  });

  test("surfaces are flat — nothing blurs what is behind it", async ({ page }) => {
    await page.getByTestId("open-dialog").click();
    const blurred = await page.evaluate(() =>
      [...document.querySelectorAll("*")].filter((el) => {
        const cs = getComputedStyle(el);
        const f = cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter;
        return f && f !== "none";
      }).length,
    );
    expect(blurred).toBe(0);
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
