import { test, expect, type Page } from "@playwright/test";
import { bootApp, makeFixtures } from "./harness";

/**
 * The Workflows index (Phase 4 of the completion program): the screen that
 * lists every in-flight workflow (lane counts + derived gate) over the
 * Completed section (shipped/archived) — previously boards were reachable
 * only from a create-redirect, a sidebar node, or a breadcrumb.
 */

const INDEX_URL = "/repositories/repo-1/board";
const NOW = new Date().toISOString();

function fixturesWithCompleted() {
  const f = makeFixtures() as ReturnType<typeof makeFixtures> & {
    workspaces: Array<Record<string, unknown>>;
  };
  f.workspaces.push({
    ...(f.workspaces.find((w) => w.id === "epic-1") as Record<string, unknown>),
    id: "epic-done",
    name: "onboarding polish",
    prompt: "Polish the onboarding flow end to end",
    status: "archived",
    archivedAt: NOW,
  });
  return f;
}

async function bootToIndex(page: Page, fixtures = fixturesWithCompleted()) {
  const res = await bootApp(page, fixtures);
  await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
  await page.goto(INDEX_URL);
  await expect(
    page.getByRole("heading", { name: "Workflows", exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  return res;
}

test.describe("Workflows index", () => {
  test("lists active workflows with lane counts + the derived gate, and the completed section", async ({
    page,
  }) => {
    await bootToIndex(page);

    // Active: the worklist board fixture ("checkout") with its lane counts and
    // a STATIC gate label (the real button lives on the board).
    const row = page.getByTestId("workflow-row").first();
    await expect(row).toContainText("checkout");
    await expect(row).toContainText("in progress");
    await expect(row.getByTestId("workflow-gate")).toBeVisible();

    // Completed: the archived fixture, with its durable fact named.
    const done = page.getByTestId("workflow-completed-row").first();
    await expect(done).toContainText("onboarding polish");
    await expect(done).toContainText(/Archived/);
  });

  test("an active row opens its board; the board's breadcrumb leads back", async ({
    page,
  }) => {
    await bootToIndex(page);
    await page.getByTestId("workflow-row").first().click();
    await expect(page).toHaveURL(/\/board\/epic-w/);

    await page.getByTestId("board-breadcrumb-workflows").click();
    await expect(page).toHaveURL(/\/repositories\/repo-1\/board\/?$/);
  });

  test("the sidebar Workflows header links here", async ({ page }) => {
    const f = fixturesWithCompleted();
    await bootApp(page, f);
    await expect(page).toHaveURL(/workspaces\/ws-agent/, { timeout: 25_000 });
    await page.getByTestId("sidebar-workflows-link").first().click();
    await expect(page).toHaveURL(/\/repositories\/repo-1\/board\/?$/);
  });

  test("zero active workflows is a CTA, not a dead end", async ({ page }) => {
    const f = fixturesWithCompleted() as ReturnType<
      typeof fixturesWithCompleted
    > & { worklist: { boards: unknown[] } };
    f.worklist.boards = [];
    await bootToIndex(page, f);
    await expect(page.getByText("No active workflows")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "New workflow" }),
    ).toBeVisible();
  });
});
