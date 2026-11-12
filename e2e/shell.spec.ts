import { test, expect, type Page } from "@playwright/test";
import { bootApp, emit, makeFixtures } from "./harness";

/**
 * The shell after the polish pass (ui-mission-control-polish-spec §4.1,
 * §4.2, D1, D2): a text-only title bar, a count-free one-line sidebar and
 * no status bar — sync state lives in the account menu and the bell.
 */

function fixturesWithFailed() {
  const f = makeFixtures();
  f.workspaces.push({
    ...f.workspaces[0]!,
    id: "ws-failed",
    name: "broken-migration",
    status: "failed",
    exitCode: 1,
    branch: "phasr/broken-migration",
    worktreePath: "/Users/test/.phasr/worktrees/ws-failed",
  });
  return f;
}

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });

test.describe("Sidebar (§4.2)", () => {
  test("groups in order, failed under Needs you, no counts or filter chips", async ({ page }) => {
    await bootApp(page, fixturesWithFailed());
    const bar = sidebar(page);
    await expect(bar.getByRole("link").filter({ hasText: "add-feature" })).toBeVisible({ timeout: 20_000 });

    const titles = await bar.getByRole("navigation", { name: "Tasks" }).getByRole("region").evaluateAll((els) =>
      els.map((el) => el.getAttribute("aria-label")),
    );
    expect(titles).toEqual(["Needs you", "Running", "Review"]);

    const needsYou = bar.getByRole("region", { name: "Needs you", exact: true });
    await expect(needsYou.getByRole("link")).toHaveCount(1);
    await expect(needsYou.getByRole("link")).toContainText("broken-migration");

    // Rule 4: no counts, no filter chips — the header is just "Tasks".
    await expect(bar.getByRole("group", { name: "Filter tasks" })).toHaveCount(0);
    await expect(bar.getByRole("heading", { name: "Tasks", level: 2 })).toHaveText("Tasks");

    // Rule 5: one line per row, 32px.
    const row = bar.getByRole("link").filter({ hasText: "add-feature" });
    const box = await row.boundingBox();
    expect(box?.height).toBe(32);
    await expect(row).toHaveAttribute("aria-current", "page");
  });

  test("in a task the footer is the local checkout line", async ({ page }) => {
    await bootApp(page);
    const local = sidebar(page).getByRole("link", { name: /^Local checkout, main/ });
    await expect(local).toBeVisible({ timeout: 20_000 });
    await expect(local).toContainText("local · main");
    await expect(sidebar(page).getByRole("navigation", { name: "Repositories" })).toHaveCount(0);
  });

  test("on the board the footer lists repositories with a ghost Add repository", async ({ page }) => {
    const f = makeFixtures();
    (f as { landing?: string }).landing = "board";
    await bootApp(page, f);
    const repos = sidebar(page).getByRole("navigation", { name: "Repositories" });
    await expect(repos.getByRole("button", { name: "phasr", exact: true })).toBeVisible({ timeout: 20_000 });
    const add = sidebar(page).getByRole("button", { name: "Add repository" });
    await expect(add).toBeVisible();
    await expect(add).toHaveCSS("border-top-style", "none");
  });
});

test.describe("Title bar (§4.1) and the status bar's removal (D1)", () => {
  test("search is an icon button that opens the palette; no Automations", async ({ page }) => {
    await bootApp(page);
    const header = page.locator("header[data-tauri-drag-region]");
    await expect(header.getByRole("button", { name: "Search" })).toBeVisible({ timeout: 20_000 });
    await expect(header.getByRole("link", { name: "Automations" })).toHaveCount(0);
    await expect(header.getByRole("navigation", { name: "Primary" }).getByRole("link")).toHaveText(["Board"]);

    // In a task: `repo / ● task` and the branch, no boxed base chip.
    await expect(header).toContainText("add-feature");
    await expect(header).toContainText("phasr/add-feature");
    await expect(header).not.toContainText("← main");

    await header.getByRole("button", { name: "Search" }).click();
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  });

  test("no status bar; sync state is in the account menu and the bell shows an error", async ({ page }) => {
    await bootApp(page);
    const header = page.locator("header[data-tauri-drag-region]");
    await expect(header.getByRole("button", { name: "Account menu" })).toBeVisible({ timeout: 20_000 });
    // The status bar's hints and counts are gone from the page.
    await expect(page.getByText("⌘K anything")).toHaveCount(0);
    await expect(page.getByText(/\d+ agents? · \d+ worktrees?/)).toHaveCount(0);

    const bell = header.getByRole("button", { name: /^Notifications/ });
    await expect(bell).not.toHaveAccessibleName(/sync paused/);

    await emit(page, "cloud-sync-error", "network unreachable");
    await expect(bell).toHaveAccessibleName(/sync paused/);
    await bell.click();
    await expect(page.getByRole("status").filter({ hasText: "Sync paused: network unreachable" })).toBeVisible();
    await page.keyboard.press("Escape");

    await header.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("menu")).toContainText("Sync paused: network unreachable");
    await page.keyboard.press("Escape");

    // Recovery clears the bell.
    await emit(page, "cloud-sync-updated", null);
    await expect(bell).not.toHaveAccessibleName(/sync paused/);
    await header.getByRole("button", { name: "Account menu" }).click();
    await expect(page.getByRole("menu")).toContainText("Synced");
  });
});
